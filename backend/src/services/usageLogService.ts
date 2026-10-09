import prisma from '../db/client.js';
import { TokenUsage } from '../utils/costCalculator.js';
import { calculateCost } from '../utils/costCalculator.js';
import logger from '../config/logging.js';

export interface LogLLMCallParams {
  timestamp: Date;
  runId?: string; // the AgentRun this call belongs to, if one exists yet
  userId: number;
  agentName: string;
  model: string;
  usage: TokenUsage; // ACTUAL token counts from API
  latencyMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  /** The provider's id for the response these counts came from (success only). */
  providerResponseId?: string;
}

/** Stable log event name for a usage row that could not be written - alert/grep on this. */
export const USAGE_LOG_WRITE_FAILED_EVENT = 'USAGE_LOG_WRITE_FAILED';

export type UsageLogWriteResult =
  | { persisted: true; logId: number }
  | { persisted: false; reason: 'AGENT_NOT_REGISTERED' | 'DB_WRITE_FAILED' };

export class UsageLogService {
  /**
   * Log an LLM call with actual token counts from API
   * This is called after every LLM invocation to track usage
   *
   * Never throws: by the time this runs the provider call has already
   * happened (and, on success, been billed). Throwing would discard a paid
   * result and invite a resubmission, i.e. a duplicate charge. A row that
   * could not be written is instead reported explicitly - the returned
   * `persisted: false` and a USAGE_LOG_WRITE_FAILED error event - and is
   * never reported as logged. See docs/USAGE_LOGGING.md.
   */
  static async logCall(params: LogLLMCallParams): Promise<UsageLogWriteResult> {
    try {
      // Get agent ID (should exist from seeding)
      const agent = await prisma.agent.findUnique({
        where: { name: params.agentName },
      });

      if (!agent) {
        logUsageWriteFailure(params, 'AGENT_NOT_REGISTERED', {
          message: `agent "${params.agentName}" is not registered (run npm run db:seed)`,
        });
        return { persisted: false, reason: 'AGENT_NOT_REGISTERED' };
      }

      // Calculate cost based on ACTUAL token counts from API
      const estimatedCost = calculateCost(params.usage, params.model);

      // Insert log record. isSeedData is intentionally never set here -
      // it defaults to false in the schema and must stay false for every
      // row written by real LLM calls; only the seed script sets it true.
      const row = await prisma.llmUsageLog.create({
        data: {
          timestamp: params.timestamp,
          runId: params.runId,
          userId: params.userId,
          agentId: agent.id,
          agentName: params.agentName,
          model: params.model,
          inputTokens: params.usage.input_tokens,
          outputTokens: params.usage.output_tokens,
          latencyMs: params.latencyMs,
          status: params.status === 'success' ? 'SUCCESS' : 'ERROR',
          errorCode: params.errorCode,
          errorMessage: params.errorMessage,
          providerResponseId: params.providerResponseId,
          estimatedCost,
        },
      });

      logger.info('LLM call logged', {
        userId: params.userId,
        agent: params.agentName,
        inputTokens: params.usage.input_tokens,
        outputTokens: params.usage.output_tokens,
        cost: estimatedCost === null ? 'unknown (no pricing)' : estimatedCost.toFixed(4),
        latency: `${params.latencyMs}ms`,
      });
      return { persisted: true, logId: row.id };
    } catch (error) {
      logUsageWriteFailure(params, 'DB_WRITE_FAILED', describeWriteError(error));
      return { persisted: false, reason: 'DB_WRITE_FAILED' };
    }
  }

  /**
   * Get usage statistics for a user
   */
  static async getUserStats(userId: number, agentName?: string) {
    const where = { userId };
    const whereWithAgent = agentName
      ? {
          ...where,
          agent: { name: agentName },
        }
      : where;

    const logs = await prisma.llmUsageLog.findMany({
      where: whereWithAgent,
      include: { agent: true },
    });

    const totalInputTokens = logs.reduce((sum: number, log) => sum + log.inputTokens, 0);
    const totalOutputTokens = logs.reduce((sum: number, log) => sum + log.outputTokens, 0);
    const totalCost = logs.reduce((sum: number, log) => sum + (log.estimatedCost || 0), 0);
    const errorCount = logs.filter(log => log.status === 'ERROR').length;
    const averageLatency =
      logs.length > 0 ? logs.reduce((sum: number, log) => sum + log.latencyMs, 0) / logs.length : 0;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      callCount: logs.length,
      errorCount,
      errorRate: logs.length > 0 ? errorCount / logs.length : 0,
      averageLatency,
      logs,
    };
  }

  /**
   * Get all usage for a period
   */
  static async getUsageForPeriod(
    startDate: Date,
    endDate: Date,
    userId?: number,
    agentId?: number
  ) {
    const where: Record<string, unknown> = {
      timestamp: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (userId) where.userId = userId;
    if (agentId) where.agentId = agentId;

    return prisma.llmUsageLog.findMany({
      where,
      include: { user: true, agent: true },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Get aggregate statistics
   */
  static async getAggregateStats(startDate: Date, endDate: Date) {
    const logs = await prisma.llmUsageLog.findMany({
      where: {
        timestamp: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: { agent: true },
    });

    const totalInputTokens = logs.reduce((sum: number, log) => sum + log.inputTokens, 0);
    const totalOutputTokens = logs.reduce((sum: number, log) => sum + log.outputTokens, 0);
    const totalCost = logs.reduce((sum: number, log) => sum + (log.estimatedCost || 0), 0);
    const errorCount = logs.filter(log => log.status === 'ERROR').length;
    const averageLatency =
      logs.length > 0 ? logs.reduce((sum: number, log) => sum + log.latencyMs, 0) / logs.length : 0;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      callCount: logs.length,
      errorCount,
      errorRate: logs.length > 0 ? errorCount / logs.length : 0,
      averageLatency,
    };
  }
}

/**
 * One structured error event per unwritten row. Carries only what an
 * operator needs to reconcile the call by hand - ids, model, the provider's
 * own token counts, latency - never prompts, CV text, provider error text or
 * the Prisma argument dump.
 */
function logUsageWriteFailure(
  params: LogLLMCallParams,
  reason: 'AGENT_NOT_REGISTERED' | 'DB_WRITE_FAILED',
  cause: { code?: string; message: string }
): void {
  logger.error('LLM usage NOT logged - analytics will undercount this call', {
    event: USAGE_LOG_WRITE_FAILED_EVENT,
    reason,
    dbErrorCode: cause.code,
    dbError: cause.message,
    callStatus: params.status,
    runId: params.runId,
    userId: params.userId,
    agent: params.agentName,
    model: params.model,
    inputTokens: params.usage.input_tokens,
    outputTokens: params.usage.output_tokens,
    latencyMs: params.latencyMs,
    providerResponseId: params.providerResponseId,
    callTimestamp: params.timestamp.toISOString(),
  });
}

// Prisma's invocation errors echo the whole `data` argument before the
// actual cause; keep only the final line (the cause), bounded.
function describeWriteError(error: unknown): { code?: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const raw = error instanceof Error ? error.message : String(error);
  const cause = raw.split('\n').map(line => line.trim()).filter(Boolean).pop() ?? 'Unknown database error';
  return { code: typeof code === 'string' ? code : undefined, message: cause.slice(0, 300) };
}
