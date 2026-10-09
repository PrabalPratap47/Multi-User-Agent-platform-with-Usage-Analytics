import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../src/db/client.js';
import { AnalyticsService } from '../src/services/analyticsService.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../src/agents/CVClassificationAgent.js';
import { SENTIMENT_AGENT_NAME } from '../src/agents/SentimentAgent.js';
import { UserPayload } from '../src/types/index.js';

/**
 * Known-fixture test: every expected value below is computed by hand in
 * this file's comments, from fixture rows this test creates itself (not
 * from seed.ts), so the math is independently checkable against the
 * fixtures rather than trusted blindly.
 */

const TEST_USER_EMAIL = 'analytics-test-user@test.local';
let userA: UserPayload;
let cvAgentId: number;
let sentimentAgentId: number;

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: TEST_USER_EMAIL } });
  if (user) {
    await prisma.recommendationDecision.deleteMany({ where: { userId: user.id } });
    await prisma.cvRecommendation.deleteMany({ where: { userId: user.id } });
    await prisma.cvDocument.deleteMany({ where: { userId: user.id } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: user.id } });
    await prisma.agentRun.deleteMany({ where: { userId: user.id } });
  }
  await prisma.user.deleteMany({ where: { email: TEST_USER_EMAIL } });
}

beforeAll(async () => {
  await cleanup();

  const cvAgent = await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const sentimentAgent = await prisma.agent.upsert({
    where: { name: SENTIMENT_AGENT_NAME },
    update: {},
    create: { name: SENTIMENT_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  cvAgentId = cvAgent.id;
  sentimentAgentId = sentimentAgent.id;

  const user = await prisma.user.create({
    data: { email: TEST_USER_EMAIL, password: 'unused-hash', role: 'USER' },
  });
  userA = { id: user.id, email: user.email, role: 'user' };

  // ── Fixture: llm_usage_logs ──────────────────────────────────────
  // Log 1: CV agent, SUCCESS, 100 in / 50 out, cost 0.01, latency 1000ms
  // Log 2: CV agent, ERROR,   200 in / 100 out, cost 0.02, latency 2000ms
  // Log 3: Sentiment agent, SUCCESS, 50 in / 25 out, cost 0.005, latency 500ms
  await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1000,
      status: 'SUCCESS',
      estimatedCost: 0.01,
    },
  });
  await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      model: 'gpt-4o',
      inputTokens: 200,
      outputTokens: 100,
      latencyMs: 2000,
      status: 'ERROR',
      estimatedCost: 0.02,
    },
  });
  await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user.id,
      agentId: sentimentAgentId,
      agentName: SENTIMENT_AGENT_NAME,
      model: 'gpt-4o',
      inputTokens: 50,
      outputTokens: 25,
      latencyMs: 500,
      status: 'SUCCESS',
      estimatedCost: 0.005,
    },
  });
  // A seed-flagged row with deliberately huge numbers - every metric
  // below must NOT include this, or the known-fixture math breaks.
  await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      model: 'gpt-4o',
      inputTokens: 999999,
      outputTokens: 999999,
      latencyMs: 999999,
      status: 'SUCCESS',
      estimatedCost: 999.99,
      isSeedData: true,
    },
  });

  // ── Fixture: agent_runs for run-count windows ────────────────────
  const now = Date.now();
  await prisma.agentRun.create({
    data: {
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      status: 'SUCCESS',
      createdAt: new Date(now), // within 24h, 7d, and 30d
    },
  });
  await prisma.agentRun.create({
    data: {
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      status: 'SUCCESS',
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000), // 10 days ago: within 30d only
    },
  });
  await prisma.agentRun.create({
    data: {
      userId: user.id,
      agentId: cvAgentId,
      agentName: CV_CLASSIFICATION_AGENT_NAME,
      status: 'SUCCESS',
      createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000), // 40 days ago: within none
    },
  });

  // ── Fixture: CV documents/recommendations/decisions for acceptance rate + time saved ─
  // Two "Back-End Developer" recommendations: one ACCEPT, one REJECT -> acceptanceRate 1/2 = 0.5
  // One "Front-End Developer" recommendation: one MODIFY -> acceptanceRate 0/1 = 0
  for (const [category, decisionType] of [
    ['Back-End Developer', 'ACCEPT'],
    ['Back-End Developer', 'REJECT'],
    ['Front-End Developer', 'MODIFY'],
  ] as const) {
    const doc = await prisma.cvDocument.create({
      data: { userId: user.id, content: `Fixture CV content for ${category} ${decisionType}.` },
    });
    const rec = await prisma.cvRecommendation.create({
      data: {
        cvDocumentId: doc.id,
        userId: user.id,
        agentId: cvAgentId,
        primaryCategory: category,
        secondaryCategories: [],
        confidenceScore: 0.9,
        confidenceScores: { [category]: 0.9 },
        rationale: [{ category, evidence: 'fixture' }],
        rawResponse: {},
      },
    });
    await prisma.recommendationDecision.create({
      data: {
        recommendationId: rec.id,
        cvDocumentId: doc.id,
        userId: user.id,
        decisionType,
        finalPrimaryCategory: decisionType === 'REJECT' ? null : category,
        finalSecondaryCategories: [],
        reason: decisionType === 'ACCEPT' ? null : 'fixture reason',
      },
    });
  }
});

afterAll(async () => {
  await cleanup();
});

describe('AnalyticsService.getTokenSummary', () => {
  it('sums exactly the 3 real rows (100+200+50 in, 50+100+25 out), excluding the isSeedData row', async () => {
    const summary = await AnalyticsService.getTokenSummary(userA);
    expect(summary.totalInputTokens).toBe(350);
    expect(summary.totalOutputTokens).toBe(175);
    expect(summary.totalTokens).toBe(525);
    expect(summary.estimatedCost).toBeCloseTo(0.035, 10);
    expect(summary.callCount).toBe(3);
  });
});

describe('AnalyticsService.getTokensByAgent', () => {
  it('breaks down exactly by agent, excluding the isSeedData row', async () => {
    const byAgent = await AnalyticsService.getTokensByAgent(userA);
    const cv = byAgent.find(a => a.agentName === CV_CLASSIFICATION_AGENT_NAME);
    const sentiment = byAgent.find(a => a.agentName === SENTIMENT_AGENT_NAME);

    expect(cv).toMatchObject({ totalInputTokens: 300, totalOutputTokens: 150, callCount: 2 });
    expect(cv!.estimatedCost).toBeCloseTo(0.03, 10);
    expect(sentiment).toMatchObject({ totalInputTokens: 50, totalOutputTokens: 25, callCount: 1 });
  });
});

describe('AnalyticsService.getErrorRateByAgent', () => {
  it('computes 1/2 = 0.5 error rate for the CV agent, 0 for sentiment', async () => {
    const rates = await AnalyticsService.getErrorRateByAgent(userA);
    const cv = rates.find(r => r.agentName === CV_CLASSIFICATION_AGENT_NAME);
    const sentiment = rates.find(r => r.agentName === SENTIMENT_AGENT_NAME);

    expect(cv).toMatchObject({ totalCalls: 2, errorCalls: 1 });
    expect(cv!.errorRate).toBeCloseTo(0.5, 10);
    expect(sentiment).toMatchObject({ totalCalls: 1, errorCalls: 0, errorRate: 0 });
  });
});

describe('AnalyticsService.getAverageLatencyByAgent', () => {
  it('computes the exact average: (1000+2000)/2=1500 for CV agent, 500 for sentiment', async () => {
    const latencies = await AnalyticsService.getAverageLatencyByAgent(userA);
    const cv = latencies.find(l => l.agentName === CV_CLASSIFICATION_AGENT_NAME);
    const sentiment = latencies.find(l => l.agentName === SENTIMENT_AGENT_NAME);

    expect(cv!.averageLatencyMs).toBe(1500);
    expect(sentiment!.averageLatencyMs).toBe(500);
  });
});

describe('AnalyticsService.getAgentRunCounts', () => {
  it('counts exactly 1/1/2 for 24h/7d/30d from the 3 fixture runs', async () => {
    const counts = await AnalyticsService.getAgentRunCounts(userA);
    expect(counts.last24h).toBe(1);
    expect(counts.last7d).toBe(1);
    expect(counts.last30d).toBe(2);
  });
});

describe('AnalyticsService.getAcceptanceRateByCategory', () => {
  it('computes 1/2=0.5 for Back-End Developer (1 ACCEPT, 1 REJECT) and 0/1=0 for Front-End Developer (1 MODIFY)', async () => {
    const rates = await AnalyticsService.getAcceptanceRateByCategory(userA);
    const backend = rates.find(r => r.category === 'Back-End Developer');
    const frontend = rates.find(r => r.category === 'Front-End Developer');

    expect(backend).toMatchObject({ totalDecisions: 2, accept: 1, modify: 0, reject: 1 });
    expect(backend!.acceptanceRate).toBeCloseTo(0.5, 10);

    expect(frontend).toMatchObject({ totalDecisions: 1, accept: 0, modify: 1, reject: 0 });
    expect(frontend!.acceptanceRate).toBe(0);
  });
});

describe('AnalyticsService.getTimeSaved', () => {
  it('computes the documented formula exactly from the 3 completed CVs and the measured 1500ms average CV-agent latency', async () => {
    const estimate = await AnalyticsService.getTimeSaved(userA);

    expect(estimate.methodology).toBe('ESTIMATED');
    expect(estimate.baselineManualReviewMinutesPerCv).toBe(5);
    expect(estimate.completedCvCount).toBe(3);
    expect(estimate.measuredAverageAutomatedLatencyMs).toBe(1500);

    // manualMinutesTotal = 3 * 5 = 15
    // automatedMinutesTotal = (3 * 1500) / 60000 = 0.075
    // estimatedTimeSavedHours = (15 - 0.075) / 60 = 0.24875
    expect(estimate.estimatedTimeSavedHours).toBeCloseTo(0.24875, 10);
  });
});

describe('AnalyticsService - seed demo pipeline records are excluded from run counts, acceptance rate and time saved', () => {
  // Regression (Step 18 E2E): seed.ts flags only llm_usage_logs, so its
  // demo runs, recommendations and decisions were counted as real.
  // Fixture: one demo pipeline exactly as seed.ts writes it (a run whose
  // usage log has isSeedData: true, its recommendation, an ACCEPT) and one
  // real pipeline (same shape, real usage log, a REJECT).
  const SEED_TEST_EMAIL = 'analytics-seed-test-user@test.local';
  let seedTestUser: UserPayload;

  async function cleanupSeedTestUser() {
    const user = await prisma.user.findUnique({ where: { email: SEED_TEST_EMAIL } });
    if (user) {
      await prisma.recommendationDecision.deleteMany({ where: { userId: user.id } });
      await prisma.cvRecommendation.deleteMany({ where: { userId: user.id } });
      await prisma.cvDocument.deleteMany({ where: { userId: user.id } });
      await prisma.llmUsageLog.deleteMany({ where: { userId: user.id } });
      await prisma.agentRun.deleteMany({ where: { userId: user.id } });
    }
    await prisma.user.deleteMany({ where: { email: SEED_TEST_EMAIL } });
  }

  beforeAll(async () => {
    await cleanupSeedTestUser();
    const user = await prisma.user.create({ data: { email: SEED_TEST_EMAIL, password: 'unused-hash', role: 'USER' } });
    seedTestUser = { id: user.id, email: user.email, role: 'user' };

    for (const [kind, decisionType] of [['seed', 'ACCEPT'], ['real', 'REJECT']] as const) {
      const run = await prisma.agentRun.create({
        data: { userId: user.id, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME, status: 'SUCCESS', completedAt: new Date() },
      });
      await prisma.llmUsageLog.create({
        data: {
          timestamp: new Date(),
          runId: run.id,
          userId: user.id,
          agentId: cvAgentId,
          agentName: CV_CLASSIFICATION_AGENT_NAME,
          model: 'gpt-4o',
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: kind === 'seed' ? 9000 : 1200,
          status: 'SUCCESS',
          estimatedCost: 0.001,
          isSeedData: kind === 'seed',
        },
      });
      const doc = await prisma.cvDocument.create({ data: { userId: user.id, content: `Fixture ${kind} CV content.` } });
      const rec = await prisma.cvRecommendation.create({
        data: {
          cvDocumentId: doc.id,
          runId: run.id,
          userId: user.id,
          agentId: cvAgentId,
          primaryCategory: 'Back-End Developer',
          secondaryCategories: [],
          confidenceScore: 0.9,
          confidenceScores: { 'Back-End Developer': 0.9 },
          rationale: [{ category: 'Back-End Developer', evidence: 'fixture' }],
          rawResponse: {},
        },
      });
      await prisma.recommendationDecision.create({
        data: {
          recommendationId: rec.id,
          cvDocumentId: doc.id,
          agentRunId: run.id,
          userId: user.id,
          decisionType,
          finalPrimaryCategory: decisionType === 'REJECT' ? null : 'Back-End Developer',
          finalSecondaryCategories: [],
          reason: decisionType === 'ACCEPT' ? null : 'fixture reason',
        },
      });
    }
  });

  afterAll(async () => {
    await cleanupSeedTestUser();
  });

  it('counts only the real run (1/1/1, 1 successful), not the seed demo run', async () => {
    expect(await AnalyticsService.getAgentRunCounts(seedTestUser)).toEqual({ last24h: 1, last7d: 1, last30d: 1, successful: 1, failed: 0 });
  });

  it('computes acceptance only from the decision on the real recommendation (1 REJECT -> 0), ignoring the seed ACCEPT', async () => {
    const rates = await AnalyticsService.getAcceptanceRateByCategory(seedTestUser);
    expect(rates).toEqual([{ category: 'Back-End Developer', totalDecisions: 1, accept: 0, modify: 0, reject: 1, acceptanceRate: 0 }]);
  });

  it('counts only the real completed CV toward time saved', async () => {
    const estimate = await AnalyticsService.getTimeSaved(seedTestUser);
    expect(estimate.completedCvCount).toBe(1);
    expect(estimate.measuredAverageAutomatedLatencyMs).toBe(1200);
  });
});

describe('AnalyticsService.getAgentRunCounts - successful and failed runs', () => {
  // Fixtures, all created here (expected values derived in the comments):
  //   mixed:       SUCCESS (now), SUCCESS (40 days ago), ERROR, PENDING, RUNNING,
  //                plus one SUCCESS and one ERROR seed demo run (isSeedData usage log)
  //                -> successful 2, failed 1; windows 4/4/4; seed runs excluded
  //   allSuccess:  SUCCESS x2           -> successful 2, failed 0
  //   allFailure:  ERROR x2             -> successful 0, failed 2
  //   noRuns:      nothing              -> all zeros
  const EMAILS = {
    mixed: 'run-outcomes-mixed@test.local',
    allSuccess: 'run-outcomes-success@test.local',
    allFailure: 'run-outcomes-failure@test.local',
    noRuns: 'run-outcomes-none@test.local',
  } as const;
  const users = {} as Record<keyof typeof EMAILS, UserPayload>;

  async function cleanupOutcomeUsers() {
    const rows = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
    const ids = rows.map(r => r.id);
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  async function run(userId: number, status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR', options: { daysAgo?: number; seed?: boolean } = {}) {
    const createdAt = new Date(Date.now() - (options.daysAgo ?? 0) * 24 * 60 * 60 * 1000);
    const created = await prisma.agentRun.create({
      data: { userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME, status, createdAt, startedAt: createdAt },
    });
    if (options.seed) {
      await prisma.llmUsageLog.create({
        data: { timestamp: createdAt, runId: created.id, userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME, model: 'gpt-4o', inputTokens: 1, outputTokens: 1, latencyMs: 1, status: 'SUCCESS', estimatedCost: 0, isSeedData: true },
      });
    }
  }

  beforeAll(async () => {
    await cleanupOutcomeUsers();
    for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      const u = await prisma.user.create({ data: { email: EMAILS[key], password: 'unused-hash', role: 'USER' } });
      users[key] = { id: u.id, email: u.email, role: 'user' };
    }
    await run(users.mixed.id, 'SUCCESS');
    await run(users.mixed.id, 'SUCCESS', { daysAgo: 40 });
    await run(users.mixed.id, 'ERROR');
    await run(users.mixed.id, 'PENDING');
    await run(users.mixed.id, 'RUNNING');
    await run(users.mixed.id, 'SUCCESS', { seed: true });
    await run(users.mixed.id, 'ERROR', { seed: true });
    await run(users.allSuccess.id, 'SUCCESS');
    await run(users.allSuccess.id, 'SUCCESS');
    await run(users.allFailure.id, 'ERROR');
    await run(users.allFailure.id, 'ERROR');
  });

  afterAll(async () => {
    await cleanupOutcomeUsers();
  });

  it('counts SUCCESS and ERROR runs all-time, excludes PENDING/RUNNING from both, and excludes seed demo runs of either status', async () => {
    expect(await AnalyticsService.getAgentRunCounts(users.mixed)).toEqual({ last24h: 4, last7d: 4, last30d: 4, successful: 2, failed: 1 });
  });

  it('all-success and all-failure users', async () => {
    expect(await AnalyticsService.getAgentRunCounts(users.allSuccess)).toMatchObject({ successful: 2, failed: 0 });
    expect(await AnalyticsService.getAgentRunCounts(users.allFailure)).toMatchObject({ successful: 0, failed: 2 });
  });

  it('a user with no runs gets zeros', async () => {
    expect(await AnalyticsService.getAgentRunCounts(users.noRuns)).toEqual({ last24h: 0, last7d: 0, last30d: 0, successful: 0, failed: 0 });
  });

  it("admin global counts equal every eligible (non-seed) run in the database; admin can drill down; a user cannot widen scope", async () => {
    const admin: UserPayload = { id: -1, email: 'admin@test.local', role: 'admin' };
    const notSeed = { llmUsageLogs: { none: { isSeedData: true } } };
    const global = await AnalyticsService.getAgentRunCounts(admin);
    expect(global.successful).toBe(await prisma.agentRun.count({ where: { ...notSeed, status: 'SUCCESS' } }));
    expect(global.failed).toBe(await prisma.agentRun.count({ where: { ...notSeed, status: 'ERROR' } }));
    expect(await AnalyticsService.getAgentRunCounts(admin, users.allFailure.id)).toMatchObject({ successful: 0, failed: 2 });
    expect(await AnalyticsService.getAgentRunCounts(users.allSuccess, users.allFailure.id)).toMatchObject({ successful: 2, failed: 0 });
  });
});

describe('AnalyticsService - user isolation', () => {
  it('a non-admin user scoped query never sees another user\'s data, even if explicitUserId is passed', async () => {
    const otherUser: UserPayload = { id: userA.id + 999999, email: 'nonexistent@test.local', role: 'user' };
    const summary = await AnalyticsService.getTokenSummary(otherUser);
    // This user has no fixture rows at all - summary must be all zeros,
    // never accidentally picking up userA's rows.
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.callCount).toBe(0);
  });

  it('a non-admin passing explicitUserId cannot widen their own scope to another user', async () => {
    // userA is not admin - userScope() must ignore explicitUserId for them.
    const summaryIgnoringParam = await AnalyticsService.getTokenSummary(userA, 999999);
    const summaryWithoutParam = await AnalyticsService.getTokenSummary(userA);
    expect(summaryIgnoringParam).toEqual(summaryWithoutParam);
  });
});
