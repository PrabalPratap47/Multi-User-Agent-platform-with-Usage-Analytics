import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload } from '../types/index.js';
import { RUN_LIST_DEFAULT_LIMIT, validateAgentRunListQuery } from '../utils/validators.js';
import { incompleteUsageRunWhere, usageIssuesFor, USAGE_ISSUE_LOG_SELECT, type UsageIssue } from './usageCompleteness.js';

/**
 * Agent run listing (GET /api/runs, GET /api/runs/:id).
 *
 * Exposes run metadata only: ids, owner, agent, status, timestamps, the
 * stored safe failure reason, and a reference to the result. Never CV or
 * feedback text, prompts, raw model output, or token counts - those stay
 * behind their own endpoints (CV results, sentiment results, usage logs).
 */
const RUN_SELECT = {
  id: true,
  status: true,
  agentName: true,
  batchId: true,
  cvDocumentId: true,
  errorMessage: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  user: { select: { id: true, email: true } },
  cvDocument: { select: { fileName: true } },
  cvRecommendation: { select: { id: true, primaryCategory: true } },
  sentimentResult: { select: { id: true, sentiment: true } },
  _count: { select: { llmUsageLogs: true } },
  // Read only to derive usageIssues; never returned.
  llmUsageLogs: { select: USAGE_ISSUE_LOG_SELECT },
} as const;

type RunRow = Awaited<ReturnType<typeof findRuns>>[number];

function findRuns(args: { where: Record<string, unknown>; take: number; skip: number }) {
  return prisma.agentRun.findMany({
    where: args.where,
    select: RUN_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    skip: args.skip,
  });
}

export interface AgentRunSummary {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR';
  agentName: string;
  user: { id: number; email: string };
  batchId: string | null;
  cvDocumentId: number | null;
  cvFileName: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  /** ERROR runs only: the stored safe reason (provider failures shown generically); null if none was recorded. */
  errorMessage: string | null;
  result:
    | { type: 'cv_recommendation'; id: number; primaryCategory: string }
    | { type: 'sentiment_result'; id: number; sentiment: string }
    | null;
  /** Number of usage-log rows attached to this run (AI calls that were logged). */
  llmCallsLogged: number;
  /** A seed.ts demo run (its usage log is flagged isSeedData); excluded from analytics. */
  isSeedData: boolean;
  /** Missing or incomplete usage data for this run (see services/usageCompleteness.ts); empty when complete. */
  usageIssues: UsageIssue[];
}

export interface AgentRunPage {
  runs: AgentRunSummary[];
  total: number;
  limit: number;
  offset: number;
  /** Registered agent names, for the agent filter. */
  agents: string[];
}

/**
 * Runs of deleted (deactivated) accounts are left out of the listing and
 * details. The rows themselves are kept (a user delete is a soft delete), so
 * run-count analytics and usage history stay exact.
 */
const ACTIVE_OWNER = { user: { deactivatedAt: null } } as const;

/** Admin: every user, optionally narrowed by ?userId=. User: always and only their own runs. */
function ownerScope(user: UserPayload, requestedUserId?: number): { userId?: number } {
  if (user.role === 'admin') {
    return requestedUserId !== undefined ? { userId: requestedUserId } : {};
  }
  return { userId: user.id };
}

async function seedRunIdSet(runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await prisma.llmUsageLog.findMany({
    where: { isSeedData: true, runId: { in: runIds } },
    select: { runId: true },
    distinct: ['runId'],
  });
  return new Set(rows.flatMap(r => (r.runId ? [r.runId] : [])));
}

// providerFailureMessage() (llmService.ts) stores "The AI provider request
// failed: <provider text>". The provider text can carry account details (an
// OpenAI 429 names the organization), so this listing shows only the generic
// part. The other stored reasons are already fixed, safe sentences.
const PROVIDER_FAILURE_PREFIX = 'The AI provider request failed';

function listedFailureReason(run: RunRow): string | null {
  if (run.status !== 'ERROR' || !run.errorMessage) return null;
  return run.errorMessage.startsWith(PROVIDER_FAILURE_PREFIX) ? `${PROVIDER_FAILURE_PREFIX}.` : run.errorMessage;
}

function toSummary(run: RunRow, seedIds: Set<string>): AgentRunSummary {
  const result = run.cvRecommendation
    ? { type: 'cv_recommendation' as const, id: run.cvRecommendation.id, primaryCategory: run.cvRecommendation.primaryCategory }
    : run.sentimentResult
      ? { type: 'sentiment_result' as const, id: run.sentimentResult.id, sentiment: run.sentimentResult.sentiment }
      : null;
  return {
    id: run.id,
    status: run.status,
    agentName: run.agentName,
    user: run.user,
    batchId: run.batchId,
    cvDocumentId: run.cvDocumentId,
    cvFileName: run.cvDocument?.fileName ?? null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    errorMessage: listedFailureReason(run),
    result,
    llmCallsLogged: run._count.llmUsageLogs,
    isSeedData: seedIds.has(run.id),
    usageIssues: usageIssuesFor(run),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentRunService {
  static async list(user: UserPayload, rawQuery: unknown): Promise<AgentRunPage> {
    const query = validateAgentRunListQuery(rawQuery);
    const limit = query.limit ?? RUN_LIST_DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const where = {
      ...ownerScope(user, query.userId),
      ...ACTIVE_OWNER,
      ...(query.agent ? { agentName: query.agent } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.usage === 'incomplete' ? incompleteUsageRunWhere : {}),
    };

    const [rows, total, agents] = await Promise.all([
      findRuns({ where, take: limit, skip: offset }),
      prisma.agentRun.count({ where }),
      prisma.agent.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    ]);
    const seedIds = await seedRunIdSet(rows.map(r => r.id));

    return {
      runs: rows.map(r => toSummary(r, seedIds)),
      total,
      limit,
      offset,
      agents: agents.map(a => a.name),
    };
  }

  static async getById(user: UserPayload, runId: string): Promise<AgentRunSummary> {
    if (!UUID_PATTERN.test(runId)) {
      throw Errors.badRequest('Invalid run id');
    }
    // A deleted account's run reads as not found, like the listing that omits it.
    const run = await prisma.agentRun.findFirst({ where: { id: runId, ...ACTIVE_OWNER }, select: RUN_SELECT });
    if (!run) {
      throw Errors.notFound('Agent run');
    }
    if (user.role !== 'admin' && run.user.id !== user.id) {
      throw Errors.forbidden('You can only view your own agent runs');
    }
    return toSummary(run, await seedRunIdSet([run.id]));
  }
}
