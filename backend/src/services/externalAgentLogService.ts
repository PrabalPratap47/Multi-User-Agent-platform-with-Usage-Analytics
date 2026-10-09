import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload } from '../types/index.js';
import { validateImportLog } from '../utils/validators.js';
import { parseExternalLogFile } from '../externalLogs/format.js';
import type { Prisma } from '@prisma/client';

/**
 * Imported logs from another (external) agent - displayed in their own
 * dashboard tab, stored in entirely separate tables
 * (external_agent_logs / external_agent_log_records) from this
 * platform's own usage data (llm_usage_logs / agent_runs). Nothing in
 * this file, or anywhere else, unions or joins the two - see
 * AnalyticsService, which queries llm_usage_logs exclusively and has no
 * reference to these tables at all. That is what "must not contaminate
 * the primary internal metrics" means at the code level: there is no
 * code path through which an imported record could ever be counted by
 * the internal analytics service.
 */
export class ExternalAgentLogService {
  /**
   * Parses and validates every record in the uploaded file
   * independently - a malformed record is reported and skipped, never
   * blocking the valid records in the same file from being imported
   * (same "one failure doesn't block the rest" principle as batch CV
   * processing).
   */
  static async importLog(user: UserPayload, body: unknown) {
    const request = validateImportLog(body);
    const parsed = parseExternalLogFile(request.content, request.format);

    const importRecord = await prisma.externalAgentLog.create({
      data: {
        userId: user.id,
        sourceAgentName: request.sourceAgentName,
        fileName: request.fileName,
        fileFormat: request.format,
        totalRecords: parsed.totalRecords,
        validRecords: parsed.normalized.length,
        invalidRecords: parsed.errors.length,
        parseErrors: parsed.errors as unknown as Prisma.InputJsonValue,
        notes: request.notes,
      },
    });

    if (parsed.normalized.length > 0) {
      await prisma.externalAgentLogRecord.createMany({
        data: parsed.normalized.map(record => ({
          importId: importRecord.id,
          rawRecord: record.rawRecord as Prisma.InputJsonValue,
          timestamp: record.timestamp,
          externalUserId: record.externalUserId,
          agentName: record.agentName,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          latencyMs: record.latencyMs,
          rawStatus: record.rawStatus,
          isError: record.isError,
          estimatedCost: record.estimatedCost,
        })),
      });
    }

    return importRecord;
  }

  /** Own imports for a regular user, all imports for an admin. */
  static async listImports(user: UserPayload) {
    const where = user.role === 'admin' ? {} : { userId: user.id };
    return prisma.externalAgentLog.findMany({
      where,
      orderBy: { importTimestamp: 'desc' },
    });
  }

  static async getImportDetail(user: UserPayload, id: number) {
    const log = await prisma.externalAgentLog.findUnique({
      where: { id },
      include: { records: { orderBy: { timestamp: 'desc' }, take: 500 } },
    });
    if (!log) {
      throw Errors.notFound('Imported log');
    }
    if (user.role !== 'admin' && log.userId !== user.id) {
      throw Errors.forbidden('You can only view your own imported logs');
    }
    return log;
  }

  /**
   * Aggregate stats for the External Agent Logs tab - computed entirely
   * from external_agent_log_records, never from llm_usage_logs.
   */
  static async getStats(user: UserPayload) {
    const importScope = user.role === 'admin' ? {} : { userId: user.id };
    const importIds = (await prisma.externalAgentLog.findMany({ where: importScope, select: { id: true } })).map(
      (i: { id: number }) => i.id
    );

    if (importIds.length === 0) {
      return {
        totalRecords: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCost: 0,
        runs: 0,
        errors: 0,
        averageLatencyMs: 0,
        byAgent: [] as Array<{
          agentName: string;
          records: number;
          totalInputTokens: number;
          totalOutputTokens: number;
          estimatedCost: number;
          errors: number;
          averageLatencyMs: number;
        }>,
      };
    }

    const where = { importId: { in: importIds } };

    const totals = await prisma.externalAgentLogRecord.aggregate({
      where,
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _avg: { latencyMs: true },
      _count: { _all: true },
    });

    const errorCount = await prisma.externalAgentLogRecord.count({ where: { ...where, isError: true } });

    const byAgentGrouped = await prisma.externalAgentLogRecord.groupBy({
      by: ['agentName'],
      where,
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _avg: { latencyMs: true },
      _count: { _all: true },
    });

    const errorsByAgent = await prisma.externalAgentLogRecord.groupBy({
      by: ['agentName'],
      where: { ...where, isError: true },
      _count: { _all: true },
    });
    const errorsByAgentMap = new Map(errorsByAgent.map((e: typeof errorsByAgent[number]) => [e.agentName, e._count._all]));

    return {
      totalRecords: totals._count._all,
      totalInputTokens: totals._sum.inputTokens ?? 0,
      totalOutputTokens: totals._sum.outputTokens ?? 0,
      estimatedCost: totals._sum.estimatedCost ?? 0,
      // "runs" - external logs have no AgentRun concept of their own;
      // each imported record is itself the unit of work, so runs ===
      // total records (documented here since it's not obvious from the
      // field name alone).
      runs: totals._count._all,
      errors: errorCount,
      averageLatencyMs: Math.round(totals._avg.latencyMs ?? 0),
      byAgent: byAgentGrouped.map((g: typeof byAgentGrouped[number]) => ({
        agentName: g.agentName,
        records: g._count._all,
        totalInputTokens: g._sum.inputTokens ?? 0,
        totalOutputTokens: g._sum.outputTokens ?? 0,
        estimatedCost: g._sum.estimatedCost ?? 0,
        errors: errorsByAgentMap.get(g.agentName) ?? 0,
        averageLatencyMs: Math.round(g._avg.latencyMs ?? 0),
      })),
    };
  }
}
