import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { AnalyticsService } from '../src/services/analyticsService.js';
import {
  parseJsonLogFile,
  parseJsonlLogFile,
  classifyStatus,
} from '../src/externalLogs/format.js';

// ───────────────────────────────────────────────────────────────────
// Unit tests: the parser/validator/classifier, no DB or HTTP involved.
// ───────────────────────────────────────────────────────────────────

describe('parseJsonLogFile', () => {
  it('parses a valid array of records, including ones missing optional fields', () => {
    const result = parseJsonLogFile(
      JSON.stringify([
        {
          timestamp: '2026-01-15T10:30:00Z',
          agentName: 'Legacy Bot',
          model: 'gpt-4o-mini',
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 900,
          status: 'ok',
          estimatedCost: 0.002,
        },
        { timestamp: '2026-01-15T10:31:00Z', agentName: 'Legacy Bot', status: 'failed' },
      ])
    );

    expect(result.errors).toEqual([]);
    expect(result.totalRecords).toBe(2);
    expect(result.normalized).toHaveLength(2);
    expect(result.normalized[0].inputTokens).toBe(100);
    expect(result.normalized[1].inputTokens).toBeNull();
    expect(result.normalized[1].isError).toBe(true);
  });

  it('rejects a record missing the required timestamp, without rejecting the valid one in the same file', () => {
    const result = parseJsonLogFile(
      JSON.stringify([
        { agentName: 'Legacy Bot', status: 'ok' },
        { timestamp: '2026-01-15T10:31:00Z', agentName: 'Legacy Bot', status: 'ok' },
      ])
    );

    expect(result.totalRecords).toBe(2);
    expect(result.normalized).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].reason).toContain('timestamp');
  });

  it('rejects a record with an unparseable timestamp', () => {
    const result = parseJsonLogFile(JSON.stringify([{ timestamp: 'not-a-date', agentName: 'Legacy Bot' }]));
    expect(result.normalized).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('could not be parsed as a date');
  });

  it('rejects invalid JSON entirely with a file-level error (index -1)', () => {
    const result = parseJsonLogFile('{not valid json');
    expect(result.normalized).toHaveLength(0);
    expect(result.errors).toEqual([expect.objectContaining({ index: -1 })]);
  });

  it('rejects a top-level object (not an array) with a file-level error', () => {
    const result = parseJsonLogFile(JSON.stringify({ timestamp: '2026-01-15T10:30:00Z', agentName: 'x' }));
    expect(result.normalized).toHaveLength(0);
    expect(result.errors[0].index).toBe(-1);
    expect(result.errors[0].reason).toContain('array');
  });

  it('preserves unrecognized extra fields in rawRecord rather than rejecting the record', () => {
    const result = parseJsonLogFile(
      JSON.stringify([{ timestamp: '2026-01-15T10:30:00Z', agentName: 'Legacy Bot', someVendorSpecificField: 'xyz' }])
    );
    expect(result.errors).toEqual([]);
    expect(result.normalized[0].rawRecord.someVendorSpecificField).toBe('xyz');
  });
});

describe('parseJsonlLogFile', () => {
  it('parses valid lines and skips blank lines without counting them as records', () => {
    const content = [
      JSON.stringify({ timestamp: '2026-01-15T10:30:00Z', agentName: 'Bot', status: 'ok' }),
      '',
      JSON.stringify({ timestamp: '2026-01-15T10:31:00Z', agentName: 'Bot', status: 'ok' }),
    ].join('\n');

    const result = parseJsonlLogFile(content);
    expect(result.totalRecords).toBe(2);
    expect(result.normalized).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it('reports a malformed line (invalid JSON) without failing the other valid lines', () => {
    const content = [
      JSON.stringify({ timestamp: '2026-01-15T10:30:00Z', agentName: 'Bot', status: 'ok' }),
      'this is not json',
      JSON.stringify({ timestamp: '2026-01-15T10:31:00Z', agentName: 'Bot', status: 'ok' }),
    ].join('\n');

    const result = parseJsonlLogFile(content);
    expect(result.totalRecords).toBe(3);
    expect(result.normalized).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1); // 0-based line number
  });
});

describe('classifyStatus', () => {
  it('classifies known error terms as errors', () => {
    expect(classifyStatus('error')).toBe(true);
    expect(classifyStatus('FAILED')).toBe(true);
    expect(classifyStatus('500')).toBe(true);
  });

  it('classifies known success terms as non-errors', () => {
    expect(classifyStatus('ok')).toBe(false);
    expect(classifyStatus('SUCCESS')).toBe(false);
    expect(classifyStatus('200')).toBe(false);
  });

  it('falls back to a substring heuristic for unrecognized strings', () => {
    expect(classifyStatus('partial_failure_in_subsystem')).toBe(true);
    expect(classifyStatus('weird-custom-status')).toBe(false);
  });

  it('defaults to non-error when status is absent', () => {
    expect(classifyStatus(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// Integration tests: real HTTP + real DB.
// ───────────────────────────────────────────────────────────────────

const EMAILS = {
  userA: 'external-logs-user-a@test.local',
  userB: 'external-logs-user-b@test.local',
} as const;

async function cleanup() {
  const emails = Object.values(EMAILS);
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.externalAgentLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(async () => {
  await cleanup();
  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  await prisma.user.create({ data: { email: EMAILS.userA, password: passwordHash, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAILS.userB, password: passwordHash, role: 'USER' } });
});

afterAll(async () => {
  await cleanup();
});

describe('POST /api/import/logs - valid files', () => {
  it('imports a valid .json file end to end', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const content = JSON.stringify([
      {
        timestamp: '2026-01-15T10:30:00Z',
        agentName: 'Legacy Bot',
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 900,
        status: 'ok',
        estimatedCost: 0.002,
      },
      { timestamp: '2026-01-15T10:31:00Z', agentName: 'Legacy Bot', status: 'failed', latencyMs: 2000 },
    ]);

    const res = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sourceAgentName: 'Legacy Bot', fileName: 'test.json', format: 'json', content });

    expect(res.status).toBe(201);
    expect(res.body.data.totalRecords).toBe(2);
    expect(res.body.data.validRecords).toBe(2);
    expect(res.body.data.invalidRecords).toBe(0);

    const records = await prisma.externalAgentLogRecord.findMany({ where: { importId: res.body.data.id } });
    expect(records).toHaveLength(2);
    expect(records.some(r => r.isError)).toBe(true);
  });

  it('imports a valid .jsonl file end to end', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const content = [
      JSON.stringify({ timestamp: '2026-01-16T08:00:00Z', agentName: 'Vendor Parser', status: '200', inputTokens: 10 }),
      JSON.stringify({ timestamp: '2026-01-16T08:01:00Z', agentName: 'Vendor Parser', status: '500' }),
    ].join('\n');

    const res = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sourceAgentName: 'Vendor Parser', fileName: 'test.jsonl', format: 'jsonl', content });

    expect(res.status).toBe(201);
    expect(res.body.data.validRecords).toBe(2);
  });
});

describe('POST /api/import/logs - partial failure (mixed valid/invalid records)', () => {
  it('imports the valid records and reports errors for the invalid ones, without failing the whole request', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const content = JSON.stringify([
      { timestamp: '2026-01-15T10:30:00Z', agentName: 'Mixed Bot', status: 'ok' }, // valid
      { agentName: 'Mixed Bot', status: 'ok' }, // invalid: missing timestamp
      { timestamp: 'garbage', agentName: 'Mixed Bot', status: 'ok' }, // invalid: bad timestamp
    ]);

    const res = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sourceAgentName: 'Mixed Bot', fileName: 'mixed.json', format: 'json', content });

    expect(res.status).toBe(201);
    expect(res.body.data.totalRecords).toBe(3);
    expect(res.body.data.validRecords).toBe(1);
    expect(res.body.data.invalidRecords).toBe(2);
    expect(res.body.data.parseErrors).toHaveLength(2);
  });
});

describe('POST /api/import/logs - invalid file', () => {
  it('rejects completely invalid JSON for a .json upload with validRecords 0', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sourceAgentName: 'Broken Bot', fileName: 'broken.json', format: 'json', content: 'not json at all' });

    expect(res.status).toBe(201); // the upload itself succeeds - the FILE is what's invalid
    expect(res.body.data.validRecords).toBe(0);
    expect(res.body.data.totalRecords).toBe(0);
  });

  it('rejects a request missing required fields (sourceAgentName) with a 400', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'x.json', format: 'json', content: '[]' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/import/stats', () => {
  it('computes correct aggregates from only this user\'s imported records', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app).get('/api/import/stats').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    // From the two imports above: 2 (json) + 2 (jsonl) + 1 (mixed, valid only) = 5 valid records total for userA
    expect(res.body.data.totalRecords).toBe(5);
    expect(res.body.data.byAgent.length).toBeGreaterThan(0);
  });
});

describe('External logs never contaminate internal analytics', () => {
  it('importing records with huge token counts does not change AnalyticsService.getTokenSummary for the same user', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const userA = await prisma.user.findUnique({ where: { email: EMAILS.userA } });

    const before = await AnalyticsService.getTokenSummary({ id: userA!.id, email: userA!.email, role: 'user' });

    await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        sourceAgentName: 'Huge Numbers Bot',
        fileName: 'huge.json',
        format: 'json',
        content: JSON.stringify([
          { timestamp: '2026-01-15T10:30:00Z', agentName: 'Huge Numbers Bot', inputTokens: 9999999, outputTokens: 9999999, estimatedCost: 99999 },
        ]),
      });

    const after = await AnalyticsService.getTokenSummary({ id: userA!.id, email: userA!.email, role: 'user' });

    expect(after.totalInputTokens).toBe(before.totalInputTokens);
    expect(after.totalOutputTokens).toBe(before.totalOutputTokens);
    expect(after.estimatedCost).toBeCloseTo(before.estimatedCost, 10);
  });
});

describe('External logs - authorization', () => {
  it('rejects an unauthenticated import request', async () => {
    const res = await request(app).post('/api/import/logs').send({
      sourceAgentName: 'x',
      fileName: 'x.json',
      format: 'json',
      content: '[]',
    });
    expect(res.status).toBe(401);
  });

  it('forbids user B from viewing user A\'s import detail', async () => {
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const uploadRes = await request(app)
      .post('/api/import/logs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        sourceAgentName: 'Private Bot',
        fileName: 'private.json',
        format: 'json',
        content: JSON.stringify([{ timestamp: '2026-01-15T10:30:00Z', agentName: 'Private Bot', status: 'ok' }]),
      });

    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    const res = await request(app)
      .get(`/api/import/logs/${uploadRes.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });

  it('user B\'s log list never includes user A\'s imports', async () => {
    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    const res = await request(app).get('/api/import/logs').set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
