import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { AnalyticsService } from '../src/services/analyticsService.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../src/agents/CVClassificationAgent.js';
import { UserPayload } from '../src/types/index.js';

/**
 * Metric 10b (GET /api/analytics/final-categories): original AI
 * recommendation vs final category, one count per decided CV by its latest
 * decision. Known fixture; expected values are worked out in the comments.
 */

const EMAIL = {
  a: 'final-category-user-a@test.local',
  b: 'final-category-user-b@test.local',
  admin: 'final-category-admin@test.local',
} as const;

type Decision = { type: 'ACCEPT' } | { type: 'MODIFY'; final: string } | { type: 'REJECT' };

let userA: UserPayload;
let userB: UserPayload;
let cvAgentId: number;
const token = { a: '', b: '', admin: '' };

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.recommendationDecision.deleteMany({ where: { userId } });
  await prisma.cvRecommendation.deleteMany({ where: { userId } });
  await prisma.cvDocument.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.agentRun.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

/** One CV with its original recommendation and decisions in order (oldest first), as the app writes them. */
async function addCv(userId: number, category: string, decisions: Decision[], seed = false) {
  let runId: string | undefined;
  if (seed) {
    // A seed demo pipeline: identified by its usage log's isSeedData flag.
    const run = await prisma.agentRun.create({
      data: { userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME, status: 'SUCCESS', completedAt: new Date() },
    });
    runId = run.id;
    await prisma.llmUsageLog.create({
      data: {
        timestamp: new Date(), runId, userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME,
        model: 'gpt-4o', inputTokens: 1, outputTokens: 1, latencyMs: 1, status: 'SUCCESS', estimatedCost: 0, isSeedData: true,
      },
    });
  }
  const doc = await prisma.cvDocument.create({ data: { userId, content: `Fixture CV for ${category}.` } });
  const rec = await prisma.cvRecommendation.create({
    data: {
      cvDocumentId: doc.id, runId, userId, agentId: cvAgentId, primaryCategory: category, secondaryCategories: [],
      confidenceScore: 0.9, confidenceScores: { [category]: 0.9 }, rationale: [{ category, evidence: 'fixture' }], rawResponse: {},
    },
  });
  const start = Date.now() - 60_000;
  for (const [i, d] of decisions.entries()) {
    await prisma.recommendationDecision.create({
      data: {
        recommendationId: rec.id, cvDocumentId: doc.id, agentRunId: runId, userId, decisionType: d.type,
        finalPrimaryCategory: d.type === 'REJECT' ? null : d.type === 'MODIFY' ? d.final : category,
        finalSecondaryCategories: [],
        reason: d.type === 'ACCEPT' ? null : 'fixture reason',
        timestamp: new Date(start + i * 1000),
      },
    });
  }
}

// User A: 7 CVs.
//  1. Front-End Developer  MODIFY -> AI Engineer           final AI Engineer
//  2. Back-End Developer   ACCEPT                           final Back-End Developer
//  3. Web Automation       REJECT                           rejected
//  4. Front-End Developer  MODIFY -> AI Engineer, ACCEPT    final Front-End Developer (latest only)
//  5. Back-End Developer   no decision                      not counted
//  6. Front-End Developer  ACCEPT, seed demo data           not counted
//  7. Mobile Automation    ACCEPT, REJECT                   rejected (latest only)
// decided = 1,2,3,4,7 = 5; rejected = 3,7 = 2; 5 originals = 3 finals + 2 rejected.
// Latest decisions: CV 1 MODIFY, 2 ACCEPT, 3 REJECT, 4 ACCEPT, 7 REJECT -> 2 accepted, 1 modified, 2 rejected.
const EXPECTED_A = {
  decidedCvCount: 5,
  acceptedCount: 2,
  modifiedCount: 1,
  rejectedCount: 2,
  categories: [
    { category: 'AI Engineer', originalCount: 0, finalCount: 1 },
    { category: 'Back-End Developer', originalCount: 1, finalCount: 1 },
    { category: 'Front-End Developer', originalCount: 2, finalCount: 1 },
    { category: 'Mobile Automation', originalCount: 1, finalCount: 0 },
    { category: 'Web Automation', originalCount: 1, finalCount: 0 },
  ],
};
// User B: 1 CV. Back-End Developer MODIFY -> DCS.
const EXPECTED_B = {
  decidedCvCount: 1,
  acceptedCount: 0,
  modifiedCount: 1,
  rejectedCount: 0,
  categories: [
    { category: 'Back-End Developer', originalCount: 1, finalCount: 0 },
    { category: 'DCS', originalCount: 0, finalCount: 1 },
  ],
};

beforeAll(async () => {
  await cleanup();
  const cvAgent = await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  cvAgentId = cvAgent.id;

  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  const a = await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } });
  const b = await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  userA = { id: a.id, email: a.email, role: 'user' };
  userB = { id: b.id, email: b.email, role: 'user' };

  await addCv(a.id, 'Front-End Developer', [{ type: 'MODIFY', final: 'AI Engineer' }]);
  await addCv(a.id, 'Back-End Developer', [{ type: 'ACCEPT' }]);
  await addCv(a.id, 'Web Automation', [{ type: 'REJECT' }]);
  await addCv(a.id, 'Front-End Developer', [{ type: 'MODIFY', final: 'AI Engineer' }, { type: 'ACCEPT' }]);
  await addCv(a.id, 'Back-End Developer', []);
  await addCv(a.id, 'Front-End Developer', [{ type: 'ACCEPT' }], true);
  await addCv(a.id, 'Mobile Automation', [{ type: 'ACCEPT' }, { type: 'REJECT' }]);
  await addCv(b.id, 'Back-End Developer', [{ type: 'MODIFY', final: 'DCS' }]);

  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

const get = (who: keyof typeof token, path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token[who]}`);

describe('AnalyticsService.getFinalCategoryBreakdown', () => {
  it('counts each decided CV once by its latest decision, original vs final, never a REJECT as a final category', async () => {
    expect(await AnalyticsService.getFinalCategoryBreakdown(userA)).toEqual(EXPECTED_A);
    expect(await AnalyticsService.getFinalCategoryBreakdown(userB)).toEqual(EXPECTED_B);
  });

  it('leaves metric 10 as it was: acceptance still counts every decision row by the original category', async () => {
    const rates = await AnalyticsService.getAcceptanceRateByCategory(userA);
    // Front-End Developer: CV 1 MODIFY, CV 4 MODIFY + ACCEPT (the seed ACCEPT is excluded).
    expect(rates.find(r => r.category === 'Front-End Developer')).toMatchObject({ totalDecisions: 3, accept: 1, modify: 2, reject: 0 });
    expect(rates.find(r => r.category === 'AI Engineer')).toBeUndefined();
  });
});

describe('GET /api/analytics/final-categories', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/analytics/final-categories')).status).toBe(401);
  });

  it("returns only the caller's own CVs to a regular user, ignoring ?userId=", async () => {
    const own = await get('a', '/api/analytics/final-categories');
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual(EXPECTED_A);
    expect((await get('b', '/api/analytics/final-categories')).body.data).toEqual(EXPECTED_B);
    expect((await get('a', `/api/analytics/final-categories?userId=${userB.id}`)).body.data).toEqual(EXPECTED_A);
  });

  it("lets an admin see one user's CVs with ?userId=, and every user's without it", async () => {
    expect((await get('admin', `/api/analytics/final-categories?userId=${userA.id}`)).body.data).toEqual(EXPECTED_A);
    expect((await get('admin', `/api/analytics/final-categories?userId=${userB.id}`)).body.data).toEqual(EXPECTED_B);

    const all = (await get('admin', '/api/analytics/final-categories')).body.data as typeof EXPECTED_A;
    expect(all.decidedCvCount).toBeGreaterThanOrEqual(EXPECTED_A.decidedCvCount + EXPECTED_B.decidedCvCount);
    expect(all.categories.find(c => c.category === 'DCS')!.finalCount).toBeGreaterThanOrEqual(1);
    const sum = (key: 'originalCount' | 'finalCount') => all.categories.reduce((s, c) => s + c[key], 0);
    expect(sum('originalCount')).toBe(all.decidedCvCount);
    expect(sum('finalCount') + all.rejectedCount).toBe(all.decidedCvCount);
    expect(all.acceptedCount + all.modifiedCount + all.rejectedCount).toBe(all.decidedCvCount);
  });
});
