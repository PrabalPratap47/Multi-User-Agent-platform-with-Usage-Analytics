import prisma from '../db/client.js';
import { UserPayload } from '../types/index.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../agents/CVClassificationAgent.js';
import {
  incompleteUsageRunWhere,
  interruptedRunWhere,
  runWithoutUsageLogWhere,
  unknownCostCallWhere,
  unknownUsageCallWhere,
} from './usageCompleteness.js';

/**
 * Centralized analytics calculations. Every method here is the ONLY
 * place its metric is computed - the API controller just calls these and
 * serializes the result, so there is exactly one implementation of each
 * calculation to audit, and the frontend never recomputes anything
 * (per the requirement: tokens/cost must come from persisted
 * llm_usage_logs, never from frontend-supplied data).
 *
 * Scope rule applied throughout: a regular user's results are always
 * filtered to their own userId; an admin may see all data. This is
 * decided from `user` (the authenticated caller, from req.user - never a
 * client-supplied id), never from a query parameter alone. Full
 * documentation of every metric's exact calculation lives in
 * docs/ANALYTICS_API.md.
 *
 * isSeedData rows are excluded from every metric below - they are
 * fabricated demo data (see db/seed.ts), and including them would mean
 * reporting numbers that were never produced by a real LLM call.
 */

const REAL_USAGE_FILTER = { isSeedData: false } as const;

/**
 * Runs created by seed.ts. Only llm_usage_logs carries the isSeedData
 * flag, so a demo run is one whose usage log is flagged; its run,
 * recommendation and decision rows are demo data too and must not count
 * toward run counts, acceptance rate or time saved.
 */
async function seedRunIds(): Promise<string[]> {
  const rows = await prisma.llmUsageLog.findMany({
    where: { isSeedData: true, runId: { not: null } },
    select: { runId: true },
    distinct: ['runId'],
  });
  return rows.flatMap(r => (r.runId ? [r.runId] : []));
}

/** A recommendation that is not seed demo data (runId may be null, which NOT IN alone would drop). */
function notSeedRecommendation(seedIds: string[]) {
  return { OR: [{ runId: null }, { runId: { notIn: seedIds } }] };
}

function userScope(user: UserPayload, explicitUserId?: number): { userId?: number } {
  if (user.role === 'admin') {
    return explicitUserId !== undefined ? { userId: explicitUserId } : {};
  }
  return { userId: user.id };
}

export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  callCount: number;
}

export interface AgentRunCounts {
  last24h: number;
  last7d: number;
  last30d: number;
  /** All-time runs whose final status is SUCCESS. */
  successful: number;
  /** All-time runs whose final status is ERROR. PENDING/RUNNING runs count toward neither. */
  failed: number;
}

export interface AgentErrorRate {
  agentId: number;
  agentName: string;
  totalCalls: number;
  errorCalls: number;
  errorRate: number; // 0..1
}

export interface AgentLatency {
  agentId: number;
  agentName: string;
  averageLatencyMs: number;
  callCount: number;
}

export interface CategoryAcceptanceRate {
  category: string;
  totalDecisions: number;
  accept: number;
  modify: number;
  reject: number;
  /** accept / totalDecisions - see docs/ANALYTICS_API.md for why MODIFY and REJECT both count against this. */
  acceptanceRate: number;
}

export interface UsageCompletenessCounts {
  /** Calls whose provider returned no usage: recorded as 0 tokens / 0 cost, real values unknown. */
  callsWithUnknownUsage: number;
  /** Calls with real token counts but an unpriced model: their cost is not in the cost total. */
  callsWithUnknownCost: number;
  /** Successful runs with no usage row: their AI calls are not in any total. */
  successfulRunsWithoutUsageLog: number;
  /** Runs interrupted by a backend restart: a provider call may have been cut off, usage unknown. */
  interruptedRuns: number;
  /** Distinct runs with at least one of the issues above (find them with GET /api/runs?usage=incomplete). */
  affectedRuns: number;
}

export interface UsageCompleteness extends UsageCompletenessCounts {
  /** True when none of the issues above occur in this scope: the totals are complete as far as the data can show. */
  complete: boolean;
  /** Admin, all-users scope only: the users with at least one issue. */
  byUser?: Array<UsageCompletenessCounts & { userId: number; email: string }>;
}

export interface TimeSavedEstimate {
  methodology: 'ESTIMATED';
  baselineManualReviewMinutesPerCv: number;
  measuredAverageAutomatedLatencyMs: number;
  completedCvCount: number;
  estimatedTimeSavedHours: number;
  assumptions: string[];
}

export class AnalyticsService {
  // ── 1-4: overall input/output/total tokens, estimated cost ─────────
  static async getTokenSummary(user: UserPayload, explicitUserId?: number): Promise<TokenSummary> {
    const where = { ...REAL_USAGE_FILTER, ...userScope(user, explicitUserId) };

    const aggregate = await prisma.llmUsageLog.aggregate({
      where,
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _count: { _all: true },
    });

    const totalInputTokens = aggregate._sum.inputTokens ?? 0;
    const totalOutputTokens = aggregate._sum.outputTokens ?? 0;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      estimatedCost: aggregate._sum.estimatedCost ?? 0,
      callCount: aggregate._count._all,
    };
  }

  // ── 5: token consumption by user (admin only - enforced by the route) ─
  static async getTokensByUser() {
    const grouped = await prisma.llmUsageLog.groupBy({
      by: ['userId'],
      where: REAL_USAGE_FILTER,
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _count: { _all: true },
    });

    const userIds = grouped.map(g => g.userId);
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
    const emailById = new Map(users.map(u => [u.id, u.email]));

    return grouped.map(g => ({
      userId: g.userId,
      email: emailById.get(g.userId) ?? 'unknown',
      totalInputTokens: g._sum.inputTokens ?? 0,
      totalOutputTokens: g._sum.outputTokens ?? 0,
      estimatedCost: g._sum.estimatedCost ?? 0,
      callCount: g._count._all,
    }));
  }

  // ── 6: token consumption by agent ───────────────────────────────────
  static async getTokensByAgent(user: UserPayload, explicitUserId?: number) {
    const where = { ...REAL_USAGE_FILTER, ...userScope(user, explicitUserId) };

    const grouped = await prisma.llmUsageLog.groupBy({
      by: ['agentId', 'agentName'],
      where,
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _count: { _all: true },
    });

    return grouped.map(g => ({
      agentId: g.agentId,
      agentName: g.agentName,
      totalInputTokens: g._sum.inputTokens ?? 0,
      totalOutputTokens: g._sum.outputTokens ?? 0,
      estimatedCost: g._sum.estimatedCost ?? 0,
      callCount: g._count._all,
    }));
  }

  // ── 7: agent run counts for 24h / 7d / 30d, plus successful / failed ─
  static async getAgentRunCounts(user: UserPayload, explicitUserId?: number): Promise<AgentRunCounts> {
    const where = { ...userScope(user, explicitUserId), id: { notIn: await seedRunIds() } };
    const now = new Date();
    const since = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Outcomes use agent_runs.status exactly as the run lifecycle writes it
    // (cvClassificationService, sentimentService, cvBatchService).
    const [last24h, last7d, last30d, successful, failed] = await Promise.all([
      prisma.agentRun.count({ where: { ...where, createdAt: { gte: since(1) } } }),
      prisma.agentRun.count({ where: { ...where, createdAt: { gte: since(7) } } }),
      prisma.agentRun.count({ where: { ...where, createdAt: { gte: since(30) } } }),
      prisma.agentRun.count({ where: { ...where, status: 'SUCCESS' } }),
      prisma.agentRun.count({ where: { ...where, status: 'ERROR' } }),
    ]);

    return { last24h, last7d, last30d, successful, failed };
  }

  // ── 8: error rate by agent ───────────────────────────────────────────
  static async getErrorRateByAgent(user: UserPayload, explicitUserId?: number): Promise<AgentErrorRate[]> {
    const where = { ...REAL_USAGE_FILTER, ...userScope(user, explicitUserId) };

    const totals = await prisma.llmUsageLog.groupBy({
      by: ['agentId', 'agentName'],
      where,
      _count: { _all: true },
    });

    const errors = await prisma.llmUsageLog.groupBy({
      by: ['agentId'],
      where: { ...where, status: 'ERROR' },
      _count: { _all: true },
    });
    const errorsByAgent = new Map(errors.map(e => [e.agentId, e._count._all]));

    return totals.map(t => {
      const errorCalls = errorsByAgent.get(t.agentId) ?? 0;
      return {
        agentId: t.agentId,
        agentName: t.agentName,
        totalCalls: t._count._all,
        errorCalls,
        errorRate: t._count._all > 0 ? errorCalls / t._count._all : 0,
      };
    });
  }

  // ── 9: average latency by agent ─────────────────────────────────────
  static async getAverageLatencyByAgent(user: UserPayload, explicitUserId?: number): Promise<AgentLatency[]> {
    const where = { ...REAL_USAGE_FILTER, ...userScope(user, explicitUserId) };

    const grouped = await prisma.llmUsageLog.groupBy({
      by: ['agentId', 'agentName'],
      where,
      _avg: { latencyMs: true },
      _count: { _all: true },
    });

    return grouped.map(g => ({
      agentId: g.agentId,
      agentName: g.agentName,
      averageLatencyMs: Math.round(g._avg.latencyMs ?? 0),
      callCount: g._count._all,
    }));
  }

  // ── 10: CV recommendation acceptance rate per category ──────────────
  static async getAcceptanceRateByCategory(
    user: UserPayload,
    explicitUserId?: number
  ): Promise<CategoryAcceptanceRate[]> {
    const scope = userScope(user, explicitUserId);

    // Decisions joined to the recommendation's ORIGINAL category - "per
    // category" means grouped by what the agent originally proposed, not
    // by what the user ultimately chose (that would make MODIFY decisions
    // uninterpretable: which category would they count toward?).
    const decisions = await prisma.recommendationDecision.findMany({
      where: {
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        recommendation: notSeedRecommendation(await seedRunIds()),
      },
      include: { recommendation: { select: { primaryCategory: true } } },
    });

    const byCategory = new Map<string, { accept: number; modify: number; reject: number }>();
    for (const decision of decisions) {
      const category = decision.recommendation.primaryCategory;
      const bucket = byCategory.get(category) ?? { accept: 0, modify: 0, reject: 0 };
      if (decision.decisionType === 'ACCEPT') bucket.accept += 1;
      else if (decision.decisionType === 'MODIFY') bucket.modify += 1;
      else bucket.reject += 1;
      byCategory.set(category, bucket);
    }

    return [...byCategory.entries()].map(([category, counts]) => {
      const totalDecisions = counts.accept + counts.modify + counts.reject;
      return {
        category,
        totalDecisions,
        accept: counts.accept,
        modify: counts.modify,
        reject: counts.reject,
        acceptanceRate: totalDecisions > 0 ? counts.accept / totalDecisions : 0,
      };
    });
  }

  // ── Usage completeness: how far the token/cost totals above are incomplete ─
  // Counts only; the totals themselves are never adjusted or estimated.
  // Definitions: services/usageCompleteness.ts and docs/ANALYTICS_API.md.
  static async getUsageCompleteness(user: UserPayload, explicitUserId?: number): Promise<UsageCompleteness> {
    const scope = userScope(user, explicitUserId);
    const [callsWithUnknownUsage, callsWithUnknownCost, successfulRunsWithoutUsageLog, interruptedRuns, affectedRuns] =
      await Promise.all([
        prisma.llmUsageLog.count({ where: { ...unknownUsageCallWhere, ...scope } }),
        prisma.llmUsageLog.count({ where: { ...unknownCostCallWhere, ...scope } }),
        prisma.agentRun.count({ where: { ...runWithoutUsageLogWhere, ...scope } }),
        prisma.agentRun.count({ where: { ...interruptedRunWhere, ...scope } }),
        prisma.agentRun.count({ where: { ...incompleteUsageRunWhere, ...scope } }),
      ]);
    const counts = { callsWithUnknownUsage, callsWithUnknownCost, successfulRunsWithoutUsageLog, interruptedRuns, affectedRuns };
    const result: UsageCompleteness = { ...counts, complete: affectedRuns === 0 && callsWithUnknownUsage === 0 && callsWithUnknownCost === 0 };

    // Cross-user breakdown: only for an admin looking at everyone.
    if (user.role === 'admin' && explicitUserId === undefined && !result.complete) {
      const [unknownUsage, unknownCost, withoutLog, interrupted, affected] = await Promise.all([
        prisma.llmUsageLog.groupBy({ by: ['userId'], where: unknownUsageCallWhere, _count: { _all: true } }),
        prisma.llmUsageLog.groupBy({ by: ['userId'], where: unknownCostCallWhere, _count: { _all: true } }),
        prisma.agentRun.groupBy({ by: ['userId'], where: runWithoutUsageLogWhere, _count: { _all: true } }),
        prisma.agentRun.groupBy({ by: ['userId'], where: interruptedRunWhere, _count: { _all: true } }),
        prisma.agentRun.groupBy({ by: ['userId'], where: incompleteUsageRunWhere, _count: { _all: true } }),
      ]);
      const perUser = new Map<number, UsageCompletenessCounts>();
      const add = (rows: Array<{ userId: number; _count: { _all: number } }>, key: keyof UsageCompletenessCounts) => {
        for (const row of rows) {
          const entry = perUser.get(row.userId) ?? { callsWithUnknownUsage: 0, callsWithUnknownCost: 0, successfulRunsWithoutUsageLog: 0, interruptedRuns: 0, affectedRuns: 0 };
          entry[key] = row._count._all;
          perUser.set(row.userId, entry);
        }
      };
      add(unknownUsage, 'callsWithUnknownUsage');
      add(unknownCost, 'callsWithUnknownCost');
      add(withoutLog, 'successfulRunsWithoutUsageLog');
      add(interrupted, 'interruptedRuns');
      add(affected, 'affectedRuns');
      const users = await prisma.user.findMany({ where: { id: { in: [...perUser.keys()] } }, select: { id: true, email: true } });
      const emailById = new Map(users.map(u => [u.id, u.email]));
      result.byUser = [...perUser.entries()]
        .map(([userId, entry]) => ({ userId, email: emailById.get(userId) ?? 'unknown', ...entry }))
        .sort((a, b) => a.userId - b.userId);
    }
    return result;
  }

  // ── 11: time saved in person-hours (ESTIMATED - see docs/ANALYTICS_API.md) ─
  static async getTimeSaved(user: UserPayload, explicitUserId?: number): Promise<TimeSavedEstimate> {
    const scope = userScope(user, explicitUserId);
    const BASELINE_MANUAL_REVIEW_MINUTES_PER_CV = 5;

    // "Only using completed CV processing": a CvRecommendation row only
    // ever exists for a run that reached SUCCESS (see
    // cvClassificationService.ts) - a failed or still-processing CV
    // contributes nothing here.
    const completedCvCount = await prisma.cvRecommendation.count({
      where: {
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        ...notSeedRecommendation(await seedRunIds()),
      },
    });

    // "Automated processing time" is MEASURED, not assumed: the actual
    // average latency of real (non-seed) CV Classification Agent calls.
    const latencyAgg = await prisma.llmUsageLog.aggregate({
      where: {
        ...REAL_USAGE_FILTER,
        agentName: CV_CLASSIFICATION_AGENT_NAME,
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      },
      _avg: { latencyMs: true },
    });
    const measuredAverageAutomatedLatencyMs = Math.round(latencyAgg._avg.latencyMs ?? 0);

    const manualMinutesTotal = completedCvCount * BASELINE_MANUAL_REVIEW_MINUTES_PER_CV;
    const automatedMinutesTotal = (completedCvCount * measuredAverageAutomatedLatencyMs) / 60000;
    const estimatedTimeSavedHours = Math.max(0, (manualMinutesTotal - automatedMinutesTotal) / 60);

    return {
      methodology: 'ESTIMATED',
      baselineManualReviewMinutesPerCv: BASELINE_MANUAL_REVIEW_MINUTES_PER_CV,
      measuredAverageAutomatedLatencyMs,
      completedCvCount,
      estimatedTimeSavedHours,
      assumptions: [
        `A human reviewer takes ${BASELINE_MANUAL_REVIEW_MINUTES_PER_CV} minutes to manually read and categorize one CV - an assumed baseline, not measured.`,
        'Automated processing time per CV is the measured average latency of real (non-seed) CV Classification Agent calls, not an assumption.',
        'Only CVs that completed successfully (have a stored recommendation) count toward time saved - failed or still-processing CVs contribute nothing.',
        'This figure is an ESTIMATE derived from one assumed baseline and one measured quantity - it is never reported as a directly measured human-productivity gain.',
      ],
    };
  }
}
