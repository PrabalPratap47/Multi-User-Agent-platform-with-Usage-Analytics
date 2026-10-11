import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { parseDbId } from '../utils/ids.js';
import { ApiResponse } from '../types/index.js';
import { CvClassificationService } from '../services/cvClassificationService.js';
import { CvClassificationValidationError } from '../agents/CVClassificationAgent.js';
import { CvDecisionService } from '../services/cvDecisionService.js';
import { CvBatchService, toSafeRunErrorMessage } from '../services/cvBatchService.js';
import { LLMServiceError } from '../services/llmService.js';
import { validateBatchUpload } from '../utils/validators.js';
import { PdfExtractionError } from '../utils/pdfText.js';

export class CVController {
  /**
   * POST /api/cv/documents
   * Uploading/submitting a CV. Stores the document only.
   */
  static uploadDocument = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const document = await CvClassificationService.uploadDocument(req.user, req.body);

    res.status(201).json({
      success: true,
      data: document,
    } as ApiResponse);
  });

  /**
   * POST /api/cv/documents/:documentId/classify
   * Running classification on a previously uploaded CV document.
   */
  static classifyDocument = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const documentId = parseDbId(req.params.documentId, 'documentId');

    try {
      const recommendation = await CvClassificationService.classifyDocument(req.user, documentId);
      res.status(201).json({
        success: true,
        data: recommendation,
      } as ApiResponse);
    } catch (error) {
      throw toSafeClassificationError(error);
    }
  });

  /**
   * DELETE /api/cv/documents/:documentId
   * Permanently deletes one CV and its classification/decision data
   * (admin only). Agent runs and usage logs are kept.
   */
  static deleteDocument = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const documentId = parseDbId(req.params.documentId, 'documentId');
    const result = await CvClassificationService.deleteDocument(req.user, documentId);

    res.json({
      success: true,
      data: result,
    } as ApiResponse);
  });

  /**
   * POST /api/cv/classify
   * Convenience: upload and classify in a single call. Takes a .txt CV's
   * text (cvContent) or one base64-encoded PDF (pdfBase64).
   */
  static classify = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    try {
      const recommendation =
        req.body?.pdfBase64 !== undefined
          ? await CvClassificationService.classifyPdf(req.user, req.body)
          : await CvClassificationService.classifyContent(req.user, req.body);
      res.status(201).json({
        success: true,
        data: recommendation,
      } as ApiResponse);
    } catch (error) {
      throw toSafeClassificationError(error);
    }
  });

  /**
   * GET /api/cv/results
   * Retrieving results: list - own for a regular user, all for an admin.
   */
  static getResults = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const results = await CvClassificationService.listRecommendations(req.user);
    res.json({
      success: true,
      data: results,
    } as ApiResponse);
  });

  /**
   * GET /api/cv/results/:id
   * Retrieving the result: a single recommendation, ownership-enforced.
   */
  static getResult = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const id = parseDbId(req.params.id, 'result id');
    const result = await CvClassificationService.getRecommendation(req.user, id);

    res.json({
      success: true,
      data: result,
    } as ApiResponse);
  });

  /**
   * POST /api/cv/batch
   * Upload and process multiple CVs. Returns immediately once each
   * file's CvDocument/AgentRun rows are created - processing continues
   * in the background; poll batchStatus for progress.
   */
  static batch = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const { files } = validateBatchUpload(req.body);
    const result = await CvBatchService.submitBatch(req.user, files);

    res.status(202).json({
      success: true,
      data: result,
    } as ApiResponse);
  });

  /**
   * GET /api/cv/batch/:batchId/status
   * Live progress, read from the actual AgentRun rows for this batch.
   */
  static batchStatus = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const status = await CvBatchService.getStatus(req.user, req.params.batchId);
    res.json({
      success: true,
      data: status,
    } as ApiResponse);
  });

  /**
   * POST /api/cv/results/:id/decision
   * ACCEPT / MODIFY / REJECT a classification result. Identity for the
   * decision comes from req.user (the authenticated caller) only.
   */
  static makeDecision = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const recommendationId = parseDbId(req.params.id, 'result id');
    const decision = await CvDecisionService.makeDecision(req.user, recommendationId, req.body);

    res.status(201).json({
      success: true,
      data: decision,
    } as ApiResponse);
  });

  /**
   * GET /api/cv/results/:id/decisions
   * All decisions made on one result, ownership-enforced.
   */
  static getDecisions = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const recommendationId = parseDbId(req.params.id, 'result id');
    const decisions = await CvDecisionService.listForRecommendation(req.user, recommendationId);

    res.json({
      success: true,
      data: decisions,
    } as ApiResponse);
  });
}

/**
 * Converts an agent-level validation failure into the "safe error" the
 * API contract requires - no raw model output is exposed to the client,
 * full detail (issues, raw response) has already been logged server-side
 * by CVClassificationAgent. Any other error is passed through unchanged
 * for the global error handler to deal with.
 */
function toSafeClassificationError(error: unknown): unknown {
  if (error instanceof PdfExtractionError) {
    // An unusable uploaded PDF is a client error; the message is user-safe.
    return Errors.badRequest(error.message);
  }
  if (error instanceof CvClassificationValidationError) {
    return Errors.badGateway(
      'CV classification could not be completed: the model response did not pass validation. Please try again.'
    );
  }
  if (error instanceof LLMServiceError) {
    // Provider failures (missing key, 401, rate limit, outage) are upstream
    // problems, not a client error; the message is already key-redacted.
    return Errors.badGateway(toSafeRunErrorMessage(error));
  }
  return error;
}
