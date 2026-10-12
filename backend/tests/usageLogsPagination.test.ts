import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../src/agents/CVClassificationAgent.js';

/**
 * GET /api/usage-logs paging (the MY RECORDS tab): ?limit= / ?offset=,
 * newest first, meta.total over the caller's whole scope. Without the
 * parameters the response is unchanged (the newest 500 rows, data an array).
 */

const EMAIL = { a: 'usage-pages-a@test.local', b: 'usage-pages-b@test.local', admin: 'usage-pages-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
const uid = { a: 0, b: 0 };
const A_ROWS = 30; // more than one 25-row page
const B_ROWS = 3;

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

beforeAll(async () => {
  await cleanup();
  const agent = await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'test', version: '1.0.0' },
  });
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  uid.a = (await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } })).id;
  uid.b = (await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } })).id;
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });

  // inputTokens = 1..N with createdAt one second apart, so the newest row has the highest value.
  const base = Date.now() - 10 * 60 * 1000;
  const rows = (userId: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: new Date(base + i * 1000),
      createdAt: new Date(base + i * 1000),
      userId,
      agentId: agent.id,
      agentName: agent.name,
      model: 'gpt-4o',
      inputTokens: i + 1,
      outputTokens: 1,
      latencyMs: 100,
      status: 'SUCCESS' as const,
      estimatedCost: 0.0001,
    }));
  await prisma.llmUsageLog.createMany({ data: [...rows(uid.a, A_ROWS), ...rows(uid.b, B_ROWS)] });

  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

const get = (t: string, query = '') => request(app).get(`/api/usage-logs${query}`).set('Authorization', `Bearer ${t}`);

describe('GET /api/usage-logs paging', () => {
  it('returns one page newest first, the next page continues without overlap, and meta.total covers the whole scope', async () => {
    const first = await get(token.a, '?limit=25&offset=0');
    expect(first.status).toBe(200);
    expect(first.body.meta).toEqual({ total: A_ROWS, limit: 25, offset: 0 });
    expect(first.body.data).toHaveLength(25);
    expect(first.body.data.map((r: { inputTokens: number }) => r.inputTokens)).toEqual(Array.from({ length: 25 }, (_, i) => A_ROWS - i)); // 30..6

    const second = await get(token.a, '?limit=25&offset=25');
    expect(second.body.meta).toEqual({ total: A_ROWS, limit: 25, offset: 25 });
    expect(second.body.data.map((r: { inputTokens: number }) => r.inputTokens)).toEqual([5, 4, 3, 2, 1]);

    const ids = [...first.body.data, ...second.body.data].map((r: { id: number }) => r.id);
    expect(new Set(ids).size).toBe(A_ROWS);

    const past = await get(token.a, '?limit=25&offset=50');
    expect(past.status).toBe(200);
    expect(past.body.data).toEqual([]);
    expect(past.body.meta.total).toBe(A_ROWS);
  });

  it("a regular user's pages and total stay their own, even with ?userId= of another user", async () => {
    const res = await get(token.b, `?limit=25&offset=0&userId=${uid.a}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(B_ROWS);
    expect(res.body.data.every((r: { userId: number }) => r.userId === uid.b)).toBe(true);
  });

  it("an admin's total covers every user, and ?userId= narrows both the page and the total", async () => {
    const all = await get(token.admin, '?limit=10&offset=0');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(await prisma.llmUsageLog.count());
    expect(all.body.data).toHaveLength(10);

    const one = await get(token.admin, `?limit=10&offset=0&userId=${uid.a}`);
    expect(one.body.meta.total).toBe(A_ROWS);
    expect(one.body.data.every((r: { userId: number }) => r.userId === uid.a)).toBe(true);
  });

  it('without limit/offset the original response is unchanged: data is an array of up to 500 rows, newest first', async () => {
    const res = await get(token.a);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(A_ROWS);
    expect(res.body.data[0].inputTokens).toBe(A_ROWS);
    expect(res.body.meta).toEqual({ total: A_ROWS, limit: 500, offset: 0 });
  });

  it('rejects invalid paging values with 400 and returns no rows', async () => {
    for (const query of ['?limit=0', '?limit=501', '?limit=abc', '?limit=1e2', '?limit=-1', '?offset=-1', '?offset=1.5', '?offset=99999999', '?limit=5&limit=6']) {
      const res = await get(token.a, query);
      expect(res.status, query).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    }
  });

  it('still requires authentication', async () => {
    const res = await request(app).get('/api/usage-logs?limit=25&offset=0');
    expect(res.status).toBe(401);
  });
});
