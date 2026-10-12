import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { CV_CLASSIFICATION_AGENT_NAME } from '../src/agents/CVClassificationAgent.js';

/**
 * AGENT RUNS after an admin deletes (deactivates) a user: that user's runs are
 * no longer listed or readable, while the run rows themselves are kept, so the
 * run-count analytics are unchanged.
 */

const EMAIL = {
  admin: 'runs-deleted-admin@test.local',
  kept: 'runs-deleted-kept@test.local',
  gone: 'runs-deleted-gone@test.local',
} as const;
const token = { admin: '', kept: '' };
const uid = { kept: 0, gone: 0 };
const KEPT_RUNS = 2;
const GONE_RUNS = 3;
let goneRunId = '';

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.agentRun.deleteMany({ where: { userId } });
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
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  uid.kept = (await prisma.user.create({ data: { email: EMAIL.kept, password, role: 'USER' } })).id;
  uid.gone = (await prisma.user.create({ data: { email: EMAIL.gone, password, role: 'USER' } })).id;

  const run = (userId: number, status: 'SUCCESS' | 'ERROR') =>
    prisma.agentRun.create({ data: { userId, agentId: agent.id, agentName: agent.name, status, completedAt: new Date() } });
  for (let i = 0; i < KEPT_RUNS; i++) await run(uid.kept, 'SUCCESS');
  for (let i = 0; i < GONE_RUNS; i++) goneRunId = (await run(uid.gone, i === 0 ? 'ERROR' : 'SUCCESS')).id;

  token.admin = (await loginAs(EMAIL.admin)).accessToken;
  token.kept = (await loginAs(EMAIL.kept)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

const asAdmin = (path: string) => request(app).get(path).set('Authorization', `Bearer ${token.admin}`);

describe('AGENT RUNS after a user is deleted', () => {
  it("before the delete, the admin sees the user's runs", async () => {
    const res = await asAdmin(`/api/runs?userId=${uid.gone}&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(GONE_RUNS);
    expect((await asAdmin(`/api/runs/${goneRunId}`)).status).toBe(200);
  });

  it("after the delete, the user's runs are gone from the list, its total, the filters and the details", async () => {
    const before = await asAdmin('/api/runs?limit=100');
    const runCountsBefore = (await asAdmin('/api/analytics/runs')).body.data;

    const del = await request(app).delete(`/api/users/${uid.gone}`).set('Authorization', `Bearer ${token.admin}`);
    expect(del.status).toBe(200);

    const after = await asAdmin('/api/runs?limit=100');
    expect(after.status).toBe(200);
    expect(after.body.data.total).toBe(before.body.data.total - GONE_RUNS);
    expect(after.body.data.runs.some((r: { user: { id: number } }) => r.user.id === uid.gone)).toBe(false);

    // Every filter combination applies the same rule.
    const own = await asAdmin(`/api/runs?userId=${uid.gone}&limit=100`);
    expect(own.body.data.total).toBe(0);
    expect(own.body.data.runs).toEqual([]);
    expect((await asAdmin(`/api/runs?userId=${uid.gone}&status=ERROR`)).body.data.total).toBe(0);
    expect((await asAdmin(`/api/runs?userId=${uid.gone}&agent=${encodeURIComponent(CV_CLASSIFICATION_AGENT_NAME)}`)).body.data.total).toBe(0);

    // A direct link to one of the runs reads as not found.
    const detail = await asAdmin(`/api/runs/${goneRunId}`);
    expect(detail.status).toBe(404);
    expect(JSON.stringify(detail.body)).not.toContain(EMAIL.gone);

    // The rows are kept (soft delete): run-count analytics do not change.
    expect(await prisma.agentRun.count({ where: { userId: uid.gone } })).toBe(GONE_RUNS);
    expect((await asAdmin('/api/analytics/runs')).body.data).toEqual(runCountsBefore);
  });

  it("other users' runs are unaffected, for the admin and for the user themselves", async () => {
    const adminView = await asAdmin(`/api/runs?userId=${uid.kept}&limit=100`);
    expect(adminView.body.data.total).toBe(KEPT_RUNS);

    const ownView = await request(app).get('/api/runs?limit=100').set('Authorization', `Bearer ${token.kept}`);
    expect(ownView.status).toBe(200);
    expect(ownView.body.data.total).toBe(KEPT_RUNS);
    expect(ownView.body.data.runs.every((r: { user: { id: number } }) => r.user.id === uid.kept)).toBe(true);
  });
});
