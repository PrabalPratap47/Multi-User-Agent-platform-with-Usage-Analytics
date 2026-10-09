/**
 * F-14: missing or incomplete usage data is reported, never hidden and never
 * filled in.
 *
 * Every case is produced through the real code paths with CONTROLLED stub
 * providers (no OpenAI calls):
 * - provider returned no usage        -> LLMService writes MISSING_USAGE_DATA (0/0, unknown)
 * - unpriced model                    -> real tokens, estimatedCost NULL
 * - usage-log write failed (F-02)     -> SUCCESS run with no usage row (SQLite trigger)
 * - backend restart mid-run (F-07)    -> recoverInterruptedRuns marks it interrupted
 * - provider error                    -> ERROR row, 0 tokens: a KNOWN zero, not flagged
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvClassificationAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import { LLMService, MISSING_USAGE_ERROR_CODE, type LLMProviderRequest, type LLMProviderResponse } from '../src/services/llmService.js';
import { recoverInterruptedRuns } from '../src/services/runRecoveryService.js';
import { calculateCost } from '../src/utils/costCalculator.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const EMAILS = {
  userA: 'completeness-a@test.local',
  userB: 'completeness-b@test.local',
  userC: 'completeness-c@test.local',
  admin: 'completeness-admin@test.local',
} as const;
type Who = keyof typeof EMAILS;
const ids: Record<Who, number> = { userA: 0, userB: 0, userC: 0, admin: 0 };
const tokens: Record<Who, string> = { userA: '', userB: '', userC: '', admin: '' };
const EVIDENCE = 'Node.js and Express backend engineer';
const CV_SENTINEL = 'CVSENTINEL_COMPLETENESS_8812';
const TRIGGER = 'test_f14_block_usage_log_insert';
const runs = { complete: '', unknownUsage: '', unknownCost: '', unlogged: '', interrupted: '', providerFail: '', bUnknownUsage: '', bComplete: '', cComplete: '' };

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}

/** Behaviour comes from a marker in the CV text. */
function stubProvider() {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence['Back-End Developer'] = 0.9;
  const text = JSON.stringify({ primaryCategory: 'Back-End Developer', secondaryCategories: [], confidence, rationale: [{ category: 'Back-End Developer', evidence: EVIDENCE }] });
  let seq = 0;
  return {
    messages: {
      create: async (req: LLMProviderRequest): Promise<LLMProviderResponse> => {
        const content = req.messages[0].content;
        if (content.includes('MARK_PROVIDER_FAIL')) throw { status: 503, name: 'APIError', message: 'Service unavailable (stub)' };
        const id = `chatcmpl-f14-${++seq}`;
        if (content.includes('MARK_NO_USAGE')) return { id, content: [{ type: 'text', text }], model: 'gpt-4o' }; // no usage object
        const model = content.includes('MARK_UNPRICED') ? 'unpriced-model-f14' : 'gpt-4o';
        return { id, content: [{ type: 'text', text }], model, usage: { prompt_tokens: 500, completion_tokens: 80 } };
      },
    },
  };
}

const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
async function classify(who: Who, marker: string) {
  const res = await request(app).post('/api/cv/classify').set(as(who)).send({ cvContent: `${EVIDENCE}, five years. ${CV_SENTINEL} ${marker}`, fileName: `${marker || 'plain'}.txt` });
  return res;
}
const completeness = async (who: Who, query = '') =>
  (await request(app).get(`/api/analytics/usage-completeness${query}`).set(as(who))).body.data;

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const hash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  for (const who of Object.keys(EMAILS) as Who[]) {
    ids[who] = (await prisma.user.create({ data: { email: EMAILS[who], password: hash, role: who === 'admin' ? 'ADMIN' : 'USER' } })).id;
    tokens[who] = (await loginAs(EMAILS[who])).accessToken;
  }
  __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService(stubProvider())));

  runs.complete = (await classify('userA', '')).body.data.runId;
  runs.unknownUsage = (await classify('userA', 'MARK_NO_USAGE')).body.data.runId;
  runs.unknownCost = (await classify('userA', 'MARK_UNPRICED')).body.data.runId;
  const failed = await classify('userA', 'MARK_PROVIDER_FAIL');
  expect(failed.status).toBe(502);
  runs.providerFail = (await prisma.agentRun.findFirstOrThrow({ where: { userId: ids.userA, status: 'ERROR' }, orderBy: { createdAt: 'desc' } })).id;

  // The usage-log insert fails for this one request (F-02 path): the run succeeds without a row.
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON llm_usage_logs WHEN NEW.userId = ${ids.userA} BEGIN SELECT RAISE(ABORT, 'simulated usage-log write failure'); END`
  );
  try {
    const unlogged = await classify('userA', '');
    expect(unlogged.status).toBe(201);
    runs.unlogged = unlogged.body.data.runId;
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
  }

  // A run a previous backend process left RUNNING, failed by the real startup recovery (F-07 path).
  const agent = await prisma.agent.findUniqueOrThrow({ where: { name: CV_CLASSIFICATION_AGENT_NAME } });
  runs.interrupted = (await prisma.agentRun.create({ data: { userId: ids.userA, agentId: agent.id, agentName: agent.name, status: 'RUNNING' } })).id;
  await new Promise(resolve => setTimeout(resolve, 10));
  await recoverInterruptedRuns(new Date());

  runs.bUnknownUsage = (await classify('userB', 'MARK_NO_USAGE')).body.data.runId;
  runs.bComplete = (await classify('userB', '')).body.data.runId;
  runs.cComplete = (await classify('userC', '')).body.data.runId;
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

describe('nothing is fabricated', () => {
  it('a run whose usage could not be logged has no usage row at all - not a 0-token or 0-cost one', async () => {
    expect(await prisma.llmUsageLog.count({ where: { runId: runs.unlogged } })).toBe(0);
    expect(await prisma.llmUsageLog.count({ where: { runId: runs.interrupted } })).toBe(0);
    // Reading analytics and the run listing must not create anything either.
    await completeness('userA');
    await request(app).get('/api/runs?usage=incomplete').set(as('userA'));
    expect(await prisma.llmUsageLog.count({ where: { runId: { in: [runs.unlogged, runs.interrupted] } } })).toBe(0);
  });

  it('missing provider usage is stored flagged as unknown, never as a plain zero', async () => {
    const row = await prisma.llmUsageLog.findFirstOrThrow({ where: { runId: runs.unknownUsage } });
    expect(row).toMatchObject({ inputTokens: 0, outputTokens: 0, errorCode: MISSING_USAGE_ERROR_CODE, status: 'SUCCESS' });
    const unpriced = await prisma.llmUsageLog.findFirstOrThrow({ where: { runId: runs.unknownCost } });
    expect(unpriced).toMatchObject({ inputTokens: 500, outputTokens: 80, estimatedCost: null });
  });

  it('the token/cost totals stay sums of recorded values only (known totals)', async () => {
    const summary = (await request(app).get('/api/analytics/summary').set(as('userA'))).body.data;
    // complete (500/80) + unknown-usage (0/0) + unpriced (500/80) + provider failure (0/0); no row for the unlogged or interrupted run.
    expect(summary).toMatchObject({ totalInputTokens: 1000, totalOutputTokens: 160, totalTokens: 1160, callCount: 4 });
    expect(summary.estimatedCost).toBeCloseTo(calculateCost({ input_tokens: 500, output_tokens: 80 }, 'gpt-4o')!, 12);
  });
});

describe('GET /api/analytics/usage-completeness', () => {
  it('reports each kind of gap for the caller, with the affected run count', async () => {
    expect(await completeness('userA')).toEqual({
      callsWithUnknownUsage: 1,
      callsWithUnknownCost: 1,
      successfulRunsWithoutUsageLog: 1,
      interruptedRuns: 1,
      affectedRuns: 4,
      complete: false,
    });
  });

  it('a provider failure (0 tokens) is a known zero and does not make data incomplete', async () => {
    const res = await request(app).get(`/api/runs/${runs.providerFail}`).set(as('userA'));
    expect(res.body.data.usageIssues).toEqual([]);
    expect(await completeness('userC')).toEqual({
      callsWithUnknownUsage: 0, callsWithUnknownCost: 0, successfulRunsWithoutUsageLog: 0, interruptedRuns: 0, affectedRuns: 0, complete: true,
    });
  });

  it('users only see their own gaps; ?userId= is ignored for them and they get no per-user breakdown', async () => {
    const b = await completeness('userB');
    expect(b).toEqual({ callsWithUnknownUsage: 1, callsWithUnknownCost: 0, successfulRunsWithoutUsageLog: 0, interruptedRuns: 0, affectedRuns: 1, complete: false });
    expect(await completeness('userB', `?userId=${ids.userA}`)).toEqual(b);
    expect(await completeness('userA', `?userId=${ids.userB}`)).toMatchObject({ affectedRuns: 4 });
  });

  it('admins get the cross-user aggregate with a per-user breakdown, and can drill into one user', async () => {
    const all = await completeness('admin');
    expect(all.complete).toBe(false);
    const a = all.byUser.find((u: { userId: number }) => u.userId === ids.userA);
    const b = all.byUser.find((u: { userId: number }) => u.userId === ids.userB);
    expect(a).toEqual({ userId: ids.userA, email: EMAILS.userA, callsWithUnknownUsage: 1, callsWithUnknownCost: 1, successfulRunsWithoutUsageLog: 1, interruptedRuns: 1, affectedRuns: 4 });
    expect(b).toEqual({ userId: ids.userB, email: EMAILS.userB, callsWithUnknownUsage: 1, callsWithUnknownCost: 0, successfulRunsWithoutUsageLog: 0, interruptedRuns: 0, affectedRuns: 1 });
    expect(all.byUser.some((u: { userId: number }) => u.userId === ids.userC)).toBe(false);
    // Global counts are at least this file's users (test.db may hold other files' rows).
    expect(all.affectedRuns).toBeGreaterThanOrEqual(5);
    expect(all.callsWithUnknownUsage).toBeGreaterThanOrEqual(2);
    for (const key of ['callsWithUnknownUsage', 'callsWithUnknownCost', 'successfulRunsWithoutUsageLog', 'interruptedRuns', 'affectedRuns'] as const) {
      expect(all[key]).toBe(all.byUser.reduce((sum: number, u: Record<string, number>) => sum + u[key], 0));
    }

    const drill = await completeness('admin', `?userId=${ids.userA}`);
    expect(drill).toEqual(await completeness('userA'));
    expect(drill.byUser).toBeUndefined();
  });

  it('requires authentication and exposes no CV text or failure text', async () => {
    expect((await request(app).get('/api/analytics/usage-completeness')).status).toBe(401);
    const body = JSON.stringify(await completeness('admin'));
    expect(body).not.toContain(CV_SENTINEL);
    expect(body).not.toMatch(/Interrupted|Service unavailable|simulated/);
  });
});

describe('GET /api/runs - finding the affected runs', () => {
  it('?usage=incomplete lists exactly the affected runs, each with its issues', async () => {
    const res = await request(app).get('/api/runs?usage=incomplete&limit=100').set(as('userA'));
    expect(res.status).toBe(200);
    const issues = Object.fromEntries(res.body.data.runs.map((r: { id: string; usageIssues: string[] }) => [r.id, r.usageIssues]));
    expect(issues).toEqual({
      [runs.unknownUsage]: ['USAGE_UNKNOWN'],
      [runs.unknownCost]: ['COST_UNKNOWN'],
      [runs.unlogged]: ['NO_USAGE_LOGGED'],
      [runs.interrupted]: ['INTERRUPTED'],
    });
    expect(res.body.data.total).toBe((await completeness('userA')).affectedRuns);
  });

  it('every run carries usageIssues; complete runs have none', async () => {
    const all = (await request(app).get('/api/runs?limit=100').set(as('userA'))).body.data.runs as Array<{ id: string; usageIssues: string[] }>;
    expect(all.find(r => r.id === runs.complete)?.usageIssues).toEqual([]);
    expect(all.find(r => r.id === runs.providerFail)?.usageIssues).toEqual([]);
    expect(all.filter(r => r.usageIssues.length > 0)).toHaveLength(4);
  });

  it('stays scoped: users see only their own affected runs; admins can filter by user', async () => {
    const b = (await request(app).get(`/api/runs?usage=incomplete&userId=${ids.userA}`).set(as('userB'))).body.data;
    expect(b.runs.map((r: { id: string }) => r.id)).toEqual([runs.bUnknownUsage]);
    const adminB = (await request(app).get(`/api/runs?usage=incomplete&userId=${ids.userB}`).set(as('admin'))).body.data;
    expect(adminB.runs.map((r: { id: string }) => r.id)).toEqual([runs.bUnknownUsage]);
    const c = (await request(app).get('/api/runs?usage=incomplete').set(as('userC'))).body.data;
    expect(c).toMatchObject({ runs: [], total: 0 });
  });

  it('rejects an unknown usage filter value', async () => {
    for (const value of ['complete', 'INCOMPLETE', '1', '']) {
      expect((await request(app).get(`/api/runs?usage=${value}`).set(as('userA'))).status, value).toBe(400);
    }
  });

  it('never returns token counts, costs or CV text in the listing', async () => {
    const body = JSON.stringify((await request(app).get('/api/runs?usage=incomplete&limit=100').set(as('admin'))).body);
    for (const forbidden of [CV_SENTINEL, 'inputTokens', 'outputTokens', 'estimatedCost', 'errorCode']) expect(body).not.toContain(forbidden);
  });
});
