import prisma from '../db/client.js';
import type { Prisma } from '@prisma/client';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload, AgentContext } from '../types/index.js';
import { sentimentAgent, SENTIMENT_AGENT_NAME, SentimentValidationError } from '../agents/SentimentAgent.js';
import { LLMServiceError, providerFailureMessage } from './llmService.js';
import { validateSentimentRequest } from '../utils/validators.js';
import logger from '../config/logging.js';

// Owner email lets an admin (who sees every result) tell whose feedback each one is.
const RESULT_INCLUDE = { user: { select: { email: true } } };

function toSafeSentimentRunError(error: unknown): string {
  if (error instanceof SentimentValidationError) {
    return 'The AI response did not pass validation, even after one automatic retry.';
  }
  if (error instanceof LLMServiceError) {
    return providerFailureMessage(error).slice(0, 300);
  }
  return 'Processing failed due to an internal error.';
}

function toAgentContext(user: UserPayload): AgentContext {
  return { userId: user.id, userEmail: user.email, userRole: user.role };
}

export class SentimentService {
  /**
   * Runs sentiment analysis on feedback text. Every run: requires an
   * authenticated user (enforced by the caller via auth middleware before
   * this is ever invoked), is associated with that user, creates an
   * AgentRun, and persists a SentimentResult (success) or re-throws after
   * marking the run ERROR (failure) - the usage log itself is written by
   * LLMService/UsageLogService for every attempt, success or failure.
   */
  static async analyze(user: UserPayload, text: string) {
    validateSentimentRequest({ text });

    const agent = await prisma.agent.findUnique({ where: { name: SENTIMENT_AGENT_NAME } });
    if (!agent) {
      throw Errors.internal(
        `${SENTIMENT_AGENT_NAME} is not registered - run the seed script before analyzing sentiment.`
      );
    }

    const run = await prisma.agentRun.create({
      data: {
        userId: user.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'RUNNING',
      },
    });

    const context = toAgentContext(user);

    try {
      const result = await sentimentAgent.execute(text, context, run.id);

      const sentimentResult = await prisma.sentimentResult.create({
        data: {
          runId: run.id,
          userId: user.id,
          agentId: agent.id,
          inputText: text,
          sentiment: result.sentiment.toUpperCase() as 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE',
          confidence: result.confidence,
          rationale: result.rationale,
          rawResponse: result.rawResponse as Prisma.InputJsonValue,
        },
      });

      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'SUCCESS', completedAt: new Date() },
      });

      return sentimentResult;
    } catch (error) {
      await prisma.agentRun
        .update({
          where: { id: run.id },
          data: { status: 'ERROR', completedAt: new Date(), errorMessage: toSafeSentimentRunError(error) },
        })
        .catch((updateError: unknown) => {
          logger.error('Failed to mark agent run as ERROR', {
            runId: run.id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });

      throw error;
    }
  }

  /** Retrieving a single result - own for a regular user, any for an admin. */
  static async getResult(user: UserPayload, id: number) {
    const result = await prisma.sentimentResult.findUnique({ where: { id }, include: RESULT_INCLUDE });
    if (!result) {
      throw Errors.notFound('Sentiment result');
    }
    if (user.role !== 'admin' && result.userId !== user.id) {
      throw Errors.forbidden('You can only view your own sentiment results');
    }
    return result;
  }

  /** Listing results - own for a regular user, all for an admin. */
  static async listResults(user: UserPayload) {
    const where = user.role === 'admin' ? {} : { userId: user.id };
    return prisma.sentimentResult.findMany({ where, include: RESULT_INCLUDE, orderBy: { createdAt: 'desc' } });
  }
}
