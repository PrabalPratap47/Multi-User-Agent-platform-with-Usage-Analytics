import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { SENTIMENT_AGENT_NAME } from '../src/agents/SentimentAgent.js';

/**
 * DELETE /api/sentiment/results/:id. Fixture rows are written directly,
 * shaped like the app writes them (run + usage log + result), so no AI is called.
 */

const EMAIL = { a: 'sentiment-delete-a@test.local', b: 'sentiment-delete-b@test.local', admin: 'sentiment-delete-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
const uid = { a: 0, b: 0 };
let agentId = 0;

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.sentimentResult.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.agentRun.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

async function review(userId: number, sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE') {
  const run = await prisma.agentRun.create({ data: { userId, agentId, agentName: SENTIMENT_AGENT_NAME, status: 'SUCCESS', completedAt: new Date() } });
  const log = await prisma.llmUsageLog.create({
    data: { timestamp: new Date(), runId: run.id, userId, agentId, agentName: SENTIMENT_AGENT_NAME, model: 'gpt-4o', inputTokens: 210, outputTokens: 40, latencyMs: 500, status: 'SUCCESS', estimatedCost: 0.001 },
  });
  const result = await prisma.sentimentResult.create({
    data: { runId: run.id, userId, agentId, inputText: `Fixture feedback (${sentiment}).`, sentiment, confidence: 0.9, rationale: 'fixture', rawResponse: {} },
  });
  return { id: result.id, runId: run.id, logId: log.id };
}

const call = (method: 'get' | 'delete', who: keyof typeof token | null, path: string) => {
  const req = request(app)[method](path);
  return who ? req.set('Authorization', `Bearer ${token[who]}`) : req;
};
const listIds = async (who: keyof typeof token) => ((await call('get', who, '/api/sentiment/results')).body.data as Array<{ id: number }>).map(r => r.id);

beforeAll(async () => {
  await cleanup();
  agentId = (
    await prisma.agent.upsert({ where: { name: SENTIMENT_AGENT_NAME }, update: {}, create: { name: SENTIMENT_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' } })
  ).id;
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  uid.a = (await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } })).id;
  uid.b = (await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } })).id;
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

describe('DELETE /api/sentiment/results/:id', () => {
  it("lets an admin delete a user's review: gone from the user's list and counts for good, run and usage log kept", async () => {
    const target = await review(uid.a, 'NEGATIVE');
    const keep = await review(uid.a, 'POSITIVE');
    const other = await review(uid.b, 'NEGATIVE');
    const logBefore = await prisma.llmUsageLog.findUniqueOrThrow({ where: { id: target.logId } });

    const res = await call('delete', 'admin', `/api/sentiment/results/${target.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: target.id });

    // A later list request (what a page refresh does) no longer returns it; the chart counts come from this list.
    const ids = await listIds('a');
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(target.id);
    expect((await call('get', 'a', `/api/sentiment/results/${target.id}`)).status).toBe(404);
    expect(await prisma.sentimentResult.count({ where: { userId: uid.a, sentiment: 'NEGATIVE' } })).toBe(0);

    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: target.runId } })).toMatchObject({ status: 'SUCCESS' });
    expect(await prisma.llmUsageLog.findUniqueOrThrow({ where: { id: target.logId } })).toEqual(logBefore);
    expect(await prisma.sentimentResult.count({ where: { id: other.id } })).toBe(1);
  });

  it('refuses every regular user with 403 - the owner included (a userId in the request changes nothing) - and deletes nothing', async () => {
    const victim = await review(uid.a, 'NEUTRAL');
    const own = await call('delete', 'a', `/api/sentiment/results/${victim.id}`);
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/Admin access required/);
    expect((await call('delete', 'b', `/api/sentiment/results/${victim.id}`)).status).toBe(403);
    expect((await call('delete', 'b', `/api/sentiment/results/${victim.id}?userId=${uid.a}`).send({ userId: uid.a })).status).toBe(403);
    expect(await prisma.sentimentResult.count({ where: { id: victim.id } })).toBe(1);
  });

  it('fails safely without a session and for unknown or invalid ids; an admin may delete any review', async () => {
    const cv = await review(uid.b, 'POSITIVE');
    expect((await call('delete', null, `/api/sentiment/results/${cv.id}`)).status).toBe(401);
    expect((await call('delete', 'a', '/api/sentiment/results/999999999')).status).toBe(403);
    expect((await call('delete', 'admin', '/api/sentiment/results/999999999')).status).toBe(404);
    expect((await call('delete', 'admin', '/api/sentiment/results/abc')).status).toBe(400);
    expect(await prisma.sentimentResult.count({ where: { id: cv.id } })).toBe(1);

    expect((await call('delete', 'admin', `/api/sentiment/results/${cv.id}`)).status).toBe(200);
    expect(await listIds('b')).not.toContain(cv.id);
  });
});
