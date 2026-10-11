import type { Prisma } from '@prisma/client';
import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload, AgentContext } from '../types/index.js';
import { cvClassificationAgent, CV_CLASSIFICATION_AGENT_NAME } from '../agents/CVClassificationAgent.js';
import { validateCVClassificationRequest, validatePdfClassificationRequest } from '../utils/validators.js';
import { extractPdfText } from '../utils/pdfText.js';
import { MAX_FILE_CONTENT_LENGTH, MIN_FILE_CONTENT_LENGTH, toSafeRunErrorMessage } from './cvBatchService.js';
import logger from '../config/logging.js';

// The original recommendation is returned unchanged; the document's name and
// the append-only decision history (newest first) are included alongside it.
const RESULT_INCLUDE = {
  cvDocument: { select: { fileName: true, batchId: true } },
  decisions: { orderBy: { timestamp: 'desc' as const } },
};

export interface UploadCvDocumentParams {
  cvContent: string;
  fileName?: string;
  batchId?: string;
}

function toAgentContext(user: UserPayload): AgentContext {
  return { userId: user.id, userEmail: user.email, userRole: user.role };
}

export class CvClassificationService {
  /**
   * Uploading/submitting a CV. Stores the document only - does not run
   * classification. The caller always owns the document they upload;
   * there is no path for a client to set a different owner.
   */
  static async uploadDocument(user: UserPayload, params: UploadCvDocumentParams) {
    validateCVClassificationRequest(params);

    return prisma.cvDocument.create({
      data: {
        userId: user.id,
        content: params.cvContent,
        fileName: params.fileName,
        batchId: params.batchId,
      },
    });
  }

  /**
   * Running classification on an already-uploaded document. The
   * resulting recommendation is owned by the document's owner (not
   * necessarily the caller - an admin may trigger classification on
   * behalf of a user, but the data stays attributed to that user).
   */
  static async classifyDocument(user: UserPayload, documentId: number) {
    const document = await prisma.cvDocument.findUnique({ where: { id: documentId } });
    if (!document) {
      throw Errors.notFound('CV document');
    }
    if (user.role !== 'admin' && document.userId !== user.id) {
      throw Errors.forbidden('You can only classify your own CV documents');
    }

    return this.runClassification(user, document);
  }

  /**
   * Convenience: upload and classify in one call. Internally just chains
   * the two operations above - the document is still persisted
   * independently and classifiable again later via classifyDocument.
   */
  static async classifyContent(user: UserPayload, params: UploadCvDocumentParams) {
    const document = await this.uploadDocument(user, params);
    return this.runClassification(user, document);
  }

  /**
   * The same, for one PDF CV: its text is extracted (PdfExtractionError for
   * an unusable PDF, before anything is stored) and then classified exactly
   * like a .txt CV's content.
   */
  static async classifyPdf(user: UserPayload, params: unknown) {
    const { pdfBase64, fileName } = validatePdfClassificationRequest(params);
    const cvContent = await extractPdfText(pdfBase64, { minChars: MIN_FILE_CONTENT_LENGTH, maxChars: MAX_FILE_CONTENT_LENGTH });
    return this.classifyContent(user, { cvContent, fileName });
  }

  private static async runClassification(
    user: UserPayload,
    document: { id: number; userId: number; content: string }
  ) {
    const agent = await prisma.agent.findUnique({ where: { name: CV_CLASSIFICATION_AGENT_NAME } });
    if (!agent) {
      throw Errors.internal(
        `${CV_CLASSIFICATION_AGENT_NAME} is not registered - run the seed script before classifying.`
      );
    }

    const run = await prisma.agentRun.create({
      data: {
        userId: document.userId,
        agentId: agent.id,
        agentName: agent.name,
        cvDocumentId: document.id,
        status: 'RUNNING',
      },
    });

    const context = toAgentContext(user);

    try {
      const result = await cvClassificationAgent.execute(document.content, context, run.id);

      const recommendation = await prisma.cvRecommendation.create({
        data: {
          cvDocumentId: document.id,
          runId: run.id,
          userId: document.userId,
          agentId: agent.id,
          primaryCategory: result.primaryCategory,
          secondaryCategories: result.secondaryCategories,
          confidenceScore: result.confidence[result.primaryCategory],
          confidenceScores: result.confidence as unknown as Prisma.InputJsonValue,
          rationale: result.rationale as unknown as Prisma.InputJsonValue,
          feedback: result.feedback,
          rawResponse: result.rawResponse as Prisma.InputJsonValue,
        },
      });

      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'SUCCESS', completedAt: new Date() },
      });

      return recommendation;
    } catch (error) {
      await prisma.agentRun
        .update({
          where: { id: run.id },
          data: { status: 'ERROR', completedAt: new Date(), errorMessage: toSafeRunErrorMessage(error) },
        })
        .catch(updateError => {
          logger.error('Failed to mark agent run as ERROR', {
            runId: run.id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });

      throw error;
    }
  }

  /**
   * Permanently deletes one CV document: its stored text, its
   * recommendations and every decision on them. Its agent runs are kept
   * (unlinked from the document, as the schema's SET NULL does) together
   * with their usage logs, which hold no CV content - so token, cost and
   * run history stay exact. Admin only (the route also requires an admin);
   * regular users cannot delete anything, not even their own CVs.
   */
  static async deleteDocument(user: UserPayload, documentId: number) {
    if (user.role !== 'admin') {
      throw Errors.forbidden('Only an admin can delete CV documents');
    }
    const document = await prisma.cvDocument.findUnique({ where: { id: documentId }, select: { id: true, userId: true } });
    if (!document) {
      throw Errors.notFound('CV document');
    }
    // A queued or running file would otherwise fail (or race) mid-processing.
    const inProgress = await prisma.agentRun.count({ where: { cvDocumentId: documentId, status: { in: ['PENDING', 'RUNNING'] } } });
    if (inProgress > 0) {
      throw Errors.conflict('This CV is still being processed. Try again when processing has finished.');
    }

    const result = await prisma.$transaction(async tx => {
      const decisions = await tx.recommendationDecision.deleteMany({
        where: { OR: [{ cvDocumentId: documentId }, { recommendation: { cvDocumentId: documentId } }] },
      });
      const recommendations = await tx.cvRecommendation.deleteMany({ where: { cvDocumentId: documentId } });
      const runs = await tx.agentRun.updateMany({ where: { cvDocumentId: documentId }, data: { cvDocumentId: null } });
      await tx.cvDocument.delete({ where: { id: documentId } });
      return { documentId, deletedRecommendations: recommendations.count, deletedDecisions: decisions.count, keptAgentRuns: runs.count };
    });

    // Ids and counts only - never the file name or content.
    logger.info('CV document permanently deleted', { ...result, deletedBy: user.id, ownerId: document.userId });
    return result;
  }

  /** Retrieving the result: a single recommendation, ownership-enforced. */
  static async getRecommendation(user: UserPayload, id: number) {
    const recommendation = await prisma.cvRecommendation.findUnique({ where: { id }, include: RESULT_INCLUDE });
    if (!recommendation) {
      throw Errors.notFound('Recommendation');
    }
    if (user.role !== 'admin' && recommendation.userId !== user.id) {
      throw Errors.forbidden('You can only view your own recommendations');
    }
    return recommendation;
  }

  /** Retrieving results: list - own for a regular user, all for an admin. */
  static async listRecommendations(user: UserPayload) {
    const where = user.role === 'admin' ? {} : { userId: user.id };
    return prisma.cvRecommendation.findMany({ where, include: RESULT_INCLUDE, orderBy: { createdAt: 'desc' } });
  }
}
