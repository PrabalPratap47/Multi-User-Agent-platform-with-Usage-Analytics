import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { parseDbId } from '../utils/ids.js';
import { ApiResponse } from '../types/index.js';
import { SentimentService } from '../services/sentimentService.js';
import { SentimentValidationError } from '../agents/SentimentAgent.js';
import { LLMServiceError, providerFailureMessage } from '../services/llmService.js';

/**
 * Converts an agent-level validation failure into the "safe error" the
 * API contract requires - no raw model output is exposed to the client.
 * Mirrors cvController's toSafeClassificationError exactly.
 */
function toSafeSentimentError(error: unknown): unknown {
  if (error instanceof SentimentValidationError) {
    return Errors.badGateway(
      'Sentiment analysis could not be completed: the model response did not pass validation. Please try again.'
    );
  }
  if (error instanceof LLMServiceError) {
    // Upstream failure (missing key, 401, rate limit, outage), not a client error.
    return Errors.badGateway(providerFailureMessage(error));
  }
  return error;
}

export class SentimentController {
  /**
   * POST /api/sentiment/analyze
   * Requires authentication (enforced by route middleware); the run is
   * associated with req.user, never a client-supplied id.
   */
  static analyze = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    try {
      const result = await SentimentService.analyze(req.user, req.body?.text);
      res.status(201).json({
        success: true,
        data: result,
      } as ApiResponse);
    } catch (error) {
      throw toSafeSentimentError(error);
    }
  });

  /**
   * GET /api/sentiment/results
   * Own results for a regular user, all results for an admin.
   */
  static getResults = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const results = await SentimentService.listResults(req.user);
    res.json({
      success: true,
      data: results,
    } as ApiResponse);
  });

  /**
   * GET /api/sentiment/results/:id
   * A single result, ownership-enforced (self or admin).
   */
  static getResult = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const id = parseDbId(req.params.id, 'result id');
    const result = await SentimentService.getResult(req.user, id);

    res.json({
      success: true,
      data: result,
    } as ApiResponse);
  });
}
