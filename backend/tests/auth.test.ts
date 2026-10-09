import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  app,
  setupFixtures,
  cleanupFixtures,
  loginAs,
  testEmails,
  TEST_PASSWORD,
  type Fixtures,
} from './helpers.js';
import config from '../src/config/env.js';

let fixtures: Fixtures;

beforeAll(async () => {
  fixtures = await setupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
});

describe('Login', () => {
  it('succeeds with correct credentials and returns a JWT + refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmails.user1, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(typeof res.body.data.refreshToken).toBe('string');
    expect(res.body.data.user).toMatchObject({ email: testEmails.user1, role: 'user' });

    // The access token itself must encode the correct identity.
    const decoded = jwt.verify(res.body.data.accessToken, config.JWT_SECRET) as {
      id: number;
      role: string;
    };
    expect(decoded.id).toBe(fixtures.user1Id);
    expect(decoded.role).toBe('user');
  });

  it('rejects an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a wrong password without revealing whether the email exists', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmails.user1, password: 'wrong-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('rejects malformed login payloads', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('Requirement 1: unauthenticated users cannot access protected APIs', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/usage-logs');
    expect(res.status).toBe(401);
  });

  it('rejects a request with a garbage/malformed token', async () => {
    const res = await request(app)
      .get('/api/usage-logs')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret (cannot be forged)', async () => {
    const forged = jwt.sign(
      { id: fixtures.adminId, email: testEmails.admin, role: 'admin' },
      'a-completely-different-secret-attacker-controls'
    );
    const res = await request(app)
      .get('/api/usage-logs')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign(
      { id: fixtures.user1Id, email: testEmails.user1, role: 'user' },
      config.JWT_SECRET,
      { expiresIn: -10 } // already expired
    );
    const res = await request(app)
      .get('/api/usage-logs')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('blocks the admin-only /api/users endpoint entirely for anonymous callers', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('blocks GET /api/auth/me without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('Requirement 2: normal users cannot access another user\'s records', () => {
  it('returns 403 when user1 requests user2\'s records by id', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const res = await request(app)
      .get(`/api/usage-logs/${fixtures.user2Id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 403 symmetrically when user2 requests user1\'s records', async () => {
    const { accessToken } = await loginAs(testEmails.user2);

    const res = await request(app)
      .get(`/api/usage-logs/${fixtures.user1Id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
  });

  it('a user CAN read their own records by id', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const res = await request(app)
      .get(`/api/usage-logs/${fixtures.user1Id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.every((log: { id: number }) => log.id === fixtures.user1LogId)).toBe(
      true
    );
  });

  it('ignores a ?userId= query override and still returns only the caller\'s own records', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const res = await request(app)
      .get(`/api/usage-logs?userId=${fixtures.user2Id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const returnedUserIds = new Set(res.body.data.map((log: { userId: number }) => log.userId));
    // Only ever the caller's own id - the query param for another user
    // must have no effect for a non-admin caller.
    expect(returnedUserIds.has(fixtures.user2Id)).toBe(false);
    expect([...returnedUserIds].every(id => id === fixtures.user1Id)).toBe(true);
  });
});

describe('Requirement 3: admin can access all users and all usage data', () => {
  it('GET /api/users lists every seeded account', async () => {
    const { accessToken } = await loginAs(testEmails.admin);

    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain(testEmails.admin);
    expect(emails).toContain(testEmails.user1);
    expect(emails).toContain(testEmails.user2);
  });

  it('a non-admin is forbidden from listing all users', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
  });

  it('admin can fetch any specific user\'s records by id', async () => {
    const { accessToken } = await loginAs(testEmails.admin);

    const res = await request(app)
      .get(`/api/usage-logs/${fixtures.user2Id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.some((log: { id: number }) => log.id === fixtures.user2LogId)).toBe(
      true
    );
  });

  it('admin\'s unfiltered view includes records from multiple users', async () => {
    const { accessToken } = await loginAs(testEmails.admin);

    const res = await request(app)
      .get('/api/usage-logs')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((log: { id: number }) => log.id);
    expect(ids).toContain(fixtures.user1LogId);
    expect(ids).toContain(fixtures.user2LogId);
  });
});

describe('Requirement 4: identity comes from the authenticated session, never client-supplied values', () => {
  it('GET /api/auth/me returns the caller\'s own identity, derived from the token', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: fixtures.user1Id, email: testEmails.user1 });
  });

  it('a userId in the request BODY is ignored for resolving identity (logout cannot be used to revoke someone else\'s session)', async () => {
    const user1Login = await loginAs(testEmails.user1);
    const user2Login = await loginAs(testEmails.user2);

    // user1 is authenticated via their own access token, but tries to
    // smuggle user2's refresh token into the logout body. This must NOT
    // revoke user2's session, because logout is scoped server-side to
    // req.user.id (from user1's token), not to anything in the body.
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${user1Login.accessToken}`)
      .send({ refreshToken: user2Login.refreshToken });

    expect(logoutRes.status).toBe(200);

    // Proof: user2's refresh token must still work.
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: user2Login.refreshToken });

    expect(refreshRes.status).toBe(200);
  });

  it('a tampered token claiming a different id/role is rejected outright', async () => {
    const { accessToken } = await loginAs(testEmails.user1);
    const [header, payload, signature] = accessToken.split('.');

    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...decodedPayload, id: fixtures.adminId, role: 'admin' })
    ).toString('base64url');

    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${tamperedToken}`);

    // Signature no longer matches -> rejected, proving the server
    // verifies the signature rather than trusting the decoded payload.
    expect(res.status).toBe(401);
  });

  it('own-records route resolves the SAME data whether or not a redundant query string tries to override it', async () => {
    const { accessToken } = await loginAs(testEmails.user1);

    const plain = await request(app)
      .get('/api/usage-logs')
      .set('Authorization', `Bearer ${accessToken}`);

    const withOverrideAttempt = await request(app)
      .get(`/api/usage-logs?userId=${fixtures.adminId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(plain.body.data).toEqual(withOverrideAttempt.body.data);
  });
});

describe('Refresh token lifecycle', () => {
  it('rotates the refresh token and rejects reuse of the old one (replay protection)', async () => {
    const { refreshToken } = await loginAs(testEmails.user1);

    const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.refreshToken).not.toBe(refreshToken);

    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(replay.status).toBe(401);
  });

  it('logout revokes the refresh token so it can no longer be used', async () => {
    const { accessToken, refreshToken } = await loginAs(testEmails.user2);

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(logoutRes.status).toBe(200);

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });
});
