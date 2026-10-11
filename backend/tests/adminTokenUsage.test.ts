import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../src/agents/CVClassificationAgent.js';
import { SENTIMENT_AGENT_NAME } from '../src/agents/SentimentAgent.js';
import { MISSING_USAGE_ERROR_CODE } from '../src/services/llmService.js';

/**
 * GET /api/analytics/by-user - the data behind the Admin → Users token chart.
 * Known fixture; expected totals are worked out in the comments.
 */

const EMAIL = { a: 'token-chart-a@test.local', b: 'token-chart-b@test.local', c: 'token-chart-c@test.local', admin: 'token-chart-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
const uid = { a: 0, b: 0, c: 0 };

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.externalAgentLog.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.agentRun.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

beforeAll(async () => {
  await cleanup();
  const agent = (name: string) => prisma.agent.upsert({ where: { name }, update: {}, create: { name, description: 'test', version: '1.0.0' } });
  const cvAgent = await agent(CV_CLASSIFICATION_AGENT_NAME);
  const sentimentAgent = await agent(SENTIMENT_AGENT_NAME);
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  uid.a = (await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } })).id;
  uid.b = (await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } })).id;
  uid.c = (await prisma.user.create({ data: { email: EMAIL.c, password, role: 'USER' } })).id; // no usage at all
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });

  const run = (userId: number, a: { id: number; name: string }) => prisma.agentRun.create({ data: { userId, agentId: a.id, agentName: a.name, status: 'SUCCESS' } });
  const log = (userId: number, runId: string | null, a: { id: number; name: string }, inputTokens: number, outputTokens: number, extra: Record<string, unknown> = {}) =>
    prisma.llmUsageLog.create({ data: { timestamp: new Date(), runId, userId, agentId: a.id, agentName: a.name, model: 'gpt-4o', inputTokens, outputTokens, latencyMs: 100, status: 'SUCCESS', estimatedCost: 0.001, ...extra } });

  // User A: CV run 1 = first attempt 100/50 + repair retry 20/10 (two real provider calls, each logged once);
  // CV run 2 = 300/40; a sentiment call whose provider sent no usage (0/0, MISSING_USAGE_DATA);
  // plus a seed demo log (excluded) and an imported external log (separate tables, excluded).
  // Expected: input 100+20+300+0 = 420, output 50+10+40+0 = 100, total 520, 4 calls, 1 with unknown usage.
  const r1 = await run(uid.a, cvAgent);
  await log(uid.a, r1.id, cvAgent, 100, 50);
  await log(uid.a, r1.id, cvAgent, 20, 10);
  await log(uid.a, (await run(uid.a, cvAgent)).id, cvAgent, 300, 40);
  await log(uid.a, (await run(uid.a, sentimentAgent)).id, sentimentAgent, 0, 0, { errorCode: MISSING_USAGE_ERROR_CODE });
  await log(uid.a, null, cvAgent, 99999, 99999, { isSeedData: true });
  await prisma.externalAgentLog.create({
    data: {
      userId: uid.a, sourceAgentName: 'Vendor Bot', fileName: 'x.json', fileFormat: 'json', totalRecords: 1, validRecords: 1, invalidRecords: 0, parseErrors: [],
      records: { create: [{ rawRecord: {}, timestamp: new Date(), agentName: 'Vendor Bot', inputTokens: 5000, outputTokens: 5000, isError: false }] },
    },
  });
  // User B: one sentiment call 7/3 -> total 10.
  await log(uid.b, (await run(uid.b, sentimentAgent)).id, sentimentAgent, 7, 3);

  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

type Row = { userId: number; email: string; totalInputTokens: number; totalOutputTokens: number; totalTokens: number; callCount: number; callsWithUnknownUsage: number };

describe('per-user token totals for the Admin → Users chart', () => {
  it('sums each user’s internal calls by user id: total = input + output, retries and runs aggregated, seed and external logs excluded', async () => {
    const res = await request(app).get('/api/analytics/by-user').set('Authorization', `Bearer ${token.admin}`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Row[];
    expect(rows.find(r => r.userId === uid.a)).toMatchObject({ email: EMAIL.a, totalInputTokens: 420, totalOutputTokens: 100, totalTokens: 520, callCount: 4, callsWithUnknownUsage: 1 });
    expect(rows.find(r => r.userId === uid.b)).toMatchObject({ totalInputTokens: 7, totalOutputTokens: 3, totalTokens: 10, callCount: 1, callsWithUnknownUsage: 0 });
    // No usage rows -> not in the data; the chart shows such users at 0 from the user list.
    expect(rows.find(r => r.userId === uid.c)).toBeUndefined();
    for (const r of rows) expect(r.totalTokens).toBe(r.totalInputTokens + r.totalOutputTokens);
  });

  it('is admin only: regular users get 403 (a userId or role in the request changes nothing), no session gets 401', async () => {
    expect((await request(app).get('/api/analytics/by-user').set('Authorization', `Bearer ${token.a}`)).status).toBe(403);
    expect((await request(app).get(`/api/analytics/by-user?userId=${uid.b}&role=admin`).set('Authorization', `Bearer ${token.b}`)).status).toBe(403);
    expect((await request(app).get('/api/analytics/by-user')).status).toBe(401);
  });

  it('exposes no content: only ids, email and numbers', async () => {
    const rows = (await request(app).get('/api/analytics/by-user').set('Authorization', `Bearer ${token.admin}`)).body.data as Row[];
    expect(Object.keys(rows[0]).sort()).toEqual(['callCount', 'callsWithUnknownUsage', 'email', 'estimatedCost', 'totalInputTokens', 'totalOutputTokens', 'totalTokens', 'userId']);
  });
});
