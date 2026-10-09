/**
 * F-10: per-user rate limit on API requests that start AI work.
 *
 * The limiter takes an injected clock, so window behaviour is tested without
 * waiting. HTTP tests install a fresh small limiter per test
 * (__setAiRateLimiterForTesting) and CONTROLLED stub providers - no OpenAI
 * calls. The real defaults are checked by loading the config in a child
 * process with a minimal environment.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { AiRateLimiter, __setAiRateLimiterForTesting } from '../src/middleware/aiRateLimit.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvClassificationAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import {
  SentimentAgent,
  sentimentAgent as realSentimentAgent,
  __setSentimentAgentForTesting,
  SENTIMENT_AGENT_NAME,
} from '../src/agents/SentimentAgent.js';
import { LLMService, type LLMProviderRequest, type LLMProviderResponse } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const WINDOW_MS = 60_000;

describe('AiRateLimiter (fake clock)', () => {
  let now: number;
  const limiter = (max: number) => new AiRateLimiter(max, WINDOW_MS, () => now);
  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows up to the limit, then refuses with the time until the oldest unit frees up', () => {
    const l = limiter(3);
    expect(l.tryConsume(1, 1)).toMatchObject({ ok: true, remaining: 2 });
    now += 10_000;
    expect(l.tryConsume(1, 1)).toMatchObject({ ok: true, remaining: 1 });
    expect(l.tryConsume(1, 1)).toMatchObject({ ok: true, remaining: 0 });
    expect(l.tryConsume(1, 1)).toEqual({ ok: false, retryAfterMs: WINDOW_MS - 10_000 });
  });

  it('is a sliding window: each unit frees up exactly one window after it was used', () => {
    const l = limiter(2);
    l.tryConsume(1, 1);
    now += 30_000;
    l.tryConsume(1, 1);
    now += 29_999; // first unit is 59.999 s old
    expect(l.tryConsume(1, 1)).toEqual({ ok: false, retryAfterMs: 1 });
    now += 1; // exactly one window old -> expired
    expect(l.tryConsume(1, 1)).toMatchObject({ ok: true, remaining: 0 });
    expect(l.tryConsume(1, 1)).toEqual({ ok: false, retryAfterMs: 30_000 });
  });

  it('weighted requests wait until enough units have expired', () => {
    const l = limiter(5);
    l.tryConsume(1, 2); // t=0
    now += 10_000;
    l.tryConsume(1, 2); // t=10s
    // 4 used, 3 needed: once the t=0 entry (2) expires, 2 + 3 = 5 fits -> wait 50 s.
    expect(l.tryConsume(1, 3)).toEqual({ ok: false, retryAfterMs: 50_000 });
    // 4 used, 4 needed: both entries must expire -> wait until t=10s's expiry (60 s).
    expect(l.tryConsume(1, 4)).toEqual({ ok: false, retryAfterMs: WINDOW_MS });
    expect(l.tryConsume(1, 1)).toMatchObject({ ok: true, remaining: 0 });
  });

  it('a request larger than the whole limit can never fit', () => {
    expect(limiter(5).tryConsume(1, 6)).toEqual({ ok: false, retryAfterMs: null });
  });

  it('users have independent budgets', () => {
    const l = limiter(1);
    expect(l.tryConsume(1, 1).ok).toBe(true);
    expect(l.tryConsume(1, 1).ok).toBe(false);
    expect(l.tryConsume(2, 1).ok).toBe(true);
  });

  it('release gives the units back exactly once', () => {
    const l = limiter(2);
    const first = l.tryConsume(1, 2);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.release();
    first.release();
    expect(l.tryConsume(1, 2)).toMatchObject({ ok: true, remaining: 0 });
    expect(l.tryConsume(1, 1).ok).toBe(false);
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────

const EMAILS = { userA: 'ratelimit-a@test.local', userB: 'ratelimit-b@test.local', admin: 'ratelimit-admin@test.local' } as const;
type Who = keyof typeof EMAILS;
const ids: Record<Who, number> = { userA: 0, userB: 0, admin: 0 };
const tokens: Record<Who, string> = { userA: '', userB: '', admin: '' };
const EVIDENCE = 'Node.js and Express backend engineer';
const CV = `${EVIDENCE} with five years of REST API work.`;
let clock = 0;
let providerCalls = 0;
let providerFails = false;

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.sentimentResult.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}

function stubProvider() {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence['Back-End Developer'] = 0.9;
  return {
    messages: {
      create: async (req: LLMProviderRequest): Promise<LLMProviderResponse> => {
        providerCalls += 1;
        if (providerFails) throw { status: 503, name: 'APIError', message: 'Service unavailable (stub)' };
        const usage = { prompt_tokens: 500, completion_tokens: 80 };
        const content = req.messages[0].content;
        if (content.startsWith('[FEEDBACK TEXT - BEGIN')) {
          const feedback = content.split('\n')[1] ?? '';
          return { content: [{ type: 'text', text: JSON.stringify({ sentiment: 'positive', confidence: 0.9, rationale: `Mentions: ${feedback.slice(0, 40)}` }) }], model: 'gpt-4o', usage };
        }
        const text = JSON.stringify({ primaryCategory: 'Back-End Developer', secondaryCategories: [], confidence, rationale: [{ category: 'Back-End Developer', evidence: EVIDENCE }] });
        return { content: [{ type: 'text', text }], model: 'gpt-4o', usage };
      },
    },
  };
}

const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
const classify = (who: Who, extra: Record<string, unknown> = {}, query = '') =>
  request(app).post(`/api/cv/classify${query}`).set(as(who)).send({ cvContent: CV, fileName: 'cv.txt', ...extra });
const sentiment = (who: Who) => request(app).post('/api/sentiment/analyze').set(as(who)).send({ text: 'Great support team, very helpful.' });
const batch = (who: Who, n: number) =>
  request(app).post('/api/cv/batch').set(as(who)).send({ files: Array.from({ length: n }, (_, i) => ({ fileName: `b${i}.txt`, mimeType: 'text/plain', content: CV })) });
const install = (max: number) => __setAiRateLimiterForTesting(new AiRateLimiter(max, WINDOW_MS, () => clock));

async function footprint(who: Who) {
  const userId = ids[who];
  const [documents, runs, usage] = await Promise.all([
    prisma.cvDocument.count({ where: { userId } }),
    prisma.agentRun.count({ where: { userId } }),
    prisma.llmUsageLog.count({ where: { userId } }),
  ]);
  return { documents, runs, usage, providerCalls };
}

async function waitForBatches(who: Who) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const open = await prisma.agentRun.count({ where: { userId: ids[who], status: { in: ['PENDING', 'RUNNING'] } } });
    if (open === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('batch did not finish');
}

function expectRateLimited(res: request.Response, retryAfterSeconds: number, max = 3) {
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBe(String(retryAfterSeconds));
  expect(res.body).toEqual({
    success: false,
    error: `Too many AI requests: the limit is ${max} AI runs per minute. Try again in ${retryAfterSeconds} seconds.`,
    code: 'TOO_MANY_REQUESTS',
    details: { retryAfterSeconds },
  });
}

describe('AI rate limit over HTTP', () => {
  beforeAll(async () => {
    await cleanup();
    for (const name of [CV_CLASSIFICATION_AGENT_NAME, SENTIMENT_AGENT_NAME]) {
      await prisma.agent.upsert({ where: { name }, update: {}, create: { name, description: 'Upserted for tests', version: '1.0.0' } });
    }
    const hash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
    for (const who of Object.keys(EMAILS) as Who[]) {
      ids[who] = (await prisma.user.create({ data: { email: EMAILS[who], password: hash, role: who === 'admin' ? 'ADMIN' : 'USER' } })).id;
      tokens[who] = (await loginAs(EMAILS[who])).accessToken;
    }
    __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService(stubProvider())));
    __setSentimentAgentForTesting(new SentimentAgent(new LLMService(stubProvider())));
  });

  beforeEach(() => {
    clock = 5_000_000;
    providerFails = false;
    install(3);
  });

  afterAll(async () => {
    __setAiRateLimiterForTesting();
    __setCvClassificationAgentForTesting(realCvClassificationAgent);
    __setSentimentAgentForTesting(realSentimentAgent);
    await cleanup();
  });

  it('below the limit requests succeed; above it a 429 with Retry-After creates nothing and calls no provider', async () => {
    for (let i = 0; i < 3; i++) expect((await classify('userA')).status).toBe(201);
    const before = await footprint('userA');
    clock += 15_000;
    expectRateLimited(await classify('userA'), 45);
    expect(await footprint('userA')).toEqual(before); // no document, run, usage row or provider call
  });

  it('all AI endpoints share one budget; upload-only and read endpoints are never limited', async () => {
    expect((await classify('userA')).status).toBe(201);
    expect((await sentiment('userA')).status).toBe(201);
    const upload = await request(app).post('/api/cv/documents').set(as('userA')).send({ cvContent: CV, fileName: 'later.txt' });
    expect(upload.status).toBe(201); // upload only: no AI work, not counted
    expect((await request(app).post(`/api/cv/documents/${upload.body.data.id}/classify`).set(as('userA')).send()).status).toBe(201);

    const before = await footprint('userA');
    expectRateLimited(await classify('userA'), 60);
    expectRateLimited(await sentiment('userA'), 60);
    expectRateLimited(await request(app).post(`/api/cv/documents/${upload.body.data.id}/classify`).set(as('userA')).send(), 60);
    expectRateLimited(await batch('userA', 1), 60);
    expect(await footprint('userA')).toEqual(before);

    for (const path of ['/api/cv/results', '/api/sentiment/results', '/api/runs', '/api/usage-logs', '/api/analytics/summary', '/api/analytics/runs']) {
      expect((await request(app).get(path).set(as('userA'))).status, path).toBe(200);
    }
    expect((await request(app).post('/api/cv/documents').set(as('userA')).send({ cvContent: CV })).status).toBe(201);
  });

  it('budgets are per user, admins included', async () => {
    for (let i = 0; i < 3; i++) await classify('userA');
    expect((await classify('userA')).status).toBe(429);
    expect((await classify('userB')).status).toBe(201);
    expect((await sentiment('admin')).status).toBe(201);
    for (let i = 0; i < 2; i++) await classify('admin');
    expect((await classify('admin')).status).toBe(429);
    expect((await classify('userB')).status).toBe(201);
  });

  it('the key is the session user: query, header, body spoofing and a fresh login do not bypass it', async () => {
    for (let i = 0; i < 3; i++) await classify('userA');
    expect((await classify('userA', { userId: ids.userB }, `?userId=${ids.userB}`)).status).toBe(429);
    expect((await request(app).post('/api/cv/classify').set(as('userA')).set('X-User-Id', String(ids.userB)).set('X-Forwarded-For', '10.9.8.7').send({ cvContent: CV })).status).toBe(429);
    const second = await loginAs(EMAILS.userA); // a new session for the same user
    expect((await request(app).post('/api/cv/classify').set('Authorization', `Bearer ${second.accessToken}`).send({ cvContent: CV })).status).toBe(429);
    // userB's budget was not charged by any of the spoofed requests.
    for (let i = 0; i < 3; i++) expect((await classify('userB')).status).toBe(201);
  });

  it('the window resets: one window after the oldest run, the user can start AI work again', async () => {
    await classify('userA');
    clock += 20_000;
    await classify('userA');
    await classify('userA');
    expectRateLimited(await classify('userA'), 40);
    clock += 39_999;
    expectRateLimited(await classify('userA'), 1);
    clock += 1;
    expect((await classify('userA')).status).toBe(201);
    expectRateLimited(await classify('userA'), 20);
  });

  it('unauthenticated requests get 401, never 429, and use no budget', async () => {
    for (let i = 0; i < 3; i++) await classify('userA');
    for (const res of [
      await request(app).post('/api/cv/classify').send({ cvContent: CV }),
      await request(app).post('/api/sentiment/analyze').send({ text: 'hello there' }),
      await request(app).post('/api/cv/batch').set('Authorization', 'Bearer not-a-jwt').send({ files: [] }),
    ]) {
      expect(res.status).toBe(401);
    }
    expect((await classify('userB')).status).toBe(201);
  });

  it('a batch costs one run per file; a batch that does not fit is refused whole, creating nothing', async () => {
    install(5);
    expect((await batch('userA', 3)).status).toBe(202);
    await waitForBatches('userA');
    const before = await footprint('userA');
    expectRateLimited(await batch('userA', 3), 60, 5); // needs 3, 2 left
    expect(await footprint('userA')).toEqual(before);
    expect((await batch('userA', 2)).status).toBe(202); // exactly fits
    await waitForBatches('userA');
    expect((await classify('userA')).status).toBe(429);
  });

  it('a request bigger than the whole limit gets a 429 without Retry-After; an over-size batch keeps its 400', async () => {
    install(5);
    const tooBig = await batch('userA', 6);
    expect(tooBig.status).toBe(429);
    expect(tooBig.headers['retry-after']).toBeUndefined();
    expect(tooBig.body).toEqual({ success: false, error: 'This request would start 6 AI runs, more than the limit of 5 AI runs per minute.', code: 'TOO_MANY_REQUESTS' });

    install(100);
    const overSize = await batch('userA', 25); // validation: at most 20 files
    expect(overSize.status).toBe(400);
  });

  it('requests rejected with a 4xx before any AI work give their units back', async () => {
    for (let i = 0; i < 5; i++) expect((await classify('userA', { cvContent: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/cv/documents/999999999/classify').set(as('userA')).send()).status).toBe(404);
    const otherDoc = await request(app).post('/api/cv/documents').set(as('userB')).send({ cvContent: CV });
    expect((await request(app).post(`/api/cv/documents/${otherDoc.body.data.id}/classify`).set(as('userA')).send()).status).toBe(403);
    expect((await batch('userA', 0)).status).toBe(400);
    // The full budget of 3 is still there.
    for (let i = 0; i < 3; i++) expect((await classify('userA')).status).toBe(201);
    expect((await classify('userA')).status).toBe(429);
  });

  it('a provider failure (502) keeps its charge: the provider was called', async () => {
    providerFails = true;
    for (let i = 0; i < 3; i++) expect((await classify('userA')).status).toBe(502);
    const calls = providerCalls;
    expect((await classify('userA')).status).toBe(429);
    expect(providerCalls).toBe(calls);
  });

  it('concurrent requests cannot overshoot the limit', async () => {
    const before = await footprint('userA');
    const results = await Promise.all(Array.from({ length: 6 }, () => classify('userA')));
    expect(results.map(r => r.status).sort()).toEqual([201, 201, 201, 429, 429, 429]);
    const after = await footprint('userA');
    expect(after.runs - before.runs).toBe(3);
    expect(after.usage - before.usage).toBe(3);
    expect(after.providerCalls - before.providerCalls).toBe(3);
  });
});

// ── Real configuration ────────────────────────────────────────────────

describe('configuration', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-rate-limit-config-'));
    writeFileSync(
      join(dir, 'print-config.mts'),
      `const { default: c } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'config', 'env.ts')).href)});\n` +
        `console.log('AI_LIMIT=' + JSON.stringify({ max: c.AI_RATE_LIMIT_MAX_RUNS, windowSeconds: c.AI_RATE_LIMIT_WINDOW_SECONDS }));\n`
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function loadConfig(extra: Record<string, string>): Promise<{ code: number | null; output: string }> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, { NODE_ENV: 'development', DATABASE_URL: 'file:./never-opened.db', JWT_SECRET: randomBytes(32).toString('hex') }, extra);
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
    return new Promise(resolve => {
      const child = spawn(process.execPath, ['--import', tsx, join(dir, 'print-config.mts')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      child.on('exit', code => resolve({ code, output }));
    });
  }

  it('defaults to 60 AI runs per user per 600 seconds, and accepts overrides', async () => {
    const [defaults, custom] = await Promise.all([loadConfig({}), loadConfig({ AI_RATE_LIMIT_MAX_RUNS: '10', AI_RATE_LIMIT_WINDOW_SECONDS: '30' })]);
    expect(defaults.code).toBe(0);
    expect(defaults.output).toContain('AI_LIMIT={"max":60,"windowSeconds":600}');
    expect(custom.output).toContain('AI_LIMIT={"max":10,"windowSeconds":30}');
  }, 60_000);

  it('refuses to start with an invalid limit', async () => {
    const results = await Promise.all([
      loadConfig({ AI_RATE_LIMIT_MAX_RUNS: '0' }),
      loadConfig({ AI_RATE_LIMIT_MAX_RUNS: 'lots' }),
      loadConfig({ AI_RATE_LIMIT_WINDOW_SECONDS: '-5' }),
      loadConfig({ AI_RATE_LIMIT_WINDOW_SECONDS: '1.5' }),
    ]);
    for (const { code, output } of results) {
      expect(code).toBe(1);
      expect(output).toContain('Invalid environment variables');
      expect(output).toMatch(/AI_RATE_LIMIT_(MAX_RUNS|WINDOW_SECONDS)/);
    }
  }, 60_000);
});
