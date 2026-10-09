import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { app, loginAs } from './helpers.js';
import prisma from '../src/db/client.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import {
  SentimentAgent,
  sentimentAgent as realSentimentAgent,
  __setSentimentAgentForTesting,
  SENTIMENT_AGENT_NAME,
} from '../src/agents/SentimentAgent.js';
import { LLMService, type LLMProviderClient, type LLMProviderRequest, type LLMProviderResponse } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

/**
 * Step 16 - multi-user and concurrent agent testing.
 *
 * CONTROLLED INTEGRATION TEST, not a real-OpenAI demonstration: everything
 * is the real application (seeded demo users, POST /api/auth/login, JWT
 * auth middleware, routes, services, agents with their validation, usage
 * logging, SQLite) except the OpenAI provider, which is a scripted provider
 * installed through the existing agent test hooks. It sleeps PROVIDER_LATENCY_MS
 * per call, returns a unique response id and unique token counts per call,
 * and records when each call started and ended - the evidence used below.
 */

const PROVIDER_LATENCY_MS = 600;
const PASSWORD = 'password123'; // the seeded demo password (backend/src/db/seed.ts)
const MODEL = 'gpt-4o-2024-08-06';
const EMAIL = { user1: 'user1@example.com', user2: 'user2@example.com', user3: 'user3@example.com', admin: 'admin@example.com' } as const;
type Who = keyof typeof EMAIL;
const USERS: Exclude<Who, 'admin'>[] = ['user1', 'user2', 'user3'];

const CV_TEXT: Record<Exclude<Who, 'admin'>, string> = {
  user1: 'MARKER-USER1-CV Senior backend engineer building REST APIs with Node.js and Express for six years.',
  user2: 'MARKER-USER2-CV Frontend developer building React single-page apps with TypeScript and CSS.',
  user3: 'MARKER-USER3-CV QA automation engineer writing Selenium and Cypress end-to-end suites.',
};
const FEEDBACK_TEXT: Record<Exclude<Who, 'admin'>, string> = {
  user1: 'MARKER-USER1-SENTIMENT The new dashboard is great and support answered quickly.',
  user2: 'MARKER-USER2-SENTIMENT Checkout failed twice and nobody replied to my ticket.',
  user3: 'MARKER-USER3-SENTIMENT The update changed the menu; I have not decided if I like it.',
};

// ── Scripted provider with call recording ────────────────────────────────

interface ProviderCall {
  responseId: string;
  marker: string | null;
  startedAt: number;
  endedAt: number;
  promptTokens: number;
  completionTokens: number;
}
const providerCalls: ProviderCall[] = [];
let inFlight = 0;
let maxInFlight = 0;
let callSeq = 0;

function cvBody(cv: string) {
  const primary = /Node\.js/.test(cv) ? 'Back-End Developer' : /React/.test(cv) ? 'Front-End Developer' : 'Web Automation';
  const confidence: Record<string, number> = Object.fromEntries(CV_CATEGORIES.map(c => [c, 0.02]));
  confidence[primary] = 0.9;
  return { primaryCategory: primary, secondaryCategories: [], confidence, rationale: [{ category: primary, evidence: cv.replace(/^MARKER-\S+ /, '') }] };
}

function sentimentBody(feedback: string) {
  const sentiment = /failed|nobody/.test(feedback) ? 'negative' : /great|quickly/.test(feedback) ? 'positive' : 'neutral';
  return { sentiment, confidence: 0.9, rationale: `Feedback says: ${feedback.replace(/^MARKER-\S+ /, '').slice(0, 60)}`.trim() };
}

const scriptedProvider: LLMProviderClient = {
  messages: {
    async create(req: LLMProviderRequest): Promise<LLMProviderResponse> {
      const seq = ++callSeq;
      const startedAt = Date.now();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, PROVIDER_LATENCY_MS));
        const content = req.messages[0].content;
        const inner = content.split('\n').slice(1).join('\n').split('\n[')[0];
        const isSentiment = content.startsWith('[FEEDBACK TEXT - BEGIN');
        const body = isSentiment ? sentimentBody(inner) : cvBody(inner);
        // Unique per call, so a usage row credited to the wrong call/user can never match by accident.
        const promptTokens = 1000 + seq * 7;
        const completionTokens = 100 + seq * 3;
        const responseId = `chatcmpl-mu-${seq}`;
        providerCalls.push({ responseId, marker: inner.match(/MARKER-[A-Z0-9]+-[A-Z]+/)?.[0] ?? null, startedAt, endedAt: Date.now(), promptTokens, completionTokens });
        return { content: [{ type: 'text', text: JSON.stringify(body) }], model: MODEL, id: responseId, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } };
      } finally {
        inFlight -= 1;
      }
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

const token: Record<Who, string> = { user1: '', user2: '', user3: '', admin: '' };
const userId: Record<Who, number> = { user1: 0, user2: 0, user3: 0, admin: 0 };
const markerOwner = (marker: string | null): Who | null =>
  (marker?.match(/MARKER-(USER[123])-/)?.[1].toLowerCase() as Who | undefined) ?? null;

interface Timed<T> {
  who: Who;
  startedAt: number;
  endedAt: number;
  res: T;
}
async function timed<T>(who: Who, fn: () => Promise<T>): Promise<Timed<T>> {
  const startedAt = Date.now();
  const res = await fn();
  return { who, startedAt, endedAt: Date.now(), res };
}

const api = {
  get: (who: Who, path: string) => request(app).get(path).set('Authorization', `Bearer ${token[who]}`),
  post: (who: Who, path: string, body: object) => request(app).post(path).set('Authorization', `Bearer ${token[who]}`).send(body),
};
const classify = (who: Exclude<Who, 'admin'>, suffix = '') =>
  api.post(who, '/api/cv/classify', { cvContent: CV_TEXT[who] + suffix, fileName: `${who}-cv${suffix ? '-concurrent' : ''}.txt` });
const analyze = (who: Exclude<Who, 'admin'>, suffix = '') => api.post(who, '/api/sentiment/analyze', { text: FEEDBACK_TEXT[who] + suffix });

function overlaps(a: { startedAt: number; endedAt: number }, b: { startedAt: number; endedAt: number }) {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

/** Every usage-log field for one run, checked against the provider call that produced it. */
async function expectUsageLogsFor(runId: string, who: Exclude<Who, 'admin'>, agentName: string, window: { startedAt: number; endedAt: number }) {
  const logs = await prisma.llmUsageLog.findMany({ where: { runId } });
  expect(logs.length).toBeGreaterThanOrEqual(1);
  for (const log of logs) {
    const call = providerCalls.find(c => c.responseId === log.providerResponseId);
    expect(call, `provider call for ${log.providerResponseId}`).toBeDefined();
    expect(markerOwner(call!.marker), 'content that produced this log belongs to the logged user').toBe(who);
    expect(log).toMatchObject({
      userId: userId[who],
      agentName,
      model: MODEL,
      inputTokens: call!.promptTokens,
      outputTokens: call!.completionTokens,
      status: 'SUCCESS',
      runId,
      isSeedData: false,
    });
    expect(log.latencyMs).toBeGreaterThanOrEqual(PROVIDER_LATENCY_MS - 20);
    expect(log.timestamp.getTime()).toBeGreaterThanOrEqual(window.startedAt - 5);
    expect(log.timestamp.getTime()).toBeLessThanOrEqual(window.endedAt + 5);
  }
  return logs;
}

const created = {
  cv: {} as Record<Exclude<Who, 'admin'>, { recId: number; docId: number; runId: string }>,
  sentiment: {} as Record<Exclude<Who, 'admin'>, { resultId: number; runId: string }>,
  batch: {} as Record<Exclude<Who, 'admin'>, string>,
};

beforeAll(async () => {
  // The real seed script against the test database: the actual demo users and agents.
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [tsxCli, 'src/db/seed.ts'], { cwd: backendRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe' });

  for (const who of Object.keys(EMAIL) as Who[]) {
    const login = await loginAs(EMAIL[who], PASSWORD);
    token[who] = login.accessToken;
    userId[who] = login.user.id;
  }

  const llm = new LLMService(scriptedProvider);
  __setCvClassificationAgentForTesting(new CVClassificationAgent(llm));
  __setSentimentAgentForTesting(new SentimentAgent(llm));
}, 60000);

afterAll(() => {
  __setCvClassificationAgentForTesting(realCvAgent);
  __setSentimentAgentForTesting(realSentimentAgent);
});

// ── Requirement 1: every user runs both agents ──────────────────────────

describe('Requirement 1 - user1, user2 and user3 each run both agents through the API', () => {
  it('identifies each demo user from their own login token', async () => {
    for (const who of Object.keys(EMAIL) as Who[]) {
      const me = await api.get(who, '/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data).toMatchObject({ id: userId[who], email: EMAIL[who] });
    }
  });

  for (const who of USERS) {
    it(`${who}: CV Classification Agent run is stored with the right user, agent, run, timestamp, status and usage log`, async () => {
      const t = await timed(who, () => classify(who));
      expect(t.res.status).toBe(201);
      const rec = t.res.body.data;

      const run = await prisma.agentRun.findUnique({ where: { id: rec.runId } });
      expect(run).toMatchObject({ userId: userId[who], agentName: CV_CLASSIFICATION_AGENT_NAME, status: 'SUCCESS', cvDocumentId: rec.cvDocumentId });
      expect(run!.startedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt - 5);
      expect(run!.completedAt!.getTime()).toBeLessThanOrEqual(t.endedAt + 5);
      const doc = await prisma.cvDocument.findUnique({ where: { id: rec.cvDocumentId } });
      expect(doc!.userId).toBe(userId[who]);
      expect(rec.userId).toBe(userId[who]);
      await expectUsageLogsFor(rec.runId, who, CV_CLASSIFICATION_AGENT_NAME, t);

      created.cv[who] = { recId: rec.id, docId: rec.cvDocumentId, runId: rec.runId };
    });

    it(`${who}: Feedback Sentiment Agent run is stored with the right user, agent, run, timestamp, status and usage log`, async () => {
      const t = await timed(who, () => analyze(who));
      expect(t.res.status).toBe(201);
      const result = t.res.body.data;

      const run = await prisma.agentRun.findUnique({ where: { id: result.runId } });
      expect(run).toMatchObject({ userId: userId[who], agentName: SENTIMENT_AGENT_NAME, status: 'SUCCESS' });
      expect(run!.startedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt - 5);
      expect(result.userId).toBe(userId[who]);
      await expectUsageLogsFor(result.runId, who, SENTIMENT_AGENT_NAME, t);

      created.sentiment[who] = { resultId: result.id, runId: result.runId };
    });
  }

  it('each user can also submit a CV batch, owned by them', async () => {
    for (const who of USERS) {
      const res = await api.post(who, '/api/cv/batch', { files: [{ fileName: `${who}-batch.txt`, mimeType: 'text/plain', content: CV_TEXT[who] }] });
      expect(res.status).toBe(202);
      created.batch[who] = res.body.data.batchId;
    }
    for (const who of USERS) {
      let status: { completed: number; failed: number; total: number; items: Array<{ recommendationId: number | null }> } | undefined;
      for (let i = 0; i < 60; i++) {
        status = (await api.get(who, `/api/cv/batch/${created.batch[who]}/status`)).body.data;
        if (status!.completed + status!.failed === status!.total) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
      const rec = await prisma.cvRecommendation.findUnique({ where: { id: status!.items[0].recommendationId! } });
      expect(rec!.userId).toBe(userId[who]);
    }
  });
});

// ── Requirements 2, 3, 7, 10: concurrent users ──────────────────────────

describe('Requirements 2, 3, 7, 10 - user1 and user2 classify CVs at the same time', () => {
  let results: Array<Timed<request.Response>>;
  let callsBefore: number;

  beforeAll(async () => {
    callsBefore = providerCalls.length;
    maxInFlight = 0;
    results = await Promise.all([timed('user1', () => classify('user1', ' concurrent')), timed('user2', () => classify('user2', ' concurrent'))]);
  });

  it('both concurrent requests succeed', () => {
    expect(results.map(r => r.res.status)).toEqual([201, 201]);
  });

  it('evidence: the HTTP requests, the provider calls and the stored runs all overlapped in time', async () => {
    const [u1, u2] = results;
    const calls = providerCalls.slice(callsBefore);
    const u1Call = calls.find(c => markerOwner(c.marker) === 'user1')!;
    const u2Call = calls.find(c => markerOwner(c.marker) === 'user2')!;
    const u1Run = (await prisma.agentRun.findUnique({ where: { id: u1.res.body.data.runId } }))!;
    const u2Run = (await prisma.agentRun.findUnique({ where: { id: u2.res.body.data.runId } }))!;
    const runInterval = (r: typeof u1Run) => ({ startedAt: r.startedAt.getTime(), endedAt: r.completedAt!.getTime() });

    const evidence = {
      label: 'controlled integration test (scripted provider), not real OpenAI',
      http: { user1: { start: u1.startedAt, end: u1.endedAt }, user2: { start: u2.startedAt, end: u2.endedAt } },
      provider: { user1: { start: u1Call.startedAt, end: u1Call.endedAt }, user2: { start: u2Call.startedAt, end: u2Call.endedAt }, maxConcurrentCalls: maxInFlight },
      dbRuns: { user1: { runId: u1Run.id, ...runInterval(u1Run) }, user2: { runId: u2Run.id, ...runInterval(u2Run) } },
    };
    console.log(`[Step 16 concurrency evidence] ${JSON.stringify(evidence)}`);

    expect(u1.startedAt < u2.endedAt && u2.startedAt < u1.endedAt).toBe(true);
    expect(overlaps(u1Call, u2Call)).toBe(true);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(overlaps(runInterval(u1Run), runInterval(u2Run))).toBe(true);
  });

  it('isolation: each result, CV document and run belongs to the user who sent it, and run ids are distinct', async () => {
    const [u1, u2] = results;
    expect(u1.res.body.data.runId).not.toBe(u2.res.body.data.runId);
    for (const r of results) {
      const who = r.who as Exclude<Who, 'admin'>;
      const rec = (await prisma.cvRecommendation.findUnique({ where: { id: r.res.body.data.id }, include: { cvDocument: true, run: true } }))!;
      expect(rec.userId).toBe(userId[who]);
      expect(rec.cvDocument.userId).toBe(userId[who]);
      expect(rec.cvDocument.content).toContain(`MARKER-${who.toUpperCase()}-CV`);
      expect(rec.run!.userId).toBe(userId[who]);
      expect(rec.primaryCategory).toBe(who === 'user1' ? 'Back-End Developer' : 'Front-End Developer');
    }
  });

  it('usage logs: every field is correct and no usage is credited to the other user', async () => {
    for (const r of results) {
      await expectUsageLogsFor(r.res.body.data.runId, r.who as Exclude<Who, 'admin'>, CV_CLASSIFICATION_AGENT_NAME, r);
    }
    const u1Logs = await prisma.llmUsageLog.findMany({ where: { userId: userId.user1, isSeedData: false } });
    const u2Logs = await prisma.llmUsageLog.findMany({ where: { userId: userId.user2, isSeedData: false } });
    for (const log of u1Logs) expect(markerOwner(providerCalls.find(c => c.responseId === log.providerResponseId)!.marker)).toBe('user1');
    for (const log of u2Logs) expect(markerOwner(providerCalls.find(c => c.responseId === log.providerResponseId)!.marker)).toBe('user2');
  });

  it('concurrency across different agents and three users at once: no mixing', async () => {
    maxInFlight = 0;
    const mixed = await Promise.all([
      timed('user1', () => analyze('user1', ' concurrent')),
      timed('user2', () => classify('user2', ' mixed')),
      timed('user3', () => analyze('user3', ' concurrent')),
    ]);
    expect(mixed.map(r => r.res.status)).toEqual([201, 201, 201]);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(overlaps(mixed[0], mixed[1]) && overlaps(mixed[1], mixed[2])).toBe(true);
    expect(new Set(mixed.map(r => r.res.body.data.runId)).size).toBe(3);
    await expectUsageLogsFor(mixed[0].res.body.data.runId, 'user1', SENTIMENT_AGENT_NAME, mixed[0]);
    await expectUsageLogsFor(mixed[1].res.body.data.runId, 'user2', CV_CLASSIFICATION_AGENT_NAME, mixed[1]);
    await expectUsageLogsFor(mixed[2].res.body.data.runId, 'user3', SENTIMENT_AGENT_NAME, mixed[2]);
  });
});

// ── Requirement 8: concurrent decisions ─────────────────────────────────

describe('Requirement 8 - user1 and user2 submit CV decisions at the same time', () => {
  it('each decision is stored against the submitting user\'s own CV and run, without overwriting anything', async () => {
    const [d1, d2] = await Promise.all([
      timed('user1', () => api.post('user1', `/api/cv/results/${created.cv.user1.recId}/decision`, { decisionType: 'MODIFY', finalPrimaryCategory: 'AI Engineer', reason: 'user1 concurrent modify' })),
      timed('user2', () => api.post('user2', `/api/cv/results/${created.cv.user2.recId}/decision`, { decisionType: 'REJECT', reason: 'user2 concurrent reject' })),
    ]);
    expect([d1.res.status, d2.res.status]).toEqual([201, 201]);

    const expectations = [
      { who: 'user1' as const, res: d1.res, type: 'MODIFY', final: 'AI Engineer' },
      { who: 'user2' as const, res: d2.res, type: 'REJECT', final: null },
    ];
    for (const e of expectations) {
      const decision = await prisma.recommendationDecision.findUnique({ where: { id: e.res.body.data.id } });
      expect(decision).toMatchObject({
        userId: userId[e.who],
        recommendationId: created.cv[e.who].recId,
        cvDocumentId: created.cv[e.who].docId,
        agentRunId: created.cv[e.who].runId,
        decisionType: e.type,
        finalPrimaryCategory: e.final,
      });
      const decisions = await prisma.recommendationDecision.findMany({ where: { recommendationId: created.cv[e.who].recId } });
      expect(decisions.every(d => d.userId === userId[e.who])).toBe(true);
    }
    // The original recommendations were not modified by either decision.
    expect((await prisma.cvRecommendation.findUnique({ where: { id: created.cv.user1.recId } }))!.primaryCategory).toBe('Back-End Developer');
    expect((await prisma.cvRecommendation.findUnique({ where: { id: created.cv.user2.recId } }))!.primaryCategory).toBe('Front-End Developer');
  });
});

// ── Requirement 4: cross-user security (backend-enforced) ───────────────

describe('Requirement 4 - no user can reach another user\'s data', () => {
  const pairs: Array<[Exclude<Who, 'admin'>, Exclude<Who, 'admin'>]> = [
    ['user1', 'user2'],
    ['user2', 'user1'],
    ['user3', 'user1'],
    ['user3', 'user2'],
  ];

  for (const [attacker, victim] of pairs) {
    it(`${attacker} is denied every route to ${victim}'s CV, result, decisions, sentiment, batch and usage`, async () => {
      const v = created.cv[victim];
      const callsBefore = providerCalls.length;
      const denied = [
        await api.get(attacker, `/api/cv/results/${v.recId}`),
        await api.get(attacker, `/api/cv/results/${v.recId}/decisions`),
        await api.post(attacker, `/api/cv/results/${v.recId}/decision`, { decisionType: 'ACCEPT' }),
        await api.post(attacker, `/api/cv/documents/${v.docId}/classify`, {}),
        await api.get(attacker, `/api/sentiment/results/${created.sentiment[victim].resultId}`),
        await api.get(attacker, `/api/cv/batch/${created.batch[victim]}/status`),
        await api.get(attacker, `/api/usage-logs/${userId[victim]}`),
      ];
      for (const res of denied) {
        expect(res.status, `${res.req.method} ${res.req.path}`).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain(`MARKER-${victim.toUpperCase()}`);
      }
      expect(providerCalls.length, 'no LLM call was made for a denied request').toBe(callsBefore);
      expect(await prisma.recommendationDecision.count({ where: { recommendationId: v.recId, userId: userId[attacker] } })).toBe(0);
    });

    it(`${attacker}'s own lists and analytics never include ${victim}'s records, even with ?userId=${victim}`, async () => {
      const lists = [
        await api.get(attacker, '/api/cv/results'),
        await api.get(attacker, '/api/sentiment/results'),
        await api.get(attacker, '/api/usage-logs'),
        await api.get(attacker, `/api/usage-logs?userId=${userId[victim]}`),
      ];
      for (const res of lists) {
        expect(res.status).toBe(200);
        expect(res.body.data.every((row: { userId: number }) => row.userId === userId[attacker])).toBe(true);
      }
      const own = await api.get(attacker, '/api/analytics/summary');
      const spoofed = await api.get(attacker, `/api/analytics/summary?userId=${userId[victim]}`);
      expect(spoofed.body.data).toEqual(own.body.data);
    });
  }

  it('regular users are denied admin-only endpoints', async () => {
    for (const who of USERS) {
      expect((await api.get(who, '/api/users')).status).toBe(403);
      expect((await api.get(who, '/api/analytics/by-user')).status).toBe(403);
    }
  });
});

// ── Requirement 5: admin access ─────────────────────────────────────────

describe('Requirement 5 - admin can access every user\'s data and global analytics', () => {
  it('admin can open each user\'s CV result, decisions, sentiment result, batch and usage logs', async () => {
    for (const who of USERS) {
      const rec = await api.get('admin', `/api/cv/results/${created.cv[who].recId}`);
      expect(rec.status).toBe(200);
      expect(rec.body.data.userId).toBe(userId[who]);
      expect((await api.get('admin', `/api/cv/results/${created.cv[who].recId}/decisions`)).status).toBe(200);
      const sentiment = await api.get('admin', `/api/sentiment/results/${created.sentiment[who].resultId}`);
      expect(sentiment.status).toBe(200);
      expect(sentiment.body.data.user.email).toBe(EMAIL[who]);
      expect((await api.get('admin', `/api/cv/batch/${created.batch[who]}/status`)).status).toBe(200);
      const logs = await api.get('admin', `/api/usage-logs/${userId[who]}`);
      expect(logs.status).toBe(200);
      expect(logs.body.data.length).toBeGreaterThan(0);
      expect(logs.body.data.every((l: { userId: number }) => l.userId === userId[who])).toBe(true);
    }
  });

  it('admin lists contain every user\'s CV runs, sentiment runs and usage logs', async () => {
    const owners = async (path: string) => new Set((await api.get('admin', path)).body.data.map((r: { userId: number }) => r.userId));
    for (const path of ['/api/cv/results', '/api/sentiment/results', '/api/usage-logs']) {
      const ids = await owners(path);
      for (const who of USERS) expect(ids.has(userId[who]), `${path} includes ${who}`).toBe(true);
    }
    const users = await api.get('admin', '/api/users');
    expect(users.body.data.map((u: { email: string }) => u.email)).toEqual(expect.arrayContaining(Object.values(EMAIL)));
  });

  it('admin analytics are global and match the database exactly', async () => {
    const global = await prisma.llmUsageLog.aggregate({ where: { isSeedData: false }, _sum: { inputTokens: true, outputTokens: true }, _count: { _all: true } });
    const summary = (await api.get('admin', '/api/analytics/summary')).body.data;
    expect(summary).toMatchObject({ totalInputTokens: global._sum.inputTokens, totalOutputTokens: global._sum.outputTokens, callCount: global._count._all });

    const byUser = (await api.get('admin', '/api/analytics/by-user')).body.data as Array<{ userId: number; totalInputTokens: number; totalOutputTokens: number }>;
    for (const who of USERS) {
      const own = await prisma.llmUsageLog.aggregate({ where: { userId: userId[who], isSeedData: false }, _sum: { inputTokens: true, outputTokens: true } });
      expect(byUser.find(u => u.userId === userId[who])).toMatchObject({ totalInputTokens: own._sum.inputTokens, totalOutputTokens: own._sum.outputTokens });
    }
    // Seed demo runs (their usage log has isSeedData: true) are excluded from every metric - docs/ANALYTICS_API.md.
    const runs = (await api.get('admin', '/api/analytics/runs')).body.data;
    expect(runs.last24h).toBe(await prisma.agentRun.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) }, llmUsageLogs: { none: { isSeedData: true } } } }));
    // Successful / failed = agent_runs.status SUCCESS / ERROR over every eligible (non-seed) run.
    expect(await prisma.agentRun.count({ where: { llmUsageLogs: { some: { isSeedData: true } } } })).toBeGreaterThan(0);
    expect(runs.successful).toBe(await prisma.agentRun.count({ where: { status: 'SUCCESS', llmUsageLogs: { none: { isSeedData: true } } } }));
    expect(runs.failed).toBe(await prisma.agentRun.count({ where: { status: 'ERROR', llmUsageLogs: { none: { isSeedData: true } } } }));
  });
});

// ── Requirement 6: dashboard isolation (API responses, not UI hiding) ───

describe('Requirement 6 - each user\'s dashboard API responses contain only their own data; admin\'s are global', () => {
  for (const who of USERS) {
    it(`${who}: every dashboard endpoint is scoped to ${who} and matches the database`, async () => {
      const mine = { userId: userId[who] };
      const realMine = { ...mine, isSeedData: false };

      const summary = (await api.get(who, '/api/analytics/summary')).body.data;
      const agg = await prisma.llmUsageLog.aggregate({ where: realMine, _sum: { inputTokens: true, outputTokens: true, estimatedCost: true }, _count: { _all: true } });
      expect(summary).toMatchObject({ totalInputTokens: agg._sum.inputTokens, totalOutputTokens: agg._sum.outputTokens, callCount: agg._count._all });
      expect(summary.estimatedCost).toBeCloseTo(agg._sum.estimatedCost ?? 0, 10);

      const byAgent = (await api.get(who, '/api/analytics/by-agent')).body.data as Array<{ callCount: number; totalInputTokens: number }>;
      expect(byAgent.reduce((s, a) => s + a.callCount, 0)).toBe(agg._count._all);
      expect(byAgent.reduce((s, a) => s + a.totalInputTokens, 0)).toBe(agg._sum.inputTokens);

      const runs = (await api.get(who, '/api/analytics/runs')).body.data;
      const notSeedRun = { llmUsageLogs: { none: { isSeedData: true } } };
      expect(runs.last24h).toBe(await prisma.agentRun.count({ where: { ...mine, ...notSeedRun, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }));
      expect(await prisma.agentRun.count({ where: { ...mine, llmUsageLogs: { some: { isSeedData: true } } } })).toBeGreaterThan(0);
      expect(runs.successful).toBe(await prisma.agentRun.count({ where: { ...mine, ...notSeedRun, status: 'SUCCESS' } }));
      expect(runs.failed).toBe(await prisma.agentRun.count({ where: { ...mine, ...notSeedRun, status: 'ERROR' } }));

      const errors = (await api.get(who, '/api/analytics/errors')).body.data as Array<{ totalCalls: number }>;
      expect(errors.reduce((s, e) => s + e.totalCalls, 0)).toBe(agg._count._all);
      const latency = (await api.get(who, '/api/analytics/latency')).body.data as Array<{ callCount: number }>;
      expect(latency.reduce((s, l) => s + l.callCount, 0)).toBe(agg._count._all);

      const acceptance = (await api.get(who, '/api/analytics/acceptance-rate')).body.data as Array<{ totalDecisions: number }>;
      expect(acceptance.reduce((s, a) => s + a.totalDecisions, 0)).toBe(await prisma.recommendationDecision.count({ where: { ...mine, recommendation: { run: notSeedRun } } }));

      const logs = (await api.get(who, '/api/usage-logs')).body.data as Array<{ userId: number }>;
      expect(logs.length).toBe(await prisma.llmUsageLog.count({ where: mine }));
      expect(logs.every(l => l.userId === userId[who])).toBe(true);

      const cvResults = (await api.get(who, '/api/cv/results')).body.data as Array<{ userId: number; decisions: Array<{ userId: number }> }>;
      expect(cvResults.length).toBe(await prisma.cvRecommendation.count({ where: mine }));
      expect(cvResults.every(r => r.userId === userId[who] && r.decisions.every(d => d.userId === userId[who]))).toBe(true);

      const sentiment = (await api.get(who, '/api/sentiment/results')).body.data as Array<{ userId: number }>;
      expect(sentiment.length).toBe(await prisma.sentimentResult.count({ where: mine }));
      expect(sentiment.every(r => r.userId === userId[who])).toBe(true);
    });
  }

  it('admin dashboard totals are global (more than any single user) and equal the sum of all users', async () => {
    const admin = (await api.get('admin', '/api/analytics/summary')).body.data;
    let sumIn = 0;
    for (const who of USERS) {
      const own = (await api.get(who, '/api/analytics/summary')).body.data;
      expect(admin.totalInputTokens).toBeGreaterThan(own.totalInputTokens);
      sumIn += own.totalInputTokens;
    }
    expect(admin.totalInputTokens).toBe(sumIn); // admin itself made no LLM calls
  });
});
