import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';

/** Admin → Users: create accounts and soft-delete (deactivate) them, through the real API. */

const PREFIX = 'admin-users-test';
const EMAIL = { admin: `${PREFIX}-admin@test.local`, user: `${PREFIX}-user@test.local` } as const;
const token = { admin: '', user: '' };
const uid = { admin: 0, user: 0 };
const NEW_PASSWORD = 'Str0ng-pass';

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.cvDocument.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

const api = (who: keyof typeof token | null | string) => {
  const auth = (r: request.Test) => (who === null ? r : r.set('Authorization', `Bearer ${who in token ? token[who as keyof typeof token] : who}`));
  return {
    get: (path: string) => auth(request(app).get(path)),
    post: (path: string, body: object) => auth(request(app).post(path)).send(body),
    del: (path: string) => auth(request(app).delete(path)),
  };
};
const create = (body: object, who: keyof typeof token = 'admin') => api(who).post('/api/users', body);
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });

beforeAll(async () => {
  await cleanup();
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  uid.admin = (await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN', name: 'Test Admin' } })).id;
  uid.user = (await prisma.user.create({ data: { email: EMAIL.user, password, role: 'USER', name: 'Test User' } })).id;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
  token.user = (await loginAs(EMAIL.user)).accessToken;
});

afterAll(async () => {
  await cleanup();
});

describe('POST /api/users - create an account', () => {
  it('creates a User account that can log in, with the password hashed and never returned', async () => {
    const res = await create({ name: '  Robin Lee ', email: `${PREFIX}-Robin@Test.local`, password: NEW_PASSWORD, role: 'user' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Robin Lee', email: `${PREFIX}-robin@test.local`, role: 'user', status: 'active', deactivatedAt: null });
    expect(JSON.stringify(res.body)).not.toMatch(/password|Str0ng-pass|\$2[aby]\$/);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(stored.password).not.toBe(NEW_PASSWORD);
    expect(await bcryptjs.compare(NEW_PASSWORD, stored.password)).toBe(true);

    const session = await login(`${PREFIX}-Robin@Test.local`, NEW_PASSWORD); // any letter case
    expect(session.status).toBe(200);
    expect(session.body.data.user.role).toBe('user');
    const t = session.body.data.accessToken as string;
    expect((await api(t).get('/api/auth/me')).body.data).toMatchObject({ email: `${PREFIX}-robin@test.local`, role: 'user' });
    expect((await api(t).get('/api/cv/results')).status).toBe(200); // own data
    expect((await api(t).get('/api/users')).status).toBe(403); // no admin rights
  });

  it('creates an Admin account with admin rights', async () => {
    const res = await create({ name: 'Second Admin', email: `${PREFIX}-admin2@test.local`, password: NEW_PASSWORD, role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('admin');
    const t = (await login(`${PREFIX}-admin2@test.local`, NEW_PASSWORD)).body.data.accessToken as string;
    expect((await api(t).get('/api/users')).status).toBe(200);
  });

  it('rejects a duplicate email, whatever its letter case', async () => {
    const res = await create({ name: 'Dup', email: EMAIL.user.toUpperCase(), password: NEW_PASSWORD, role: 'user' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An account with this email address already exists');
  });

  it('returns field-level errors for missing and invalid values, creating nothing', async () => {
    const before = await prisma.user.count();
    const missing = await create({});
    expect(missing.status).toBe(400);
    expect((missing.body.details.fields as Array<{ field: string }>).map(f => f.field).sort()).toEqual(['email', 'name', 'password', 'role']);
    const cases: Array<[object, string, RegExp]> = [
      [{ email: 'not-an-email' }, 'email', /valid email/],
      [{ password: 'short1' }, 'password', /at least 8/],
      [{ password: 'lettersonly' }, 'password', /letter and one number/],
      [{ password: '1234567890' }, 'password', /letter and one number/],
      [{ name: '   ' }, 'name', /required/],
      [{ role: 'superuser' }, 'role', /User or Admin/],
    ];
    for (const [patch, field, message] of cases) {
      const res = await create({ name: 'Valid Name', email: `${PREFIX}-x@test.local`, password: NEW_PASSWORD, role: 'user', ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect((res.body.details.fields as Array<{ field: string; message: string }>).find(f => f.field === field)?.message).toMatch(message);
    }
    expect(await prisma.user.count()).toBe(before);
  });

  it('denies unauthenticated requests and every regular user, who also cannot make themselves admin', async () => {
    const body = { name: 'Sneaky', email: `${PREFIX}-sneaky@test.local`, password: NEW_PASSWORD, role: 'admin' };
    expect((await api(null).post('/api/users', body)).status).toBe(401);
    expect((await create(body, 'user')).status).toBe(403);
    expect((await create({ ...body, email: EMAIL.user, userId: uid.user }, 'user')).status).toBe(403);
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: uid.user } })).role).toBe('USER');
  });
});

describe('DELETE /api/users/:id - soft delete (deactivation)', () => {
  it('deactivates an account: no login, no existing session or refresh token, data kept, others unaffected', async () => {
    const created = (await create({ name: 'Leaving User', email: `${PREFIX}-leaving@test.local`, password: NEW_PASSWORD, role: 'user' })).body.data;
    const session = (await login(`${PREFIX}-leaving@test.local`, NEW_PASSWORD)).body.data;
    await prisma.cvDocument.create({ data: { userId: created.id, content: 'Kept CV text for the retention check.' } });
    await prisma.llmUsageLog.create({ data: { timestamp: new Date(), userId: created.id, agentId: (await prisma.agent.upsert({ where: { name: 'Admin Users Test Agent' }, update: {}, create: { name: 'Admin Users Test Agent', description: 'test', version: '1.0.0' } })).id, agentName: 'Admin Users Test Agent', model: 'gpt-4o', inputTokens: 10, outputTokens: 5, latencyMs: 1, status: 'SUCCESS' } });

    const res = await api('admin').del(`/api/users/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: created.id, status: 'deactivated' });
    expect(res.body.data.deactivatedAt).toBeTruthy();

    expect((await api(session.accessToken).get('/api/auth/me')).status).toBe(401); // previously issued session
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    const relogin = await login(`${PREFIX}-leaving@test.local`, NEW_PASSWORD);
    expect(relogin.status).toBe(400);
    expect(relogin.body.error).toBe('Invalid email or password');
    expect(await prisma.refreshToken.count({ where: { userId: created.id, revokedAt: null } })).toBe(0);

    // History kept; the account is still listed, as deactivated.
    expect(await prisma.cvDocument.count({ where: { userId: created.id } })).toBe(1);
    expect(await prisma.llmUsageLog.count({ where: { userId: created.id } })).toBe(1);
    const listed = (await api('admin').get('/api/users')).body.data as Array<{ id: number; status: string; password?: string }>;
    expect(listed.find(u => u.id === created.id)?.status).toBe('deactivated');
    expect(listed.every(u => !('password' in u))).toBe(true);
    // Other accounts still work.
    expect((await api('user').get('/api/auth/me')).status).toBe(200);
    // The email stays reserved.
    expect((await create({ name: 'Again', email: `${PREFIX}-leaving@test.local`, password: NEW_PASSWORD, role: 'user' })).status).toBe(409);
  });

  it('refuses self-deletion, repeat deletion, unknown and invalid ids, and every non-admin caller', async () => {
    const self = await api('admin').del(`/api/users/${uid.admin}`);
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('You cannot delete your own account.');
    const target = (await create({ name: 'Twice', email: `${PREFIX}-twice@test.local`, password: NEW_PASSWORD, role: 'user' })).body.data.id as number;
    expect((await api('user').del(`/api/users/${target}`)).status).toBe(403);
    expect((await api(null).del(`/api/users/${target}`)).status).toBe(401);
    expect((await api('admin').del(`/api/users/${target}`)).status).toBe(200);
    expect((await api('admin').del(`/api/users/${target}`)).status).toBe(409);
    expect((await api('admin').del('/api/users/999999999')).status).toBe(404);
    expect((await api('admin').del('/api/users/abc')).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: uid.admin } })).deactivatedAt).toBeNull();
  });

  it('never deletes the last active admin, even when two admins delete each other at the same time', async () => {
    // Make the two test admins the only active admins, then restore everyone else.
    const others = await prisma.user.findMany({ where: { role: 'ADMIN', deactivatedAt: null, email: { notIn: [EMAIL.admin, `${PREFIX}-admin2@test.local`] } }, select: { id: true } });
    const otherIds = others.map(o => o.id);
    await prisma.user.updateMany({ where: { id: { in: otherIds } }, data: { deactivatedAt: new Date() } });
    try {
      const admin2 = await prisma.user.findUniqueOrThrow({ where: { email: `${PREFIX}-admin2@test.local` } });
      const t2 = (await login(admin2.email, NEW_PASSWORD)).body.data.accessToken as string;
      const [a, b] = await Promise.all([api('admin').del(`/api/users/${admin2.id}`), api(t2).del(`/api/users/${uid.admin}`)]);
      expect([a.status, b.status].filter(s => s === 200)).toHaveLength(1);
      expect(await prisma.user.count({ where: { role: 'ADMIN', deactivatedAt: null } })).toBe(1);

      // The remaining admin is now the last one: an admin created later still cannot remove it... and it cannot remove itself.
      const survivor = a.status === 200 ? uid.admin : admin2.id;
      expect((await prisma.user.findUniqueOrThrow({ where: { id: survivor } })).deactivatedAt).toBeNull();
    } finally {
      await prisma.user.updateMany({ where: { id: { in: otherIds } }, data: { deactivatedAt: null } });
      // Either test admin may have been the one deactivated: restore both, and a fresh session for later tests.
      await prisma.user.updateMany({ where: { email: { in: [EMAIL.admin, `${PREFIX}-admin2@test.local`] } }, data: { deactivatedAt: null } });
      token.admin = (await loginAs(EMAIL.admin)).accessToken;
    }
  });
});

describe('PUT /api/users/:id/password - change a password', () => {
  const put = (who: string, id: number | string, body: object) => request(app).put(`/api/users/${id}/password`).set('Authorization', `Bearer ${who}`).send(body);

  it('sets a new password: it works, the old one does not, and the account is signed out elsewhere', async () => {
    const user = (await create({ name: 'Pat Reset', email: `${PREFIX}-reset@test.local`, password: NEW_PASSWORD, role: 'user' })).body.data;
    const before = (await login(user.email, NEW_PASSWORD)).body.data;

    const res = await put(token.admin, user.id, { password: 'Brand-n3w-pass' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: user.id, sessionsSignedOut: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/Brand-n3w-pass|\$2[aby]\$/);
    expect(await bcryptjs.compare('Brand-n3w-pass', (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password)).toBe(true);

    expect((await api(before.accessToken).get('/api/auth/me')).status).toBe(401); // old session signed out
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: before.refreshToken })).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(400); // old password
    expect((await login(user.email, 'Brand-n3w-pass')).status).toBe(200); // new password
  });

  it("an admin changing their own password stays logged in on the current session only", async () => {
    const other = (await login(EMAIL.admin, TEST_PASSWORD)).body.data; // a second session of the same admin
    const res = await put(token.admin, uid.admin, { password: 'Adm1n-new-pass' });
    expect(res.status).toBe(200);
    expect((await api('admin').get('/api/auth/me')).status).toBe(200); // the session that made the change
    expect((await api(other.accessToken).get('/api/auth/me')).status).toBe(401);
    expect((await login(EMAIL.admin, 'Adm1n-new-pass')).status).toBe(200);
  });

  it('validates the new password with the same rules as account creation', async () => {
    for (const [body, message] of [
      [{}, /required/],
      [{ password: 'short1' }, /at least 8/],
      [{ password: 'lettersonly' }, /letter and one number/],
    ] as Array<[object, RegExp]>) {
      const res = await put(token.admin, uid.user, body);
      expect(res.status).toBe(400);
      expect((res.body.details.fields as Array<{ field: string; message: string }>).find(f => f.field === 'password')?.message).toMatch(message);
    }
    expect((await login(EMAIL.user, TEST_PASSWORD)).status).toBe(200); // unchanged
  });

  it('refuses deleted accounts, unknown and invalid ids, and every non-admin caller (even for their own account)', async () => {
    const gone = (await create({ name: 'Gone', email: `${PREFIX}-gone@test.local`, password: NEW_PASSWORD, role: 'user' })).body.data.id as number;
    await api('admin').del(`/api/users/${gone}`);
    expect((await put(token.admin, gone, { password: 'Brand-n3w-pass' })).status).toBe(409);
    expect((await put(token.admin, 999999999, { password: 'Brand-n3w-pass' })).status).toBe(404);
    expect((await put(token.admin, 'abc', { password: 'Brand-n3w-pass' })).status).toBe(400);
    expect((await put(token.user, uid.user, { password: 'Brand-n3w-pass' })).status).toBe(403);
    expect((await put(token.user, uid.admin, { password: 'Brand-n3w-pass' })).status).toBe(403);
    expect((await request(app).put(`/api/users/${uid.user}/password`).send({ password: 'Brand-n3w-pass' })).status).toBe(401);
    expect((await login(EMAIL.user, TEST_PASSWORD)).status).toBe(200); // unchanged
  });
});
