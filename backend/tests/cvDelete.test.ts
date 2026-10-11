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
 * DELETE /api/cv/documents/:documentId - permanent deletion of one CV.
 * Fixture rows are written directly, shaped like the app writes them: a
 * document, its run with a real (non-seed) usage log, a recommendation and
 * decisions.
 */

const EMAIL = { a: 'cv-delete-user-a@test.local', b: 'cv-delete-user-b@test.local', admin: 'cv-delete-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
let user = { a: {} as UserPayload, b: {} as UserPayload };
let cvAgentId: number;

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

/** A classified CV: document, SUCCESS run, usage log, recommendation, and the given decisions (oldest first). */
async function classifiedCv(userId: number, fileName: string, decisions: Array<'ACCEPT' | 'MODIFY' | 'REJECT'>, runStatus: 'SUCCESS' | 'RUNNING' = 'SUCCESS') {
  const document = await prisma.cvDocument.create({ data: { userId, fileName, content: `Private CV text for ${fileName}.` } });
  const run = await prisma.agentRun.create({
    data: { userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME, cvDocumentId: document.id, status: runStatus, completedAt: runStatus === 'SUCCESS' ? new Date() : null },
  });
  const log = await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(), runId: run.id, userId, agentId: cvAgentId, agentName: CV_CLASSIFICATION_AGENT_NAME,
      model: 'gpt-4o', inputTokens: 700, outputTokens: 120, latencyMs: 900, status: 'SUCCESS', estimatedCost: 0.003,
    },
  });
  const recommendation = await prisma.cvRecommendation.create({
    data: {
      cvDocumentId: document.id, runId: run.id, userId, agentId: cvAgentId, primaryCategory: 'Back-End Developer', secondaryCategories: [],
      confidenceScore: 0.9, confidenceScores: { 'Back-End Developer': 0.9 }, rationale: [{ category: 'Back-End Developer', evidence: 'fixture' }], rawResponse: {},
    },
  });
  for (const [i, type] of decisions.entries()) {
    await prisma.recommendationDecision.create({
      data: {
        recommendationId: recommendation.id, cvDocumentId: document.id, agentRunId: run.id, userId, decisionType: type,
        finalPrimaryCategory: type === 'REJECT' ? null : type === 'MODIFY' ? 'AI Engineer' : 'Back-End Developer',
        finalSecondaryCategories: [], reason: type === 'ACCEPT' ? null : 'fixture reason', timestamp: new Date(Date.now() - 60_000 + i * 1000),
      },
    });
  }
  return { documentId: document.id, runId: run.id, logId: log.id, recommendationId: recommendation.id };
}

const del = (who: keyof typeof token | null, path: string) => {
  const req = request(app).delete(path);
  return who ? req.set('Authorization', `Bearer ${token[who]}`) : req;
};
const exists = async (cv: { documentId: number; recommendationId: number }) => ({
  document: (await prisma.cvDocument.count({ where: { id: cv.documentId } })) === 1,
  recommendation: (await prisma.cvRecommendation.count({ where: { id: cv.recommendationId } })) === 1,
  decisions: await prisma.recommendationDecision.count({ where: { cvDocumentId: cv.documentId } }),
});

beforeAll(async () => {
  await cleanup();
  cvAgentId = (
    await prisma.agent.upsert({
      where: { name: CV_CLASSIFICATION_AGENT_NAME },
      update: {},
      create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
    })
  ).id;
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  const a = await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } });
  const b = await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  user = { a: { id: a.id, email: a.email, role: 'user' }, b: { id: b.id, email: b.email, role: 'user' } };
  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

describe('DELETE /api/cv/documents/:documentId', () => {
  it("lets an admin permanently delete one user's CV, its recommendation and decision history, keeping runs, usage and other CVs", async () => {
    const target = await classifiedCv(user.a.id, 'a-delete-me.txt', ['MODIFY', 'ACCEPT']);
    const ownOther = await classifiedCv(user.a.id, 'a-keep.txt', ['REJECT']);
    const otherUser = await classifiedCv(user.b.id, 'b-keep.txt', ['ACCEPT']);
    const tokensBefore = await AnalyticsService.getTokenSummary(user.a);
    const runsBefore = await AnalyticsService.getAgentRunCounts(user.a);
    const logBefore = await prisma.llmUsageLog.findUniqueOrThrow({ where: { id: target.logId } });

    const res = await del('admin', `/api/cv/documents/${target.documentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ documentId: target.documentId, deletedRecommendations: 1, deletedDecisions: 2, keptAgentRuns: 1 });

    expect(await exists(target)).toEqual({ document: false, recommendation: false, decisions: 0 });
    // The run and its usage log stay, unchanged except that the run no longer points at the deleted CV.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: target.runId } });
    expect(run).toMatchObject({ status: 'SUCCESS', cvDocumentId: null });
    expect(await prisma.llmUsageLog.findUniqueOrThrow({ where: { id: target.logId } })).toEqual(logBefore);
    expect(await AnalyticsService.getTokenSummary(user.a)).toEqual(tokensBefore);
    expect(await AnalyticsService.getAgentRunCounts(user.a)).toEqual(runsBefore);

    // Every other CV, with its decision history, is untouched.
    expect(await exists(ownOther)).toEqual({ document: true, recommendation: true, decisions: 1 });
    expect(await exists(otherUser)).toEqual({ document: true, recommendation: true, decisions: 1 });

    // The API no longer returns it.
    expect((await request(app).get(`/api/cv/results/${target.recommendationId}`).set('Authorization', `Bearer ${token.a}`)).status).toBe(404);
    const list = (await request(app).get('/api/cv/results').set('Authorization', `Bearer ${token.a}`)).body.data as Array<{ id: number }>;
    expect(list.map(r => r.id)).toContain(ownOther.recommendationId);
    expect(list.map(r => r.id)).not.toContain(target.recommendationId);
  });

  it('refuses every regular user with 403 - the owner included - and deletes nothing, even with a spoofed userId', async () => {
    const victim = await classifiedCv(user.a.id, 'a-victim.txt', ['ACCEPT']);
    const own = await del('a', `/api/cv/documents/${victim.documentId}`);
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/Admin access required/);
    expect((await del('b', `/api/cv/documents/${victim.documentId}`)).status).toBe(403);
    expect((await del('b', `/api/cv/documents/${victim.documentId}?userId=${user.a.id}`).send({ userId: user.a.id })).status).toBe(403);
    expect(await exists(victim)).toEqual({ document: true, recommendation: true, decisions: 1 });
  });

  it('fails safely without a session, for unknown or invalid ids, and while the CV is still processing', async () => {
    const cv = await classifiedCv(user.a.id, 'a-guarded.txt', ['ACCEPT']);
    expect((await del(null, `/api/cv/documents/${cv.documentId}`)).status).toBe(401);
    // A regular user is refused before any lookup, so they cannot even probe which ids exist.
    expect((await del('a', '/api/cv/documents/999999999')).status).toBe(403);
    expect((await del('admin', '/api/cv/documents/999999999')).status).toBe(404);
    expect((await del('admin', '/api/cv/documents/not-a-number')).status).toBe(400);
    expect(await exists(cv)).toEqual({ document: true, recommendation: true, decisions: 1 });

    const processing = await classifiedCv(user.a.id, 'a-processing.txt', [], 'RUNNING');
    const res = await del('admin', `/api/cv/documents/${processing.documentId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still being processed/);
    expect(await exists(processing)).toEqual({ document: true, recommendation: true, decisions: 0 });
  });

  it("lets an admin delete another user's CV too, leaving that user's other CVs", async () => {
    const cv = await classifiedCv(user.b.id, 'b-admin-delete.txt', ['MODIFY']);
    const keep = await classifiedCv(user.b.id, 'b-admin-keep.txt', ['ACCEPT']);
    expect((await del('admin', `/api/cv/documents/${cv.documentId}`)).status).toBe(200);
    expect(await exists(cv)).toEqual({ document: false, recommendation: false, decisions: 0 });
    expect(await exists(keep)).toEqual({ document: true, recommendation: true, decisions: 1 });
  });
});
