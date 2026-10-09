import { randomUUID } from 'node:crypto';
import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload, AgentContext } from '../types/index.js';
import {
  cvClassificationAgent,
  CV_CLASSIFICATION_AGENT_NAME,
  CvClassificationValidationError,
} from '../agents/CVClassificationAgent.js';
import { LLMServiceError, providerFailureMessage } from './llmService.js';
import { looksLikeBinaryText } from '../utils/validators.js';
import logger from '../config/logging.js';
import type { Prisma } from '@prisma/client';

/**
 * Batch CV processing.
 *
 * Each file gets its OWN CvDocument + AgentRun, created synchronously
 * before this method returns, so the status endpoint has real rows to
 * query immediately (as PENDING) - "do not fake progress" means the
 * progress a client polls for must be read from these same rows as they
 * are updated by real processing, never computed/estimated separately.
 *
 * Processing itself happens after the response is returned
 * (fire-and-forget from submitBatch's perspective), with every file
 * handled independently: one file's failure (bad file type, oversized
 * content, a classification error) can never prevent the others from
 * completing, and is recorded on that file's own AgentRun/CvDocument, not
 * surfaced as a batch-wide failure.
 *
 * At most MAX_CONCURRENT_BATCH_FILES files of a batch are processed at a
 * time, in submission order; the rest stay PENDING ("queued") until a slot
 * frees up.
 */

/**
 * Files of ONE batch processed at the same time. A file makes its AI calls
 * one after another (the classification, then at most one repair retry), so
 * this is also the most provider calls a batch has in flight. The cap is per
 * batch: batches from different users (or the same user) each get their own
 * slots, so one batch never waits behind another.
 */
export const MAX_CONCURRENT_BATCH_FILES = 3;

// Only plain text is supported - see the note on BatchCvFileSchema in
// validators.ts for why (no multipart/binary-parsing dependency is
// installed or verifiable in this environment).
export const ALLOWED_CV_FILE_MIME_TYPES = ['text/plain'];
export const MIN_FILE_CONTENT_LENGTH = 10;
export const MAX_FILE_CONTENT_LENGTH = 50000;

export interface BatchFileInput {
  fileName: string;
  mimeType: string;
  content: string;
}

export interface BatchSubmitResult {
  batchId: string;
  totalCount: number;
  createdAt: Date;
}

export type BatchItemState = 'queued' | 'processing' | 'completed' | 'failed';

export interface BatchItemStatus {
  runId: string;
  documentId: number | null;
  fileName: string | null;
  state: BatchItemState;
  recommendationId: number | null;
  error: string | null;
}

export interface BatchStatus {
  batchId: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  percentage: number;
  items: BatchItemStatus[];
}

const RUN_STATE: Record<string, BatchItemState> = {
  PENDING: 'queued',
  RUNNING: 'processing',
  SUCCESS: 'completed',
  ERROR: 'failed',
};

/** A file rejected by this service's own checks; its message is safe to show users. */
class BatchFileRejectedError extends Error {}

const MAX_STORED_ERROR_LENGTH = 300;

/**
 * The failure reason stored on the run and shown to the user. Never raw
 * model output: provider messages are already key-redacted by LLMService,
 * and anything unexpected collapses to a generic message.
 */
export function toSafeRunErrorMessage(error: unknown): string {
  let message: string;
  if (error instanceof BatchFileRejectedError) {
    message = error.message;
  } else if (error instanceof CvClassificationValidationError) {
    message = 'The AI response did not pass validation, even after one automatic retry.';
  } else if (error instanceof LLMServiceError) {
    message = providerFailureMessage(error);
  } else {
    message = 'Processing failed due to an internal error.';
  }
  return message.slice(0, MAX_STORED_ERROR_LENGTH);
}

/**
 * Runs `worker` over `items` with at most `limit` in progress, starting
 * items in array order. Every item is handed to a worker exactly once; a
 * worker that throws is logged and its lane moves on, so a failure can never
 * strand the items queued behind it.
 */
export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (error) {
        logger.error('Batch worker failed unexpectedly - continuing with the next file', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  // A non-finite or < 1 limit still processes everything, one at a time.
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  await Promise.all(Array.from({ length: Math.min(cap, Math.max(items.length, 1)) }, lane));
}


export class CvBatchService {
  static async submitBatch(user: UserPayload, files: BatchFileInput[]): Promise<BatchSubmitResult> {
    const agent = await prisma.agent.findUnique({ where: { name: CV_CLASSIFICATION_AGENT_NAME } });
    if (!agent) {
      throw Errors.internal(
        `${CV_CLASSIFICATION_AGENT_NAME} is not registered - run the seed script before batch processing.`
      );
    }

    const batchId = randomUUID();
    const createdAt = new Date();

    const entries = [];
    for (const file of files) {
      const document = await prisma.cvDocument.create({
        data: { userId: user.id, batchId, fileName: file.fileName, content: file.content },
      });
      const run = await prisma.agentRun.create({
        data: {
          userId: user.id,
          agentId: agent.id,
          agentName: agent.name,
          batchId,
          cvDocumentId: document.id,
          status: 'PENDING',
        },
      });
      entries.push({ document, file, runId: run.id });
    }

    const context: AgentContext = { userId: user.id, userEmail: user.email, userRole: user.role };

    // Fire-and-forget: NOT awaited, so the HTTP response returns as soon
    // as the rows above are created. Every entry's errors are caught
    // inside processEntry itself (and again by the pool), so this can never
    // produce an unhandled rejection regardless of how many files fail.
    void runWithConcurrencyLimit(entries, MAX_CONCURRENT_BATCH_FILES, entry =>
      this.processEntry(context, agent.id, entry.document, entry.file, entry.runId)
    );

    return { batchId, totalCount: files.length, createdAt };
  }

  private static async processEntry(
    context: AgentContext,
    agentId: number,
    document: { id: number; content: string },
    file: BatchFileInput,
    runId: string
  ): Promise<void> {
    try {
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });

      if (!ALLOWED_CV_FILE_MIME_TYPES.includes(file.mimeType)) {
        throw new BatchFileRejectedError(
          `Unsupported file type "${file.mimeType}" - only ${ALLOWED_CV_FILE_MIME_TYPES.join(', ')} is supported`
        );
      }
      if (file.content.trim().length < MIN_FILE_CONTENT_LENGTH) {
        throw new BatchFileRejectedError('File content is too short to be a CV');
      }
      if (file.content.length > MAX_FILE_CONTENT_LENGTH) {
        throw new BatchFileRejectedError(`File content exceeds the ${MAX_FILE_CONTENT_LENGTH} character limit`);
      }
      // A renamed .pdf/.docx sent as "text/plain" is still binary.
      if (looksLikeBinaryText(file.content)) {
        throw new BatchFileRejectedError('File content does not appear to be valid decoded text');
      }

      const result = await cvClassificationAgent.execute(document.content, context, runId);

      await prisma.cvRecommendation.create({
        data: {
          cvDocumentId: document.id,
          runId,
          userId: context.userId,
          agentId,
          primaryCategory: result.primaryCategory,
          secondaryCategories: result.secondaryCategories,
          confidenceScore: result.confidence[result.primaryCategory],
          confidenceScores: result.confidence as unknown as Prisma.InputJsonValue,
          rationale: result.rationale as unknown as Prisma.InputJsonValue,
          rawResponse: result.rawResponse as Prisma.InputJsonValue,
        },
      });

      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: 'SUCCESS', completedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Batch CV processing failed for one file - other files are unaffected', {
        runId,
        fileName: file.fileName,
        userId: context.userId,
        error: message,
      });

      await prisma.agentRun
        .update({
          where: { id: runId },
          data: { status: 'ERROR', completedAt: new Date(), errorMessage: toSafeRunErrorMessage(error) },
        })
        .catch(updateError => {
          logger.error('Failed to mark batch agent run as ERROR', {
            runId,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
    }
  }

  /** Progress for one batch, read live from the AgentRun rows it created - never estimated. */
  static async getStatus(user: UserPayload, batchId: string): Promise<BatchStatus> {
    const runs = await prisma.agentRun.findMany({
      where: { batchId },
      include: {
        cvDocument: { select: { id: true, fileName: true } },
        cvRecommendation: { select: { id: true } },
      },
      orderBy: [{ cvDocumentId: 'asc' }, { createdAt: 'asc' }],
    });

    if (runs.length === 0) {
      throw Errors.notFound('Batch');
    }
    if (user.role !== 'admin' && runs[0].userId !== user.id) {
      throw Errors.forbidden('You can only view your own batches');
    }

    const total = runs.length;
    const queued = runs.filter(r => r.status === 'PENDING').length;
    const processing = runs.filter(r => r.status === 'RUNNING').length;
    const completed = runs.filter(r => r.status === 'SUCCESS').length;
    const failed = runs.filter(r => r.status === 'ERROR').length;
    const percentage = Math.round(((completed + failed) / total) * 100);

    const items: BatchItemStatus[] = runs.map(run => ({
      runId: run.id,
      documentId: run.cvDocument?.id ?? null,
      fileName: run.cvDocument?.fileName ?? null,
      state: RUN_STATE[run.status],
      recommendationId: run.cvRecommendation?.id ?? null,
      error: run.status === 'ERROR' ? (run.errorMessage ?? 'Processing failed.') : null,
    }));

    return { batchId, total, queued, processing, completed, failed, percentage, items };
  }
}
