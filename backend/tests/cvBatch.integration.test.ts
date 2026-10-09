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
import { LLMService, type LLMProviderClient, type LLMProviderResponse } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const EMAILS = {
  userA: 'cv-batch-user-a@test.local',
  userB: 'cv-batch-user-b@test.local',
} as const;

const GENERIC_CV_CONTENT = '5 years of experience with Node.js and Express building backend APIs.';

async function cleanup() {
  const emails = Object.values(EMAILS);
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map(u => u.id);

  if (userIds.length > 0) {
    await prisma.recommendationDecision.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });

  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  await prisma.user.create({ data: { email: EMAILS.userA, password: passwordHash, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAILS.userB, password: passwordHash, role: 'USER' } });
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

function mockClient(impl: () => Promise<LLMProviderResponse>): LLMProviderClient {
  return { messages: { create: impl } };
}

function alwaysSucceedsAgent(): CVClassificationAgent {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence['Back-End Developer'] = 0.9;

  return new CVClassificationAgent(
    new LLMService(
      mockClient(async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              primaryCategory: 'Back-End Developer',
              secondaryCategories: [],
              confidence,
              rationale: [
                { category: 'Back-End Developer', evidence: '5 years of experience with Node.js and Express.' },
              ],
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }))
    )
  );
}

async function waitForBatchCompletion(batchId: string, expectedTotal: number, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await prisma.agentRun.findMany({ where: { batchId } });
    if (runs.length === expectedTotal && runs.every(r => r.status === 'SUCCESS' || r.status === 'ERROR')) {
      return runs;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Batch ${batchId} did not reach a terminal state within ${timeoutMs}ms`);
}

describe('Batch CV processing - single and multiple files', () => {
  it('processes 1 CV end to end', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ files: [{ fileName: 'cv1.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] });

    expect(submitRes.status).toBe(202);
    expect(submitRes.body.data.totalCount).toBe(1);
    const batchId = submitRes.body.data.batchId;

    await waitForBatchCompletion(batchId, 1);

    const statusRes = await request(app)
      .get(`/api/cv/batch/${batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data).toMatchObject({ total: 1, completed: 1, failed: 0, percentage: 100 });
  });

  it('processes 3 CVs independently, each with its own run, usage log, and result', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        files: [
          { fileName: 'cv1.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
          { fileName: 'cv2.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
          { fileName: 'cv3.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
        ],
      });

    expect(submitRes.status).toBe(202);
    expect(submitRes.body.data.totalCount).toBe(3);
    const batchId = submitRes.body.data.batchId;

    const runs = await waitForBatchCompletion(batchId, 3);
    expect(runs.every(r => r.status === 'SUCCESS')).toBe(true);

    // Each CV has its own run ID (distinct UUIDs).
    expect(new Set(runs.map(r => r.id)).size).toBe(3);

    // Each has its own usage log row.
    const logs = await prisma.llmUsageLog.findMany({ where: { runId: { in: runs.map(r => r.id) } } });
    expect(logs).toHaveLength(3);

    // Each has its own recommendation.
    const recs = await prisma.cvRecommendation.findMany({ where: { runId: { in: runs.map(r => r.id) } } });
    expect(recs).toHaveLength(3);

    const statusRes = await request(app)
      .get(`/api/cv/batch/${batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(statusRes.body.data).toMatchObject({ total: 3, completed: 3, failed: 0, percentage: 100 });
  });
});

describe('Batch CV processing - partial failure and invalid files', () => {
  it('a bad file type fails only that file, while valid files in the same batch complete', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        files: [
          { fileName: 'good1.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
          { fileName: 'bad.pdf', mimeType: 'application/pdf', content: GENERIC_CV_CONTENT },
          { fileName: 'good2.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
        ],
      });

    expect(submitRes.status).toBe(202);
    const batchId = submitRes.body.data.batchId;

    const runs = await waitForBatchCompletion(batchId, 3);
    expect(runs.filter(r => r.status === 'SUCCESS')).toHaveLength(2);
    expect(runs.filter(r => r.status === 'ERROR')).toHaveLength(1);

    const statusRes = await request(app)
      .get(`/api/cv/batch/${batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(statusRes.body.data).toMatchObject({ total: 3, completed: 2, failed: 1, percentage: 100 });
  });

  it('reports each file\'s own state, result id and a safe failure reason in batch status', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        files: [
          { fileName: 'good.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT },
          { fileName: 'scan.pdf', mimeType: 'application/pdf', content: GENERIC_CV_CONTENT },
        ],
      });
    const batchId = submitRes.body.data.batchId;
    await waitForBatchCompletion(batchId, 2);

    const statusRes = await request(app)
      .get(`/api/cv/batch/${batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);
    const items = statusRes.body.data.items as Array<Record<string, unknown>>;

    expect(items).toHaveLength(2);
    const good = items.find(i => i.fileName === 'good.txt')!;
    const bad = items.find(i => i.fileName === 'scan.pdf')!;

    expect(good).toMatchObject({ state: 'completed', error: null });
    const rec = await prisma.cvRecommendation.findUnique({ where: { id: good.recommendationId as number } });
    expect(rec?.cvDocumentId).toBe(good.documentId);

    expect(bad).toMatchObject({ state: 'failed', recommendationId: null });
    expect(bad.error).toMatch(/Unsupported file type "application\/pdf"/);
  });

  it('records a generic, safe reason (no model output) when the AI response fails validation', async () => {
    __setCvClassificationAgentForTesting(
      new CVClassificationAgent(
        new LLMService(
          mockClient(async () => ({
            content: [{ type: 'text', text: 'not json - SECRET MODEL OUTPUT' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }))
        )
      )
    );
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ files: [{ fileName: 'cv.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] });
    await waitForBatchCompletion(submitRes.body.data.batchId, 1);

    const statusRes = await request(app)
      .get(`/api/cv/batch/${submitRes.body.data.batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);
    const [item] = statusRes.body.data.items;

    expect(item.state).toBe('failed');
    expect(item.error).toBe('The AI response did not pass validation, even after one automatic retry.');
    expect(JSON.stringify(statusRes.body)).not.toContain('SECRET MODEL OUTPUT');
  });

  it('rejects an invalid batch request (empty files array) at the request level', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ files: [] });

    expect(res.status).toBe(400);
  });

  it('content that is too short to be a CV fails only that file', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);

    const submitRes = await request(app)
      .post('/api/cv/batch')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ files: [{ fileName: 'tooshort.txt', mimeType: 'text/plain', content: 'hi' }] });

    expect(submitRes.status).toBe(202);
    const batchId = submitRes.body.data.batchId;

    const runs = await waitForBatchCompletion(batchId, 1);
    expect(runs[0].status).toBe('ERROR');
  });
});

describe('Batch CV processing - duplicate upload', () => {
  it('submitting the identical files twice creates two independent batches, each processed correctly', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken } = await loginAs(EMAILS.userA);
    const payload = { files: [{ fileName: 'dup.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] };

    const first = await request(app).post('/api/cv/batch').set('Authorization', `Bearer ${accessToken}`).send(payload);
    const second = await request(app).post('/api/cv/batch').set('Authorization', `Bearer ${accessToken}`).send(payload);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.data.batchId).not.toBe(second.body.data.batchId);

    await waitForBatchCompletion(first.body.data.batchId, 1);
    await waitForBatchCompletion(second.body.data.batchId, 1);

    const firstStatus = await request(app)
      .get(`/api/cv/batch/${first.body.data.batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);
    const secondStatus = await request(app)
      .get(`/api/cv/batch/${second.body.data.batchId}/status`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(firstStatus.body.data.completed).toBe(1);
    expect(secondStatus.body.data.completed).toBe(1);
  });
});

describe('Batch CV processing - concurrency and authorization', () => {
  it('two different users submitting batches concurrently never mix identities or results', async () => {
    __setCvClassificationAgentForTesting(alwaysSucceedsAgent());
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const { accessToken: tokenB } = await loginAs(EMAILS.userB);

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/cv/batch')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ files: [{ fileName: 'a1.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] }),
      request(app)
        .post('/api/cv/batch')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ files: [{ fileName: 'b1.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] }),
    ]);

    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    const batchIdA = resA.body.data.batchId;
    const batchIdB = resB.body.data.batchId;
    expect(batchIdA).not.toBe(batchIdB);

    await waitForBatchCompletion(batchIdA, 1);
    await waitForBatchCompletion(batchIdB, 1);

    const runsA = await prisma.agentRun.findMany({ where: { batchId: batchIdA } });
    const runsB = await prisma.agentRun.findMany({ where: { batchId: batchIdB } });

    const userA = await prisma.user.findUnique({ where: { email: EMAILS.userA } });
    const userB = await prisma.user.findUnique({ where: { email: EMAILS.userB } });

    expect(runsA.every(r => r.userId === userA!.id)).toBe(true);
    expect(runsB.every(r => r.userId === userB!.id)).toBe(true);

    // User B's batch must be completely invisible to user A's status query.
    const crossRes = await request(app)
      .get(`/api/cv/batch/${batchIdB}/status`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(crossRes.status).toBe(403);
  });

  it('rejects an unauthenticated batch submission', async () => {
    const res = await request(app)
      .post('/api/cv/batch')
      .send({ files: [{ fileName: 'x.txt', mimeType: 'text/plain', content: GENERIC_CV_CONTENT }] });
    expect(res.status).toBe(401);
  });
});
