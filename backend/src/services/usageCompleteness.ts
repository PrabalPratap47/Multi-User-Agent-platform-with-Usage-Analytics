import type { Prisma } from '@prisma/client';
import { MISSING_USAGE_ERROR_CODE } from './llmService.js';
import { INTERRUPTED_RUNNING_REASON } from './runRecoveryService.js';

/**
 * The single definition of "usage data is missing or incomplete", shared by
 * GET /api/analytics/usage-completeness and GET /api/runs?usage=incomplete
 * so both always agree. Token and cost totals are sums of RECORDED values;
 * these signals say where the real usage is larger than what was recorded
 * (or unknown). Nothing here estimates or fills in a value.
 *
 * - USAGE_UNKNOWN: the provider returned no usage. The row stores 0/0 tokens
 *   with errorCode MISSING_USAGE_DATA (llmService.ts): tokens and cost are
 *   unknown, not zero.
 * - COST_UNKNOWN: real token counts, but the model has no configured price
 *   (estimatedCost NULL), so the cost is missing from the cost total.
 * - NO_USAGE_LOGGED: a SUCCESS run with no usage row at all. Every successful
 *   run made at least one provider call, so its usage row(s) were not written
 *   (USAGE_LOG_WRITE_FAILED, usageLogService.ts).
 * - INTERRUPTED: a run failed by startup recovery while it was RUNNING
 *   (runRecoveryService.ts). A provider call may have been cut off without
 *   any usage being received.
 *
 * Not flagged: a failed provider call (status ERROR, 0 tokens) is a known
 * zero - the provider reported no usage for a request it rejected.
 */
export type UsageIssue = 'USAGE_UNKNOWN' | 'COST_UNKNOWN' | 'NO_USAGE_LOGGED' | 'INTERRUPTED';

/** Calls whose token counts (and so cost) are unknown. */
export const unknownUsageCallWhere = {
  isSeedData: false,
  errorCode: MISSING_USAGE_ERROR_CODE,
} satisfies Prisma.LlmUsageLogWhereInput;

/** Calls with real token counts but no price. */
export const unknownCostCallWhere = {
  isSeedData: false,
  estimatedCost: null,
  OR: [{ inputTokens: { gt: 0 } }, { outputTokens: { gt: 0 } }],
} satisfies Prisma.LlmUsageLogWhereInput;

/** Successful runs with no usage row. */
export const runWithoutUsageLogWhere = {
  status: 'SUCCESS',
  llmUsageLogs: { none: {} },
} satisfies Prisma.AgentRunWhereInput;

/** Runs failed by startup recovery while in progress. */
export const interruptedRunWhere = {
  status: 'ERROR',
  errorMessage: INTERRUPTED_RUNNING_REASON,
} satisfies Prisma.AgentRunWhereInput;

/** Runs with at least one usage issue. */
export const incompleteUsageRunWhere = {
  OR: [
    runWithoutUsageLogWhere,
    interruptedRunWhere,
    { llmUsageLogs: { some: unknownUsageCallWhere } },
    { llmUsageLogs: { some: unknownCostCallWhere } },
  ],
} satisfies Prisma.AgentRunWhereInput;

/** The usage-log fields usageIssuesFor needs (never returned to clients). */
export const USAGE_ISSUE_LOG_SELECT = {
  errorCode: true,
  estimatedCost: true,
  inputTokens: true,
  outputTokens: true,
  isSeedData: true,
} as const;

/** Per-run issues, matching the where-clauses above. */
export function usageIssuesFor(run: {
  status: string;
  errorMessage: string | null;
  llmUsageLogs: Array<{ errorCode: string | null; estimatedCost: number | null; inputTokens: number; outputTokens: number; isSeedData: boolean }>;
}): UsageIssue[] {
  const issues: UsageIssue[] = [];
  const realLogs = run.llmUsageLogs.filter(log => !log.isSeedData);
  if (run.status === 'SUCCESS' && run.llmUsageLogs.length === 0) issues.push('NO_USAGE_LOGGED');
  if (run.status === 'ERROR' && run.errorMessage === INTERRUPTED_RUNNING_REASON) issues.push('INTERRUPTED');
  if (realLogs.some(log => log.errorCode === MISSING_USAGE_ERROR_CODE)) issues.push('USAGE_UNKNOWN');
  if (realLogs.some(log => log.estimatedCost === null && (log.inputTokens > 0 || log.outputTokens > 0))) issues.push('COST_UNKNOWN');
  return issues;
}
