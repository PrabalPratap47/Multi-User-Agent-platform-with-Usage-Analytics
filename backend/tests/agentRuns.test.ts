/**
 * F-03: GET /api/runs and GET /api/runs/:id.
 *
 * Runs are produced through the real workflows (single CV classify, batch
 * upload with one rejected file, sentiment success and provider failure)
 * using CONTROLLED stub providers - no OpenAI calls - plus one seed-style
 * run, so every field is checked against what the services actually wrote.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import {
  SentimentAgent,
  sentimentAgent as realSentimentAgent,
  __setSentimentAgentForTesting,
  SENTIMENT_AGENT_NAME,
} from '../src/agents/SentimentAgent.js';
import { LLMService, type LLMProviderRequest, type LLMProviderResponse } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const EMAILS = {
  admin: 'runs-admin@test.local',
  userA: 'runs-user-a@test.local',
  userB: 'runs-user-b@test.local',
  userC: 'runs-user-c@test.local', // never runs anything
} as const;

// Must never appear in any /api/runs response.
const CV_SENTINEL = 'CVSENTINEL_ZEBRAQUOKKA_4417';
const FEEDBACK_SENTINEL = 'FEEDBACKSENTINEL_MARMOSET_9921';
const PROVIDER_DETAIL = 'org-SECRETORG123 rate limit detail';
const CV_TEXT = `Experienced Node.js and Express backend engineer, 6 years. Reference ${CV_SENTINEL}.`;

const ids = { admin: 0, userA: 0, userB: 0, userC: 0 };
const runIds = { singleCv: '', batchOk: '', batchRejected: '', sentimentOk: '', sentimentFailed: '', seed: '' };
let batchId = '';
const tokens: Record<keyof typeof EMAILS, string> = { admin: '', userA: '', userB: '', userC: '' };

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.recommendationDecision.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.sentimentResult.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}

function stubClient(impl: (req: LLMProviderRequest) => Promise<LLMProviderResponse>) {
  return { messages: { create: impl } };
}

function cvResponse(): LLMProviderResponse {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence['Back-End Developer'] = 0.9;
  return {
    id: `chatcmpl-runs-${randomUUID()}`,
    content: [{
      type: 'text',
      text: JSON.stringify({
        primaryCategory: 'Back-End Developer',
        secondaryCategories: [],
        confidence,
        rationale: [{ category: 'Back-End Developer', evidence: 'Node.js and Express backend engineer' }],
      }),
    }],
    model: 'gpt-4o',
    usage: { prompt_tokens: 700, completion_tokens: 110 },
  };
}

async function waitForBatch(id: string, expected: number) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const runs = await prisma.agentRun.findMany({ where: { batchId: id } });
    if (runs.length === expected && runs.every(r => r.status === 'SUCCESS' || r.status === 'ERROR')) return runs;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`batch ${id} did not finish`);
}

const auth = (who: keyof typeof EMAILS) => ({ Authorization: `Bearer ${tokens[who]}` });
const listRuns = (who: keyof typeof EMAILS, query = '') => request(app).get(`/api/runs${query}`).set(auth(who));

beforeAll(async () => {
  await cleanup();
  for (const name of [CV_CLASSIFICATION_AGENT_NAME, SENTIMENT_AGENT_NAME]) {
    await prisma.agent.upsert({ where: { name }, update: {}, create: { name, description: 'Upserted for tests', version: '1.0.0' } });
  }
  const hash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
    const user = await prisma.user.create({
      data: { email: EMAILS[key], password: hash, role: key === 'admin' ? 'ADMIN' : 'USER' },
    });
    ids[key] = user.id;
    tokens[key] = (await loginAs(EMAILS[key])).accessToken;
  }

  // userA: one single-CV classification...
  __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService(stubClient(async () => cvResponse()))));
  const upload = await request(app).post('/api/cv/documents').set(auth('userA')).send({ cvContent: CV_TEXT, fileName: 'single.txt' });
  const classify = await request(app).post(`/api/cv/documents/${upload.body.data.id}/classify`).set(auth('userA')).send();
  expect(classify.status).toBe(201);
  runIds.singleCv = classify.body.data.runId;

  // ...and a batch with one valid file and one rejected before any AI call.
  const batch = await request(app).post('/api/cv/batch').set(auth('userA')).send({
    files: [
      { fileName: 'batch-ok.txt', mimeType: 'text/plain', content: CV_TEXT },
      { fileName: 'batch-bad.pdf', mimeType: 'application/pdf', content: CV_TEXT },
    ],
  });
  expect(batch.status).toBe(202);
  batchId = batch.body.data.batchId;
  const batchRuns = await waitForBatch(batchId, 2);
  runIds.batchOk = batchRuns.find(r => r.status === 'SUCCESS')!.id;
  runIds.batchRejected = batchRuns.find(r => r.status === 'ERROR')!.id;

  // userB: one sentiment success and one provider failure.
  __setSentimentAgentForTesting(new SentimentAgent(new LLMService(stubClient(async req => {
    const feedback = req.messages[0].content.split('\n')[1] ?? '';
    return {
      content: [{ type: 'text', text: JSON.stringify({ sentiment: 'positive', confidence: 0.9, rationale: `Mentions: ${feedback.slice(0, 40)}` }) }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    };
  }))));
  const ok = await request(app).post('/api/sentiment/analyze').set(auth('userB'))
    .send({ text: `Great support team, very helpful and quick. ${FEEDBACK_SENTINEL}` });
  expect(ok.status).toBe(201);
  runIds.sentimentOk = ok.body.data.runId;

  __setSentimentAgentForTesting(new SentimentAgent(new LLMService(stubClient(async () => {
    throw { status: 429, name: 'RateLimitError', message: PROVIDER_DETAIL };
  }))));
  const failed = await request(app).post('/api/sentiment/analyze').set(auth('userB'))
    .send({ text: `The app keeps crashing on login. ${FEEDBACK_SENTINEL}` });
  expect(failed.status).toBe(502);
  const failedRun = await prisma.agentRun.findFirst({
    where: { userId: ids.userB, status: 'ERROR', agentName: SENTIMENT_AGENT_NAME },
    orderBy: { createdAt: 'desc' },
  });
  runIds.sentimentFailed = failedRun!.id;

  // userB: a seed-style demo run (its usage log is flagged isSeedData).
  const sentimentAgent = await prisma.agent.findUnique({ where: { name: SENTIMENT_AGENT_NAME } });
  const seedRun = await prisma.agentRun.create({
    data: { userId: ids.userB, agentId: sentimentAgent!.id, agentName: SENTIMENT_AGENT_NAME, status: 'SUCCESS', completedAt: new Date() },
  });
  await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(), runId: seedRun.id, userId: ids.userB, agentId: sentimentAgent!.id, agentName: SENTIMENT_AGENT_NAME, model: 'gpt-4o',
      inputTokens: 1, outputTokens: 1, latencyMs: 1, status: 'SUCCESS', isSeedData: true,
    },
  });
  runIds.seed = seedRun.id;
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  __setSentimentAgentForTesting(realSentimentAgent);
  await cleanup();
});

describe('GET /api/runs - authentication', () => {
  it('rejects missing, malformed and forged tokens on both endpoints', async () => {
    for (const path of ['/api/runs', `/api/runs/${randomUUID()}`]) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);
      expect((await request(app).get(path).set('Authorization', tokens.userA)).status).toBe(401); // no "Bearer "
    }
  });
});

describe('GET /api/runs - admin scope', () => {
  it('lists runs belonging to multiple users', async () => {
    const owners = new Set<number>();
    const seen = new Set<string>();
    const first = await listRuns('admin', '?limit=100');
    expect(first.status).toBe(200);
    for (let offset = 0; offset < first.body.data.total; offset += 100) {
      const page = await listRuns('admin', `?limit=100&offset=${offset}`);
      for (const run of page.body.data.runs) {
        owners.add(run.user.id);
        seen.add(run.id);
      }
    }
    expect(owners.has(ids.userA)).toBe(true);
    expect(owners.has(ids.userB)).toBe(true);
    for (const id of Object.values(runIds)) expect(seen.has(id)).toBe(true);
    expect(first.body.data.total).toBe(await prisma.agentRun.count());
  });

  it('?userId= narrows to that user, matching the database exactly', async () => {
    for (const key of ['userA', 'userB', 'userC'] as const) {
      const res = await listRuns('admin', `?userId=${ids[key]}&limit=100`);
      expect(res.status).toBe(200);
      const dbIds = (await prisma.agentRun.findMany({ where: { userId: ids[key] }, select: { id: true } })).map(r => r.id).sort();
      expect(res.body.data.runs.map((r: { id: string }) => r.id).sort()).toEqual(dbIds);
      expect(res.body.data.total).toBe(dbIds.length);
      expect(res.body.data.runs.every((r: { user: { id: number } }) => r.user.id === ids[key])).toBe(true);
    }
  });

  it('filters by agent and status', async () => {
    const sentiment = await listRuns('admin', `?userId=${ids.userB}&agent=${encodeURIComponent(SENTIMENT_AGENT_NAME)}&status=ERROR`);
    expect(sentiment.status).toBe(200);
    expect(sentiment.body.data.runs.map((r: { id: string }) => r.id)).toEqual([runIds.sentimentFailed]);

    const cvOk = await listRuns('admin', `?userId=${ids.userA}&agent=${encodeURIComponent(CV_CLASSIFICATION_AGENT_NAME)}&status=SUCCESS`);
    expect(cvOk.body.data.runs.map((r: { id: string }) => r.id).sort()).toEqual([runIds.singleCv, runIds.batchOk].sort());

    const unknownAgent = await listRuns('admin', '?agent=No%20Such%20Agent');
    expect(unknownAgent.status).toBe(200);
    expect(unknownAgent.body.data).toMatchObject({ runs: [], total: 0 });
    expect(unknownAgent.body.data.agents).toEqual(expect.arrayContaining([CV_CLASSIFICATION_AGENT_NAME, SENTIMENT_AGENT_NAME]));
  });

  it('can open any user\'s run by id', async () => {
    const res = await request(app).get(`/api/runs/${runIds.sentimentOk}`).set(auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual({ id: ids.userB, email: EMAILS.userB });
  });
});

describe('GET /api/runs - regular user scope', () => {
  it('a user sees only their own runs', async () => {
    const res = await listRuns('userA', '?limit=100');
    expect(res.status).toBe(200);
    const dbIds = (await prisma.agentRun.findMany({ where: { userId: ids.userA }, select: { id: true } })).map(r => r.id).sort();
    expect(res.body.data.runs.map((r: { id: string }) => r.id).sort()).toEqual(dbIds);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.runs.every((r: { user: { id: number } }) => r.user.id === ids.userA)).toBe(true);
  });

  it('supplying another user\'s id, filters or pagination never widens the scope', async () => {
    const own = (await listRuns('userA', '?limit=100')).body.data;
    for (const query of [
      `?userId=${ids.userB}`,
      `?userId=${ids.admin}`,
      `?userId=${ids.userB}&agent=${encodeURIComponent(SENTIMENT_AGENT_NAME)}`,
      `?userId=${ids.userB}&status=ERROR`,
      '?offset=0&limit=100',
      '?offset=3',
    ]) {
      const res = await listRuns('userA', query);
      expect(res.status).toBe(200);
      for (const run of res.body.data.runs) expect(run.user.id).toBe(ids.userA);
      expect(res.body.data.total).toBeLessThanOrEqual(own.total);
    }
    const spoof = await listRuns('userA', `?userId=${ids.userB}&limit=100`);
    expect(spoof.body.data.runs.map((r: { id: string }) => r.id).sort()).toEqual(own.runs.map((r: { id: string }) => r.id).sort());

    // Header/body spoofing has no effect either.
    const headerSpoof = await request(app).get('/api/runs').set(auth('userA')).set('X-User-Id', String(ids.userB)).send({ userId: ids.userB });
    for (const run of headerSpoof.body.data.runs) expect(run.user.id).toBe(ids.userA);
  });

  it('a user cannot open another user\'s run by id', async () => {
    for (const id of [runIds.sentimentOk, runIds.sentimentFailed, runIds.seed]) {
      const res = await request(app).get(`/api/runs/${id}`).set(auth('userA'));
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(EMAILS.userB);
    }
    expect((await request(app).get(`/api/runs/${runIds.singleCv}`).set(auth('userA'))).status).toBe(200);
  });

  it('a user with no runs gets an empty page, not someone else\'s runs', async () => {
    const res = await listRuns('userC', `?userId=${ids.userA}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ runs: [], total: 0, limit: 25, offset: 0 });
  });
});

describe('GET /api/runs - validation and pagination', () => {
  it('rejects invalid filters and pagination with 400, for users and admins', async () => {
    for (const who of ['userA', 'admin'] as const) {
      for (const query of [
        '?limit=0', '?limit=101', '?limit=abc', '?limit=1e3', '?limit=-5', '?limit=2.5',
        '?offset=-1', '?offset=1.5', '?offset=99999999',
        '?status=DONE', '?status=success', '?status=SUCCESS&status=ERROR',
        '?userId=0', '?userId=abc', '?userId=99999999999', '?userId=1&userId=2',
        '?agent=', `?agent=${'x'.repeat(101)}`,
      ]) {
        const res = await listRuns(who, query);
        expect(res.status, `${who} ${query}`).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('rejects a malformed run id with 400 and an unknown one with 404', async () => {
    expect((await request(app).get('/api/runs/not-a-uuid').set(auth('admin'))).status).toBe(400);
    expect((await request(app).get(`/api/runs/${randomUUID()}`).set(auth('admin'))).status).toBe(404);
    expect((await request(app).get(`/api/runs/${randomUUID()}`).set(auth('userA'))).status).toBe(404);
  });

  it('pages are bounded, disjoint, newest first, and past-the-end pages are empty', async () => {
    const all = (await listRuns('userA', '?limit=100')).body.data.runs as Array<{ id: string; createdAt: string }>;
    const page1 = (await listRuns('userA', '?limit=2&offset=0')).body.data;
    const page2 = (await listRuns('userA', '?limit=2&offset=2')).body.data;
    expect(page1).toMatchObject({ limit: 2, offset: 0, total: 3 });
    expect(page1.runs).toHaveLength(2);
    expect(page2.runs).toHaveLength(1);
    expect([...page1.runs, ...page2.runs].map((r: { id: string }) => r.id)).toEqual(all.map(r => r.id));
    const times = all.map(r => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const past = (await listRuns('userA', '?offset=50')).body.data;
    expect(past).toMatchObject({ runs: [], total: 3 });
  });

  it('defaults to 25 rows per page', async () => {
    const res = await listRuns('admin');
    expect(res.body.data.limit).toBe(25);
    expect(res.body.data.runs.length).toBeLessThanOrEqual(25);
  });
});

describe('GET /api/runs - workflow representation and data exposure', () => {
  async function byId(id: string) {
    const res = await request(app).get(`/api/runs/${id}`).set(auth('admin'));
    expect(res.status).toBe(200);
    return res.body.data;
  }

  it('single CV run: SUCCESS, linked document and recommendation, one logged call', async () => {
    const run = await byId(runIds.singleCv);
    const rec = await prisma.cvRecommendation.findUnique({ where: { runId: runIds.singleCv } });
    expect(run).toMatchObject({
      status: 'SUCCESS', agentName: CV_CLASSIFICATION_AGENT_NAME, batchId: null, cvFileName: 'single.txt',
      errorMessage: null, llmCallsLogged: 1, isSeedData: false,
      result: { type: 'cv_recommendation', id: rec!.id, primaryCategory: 'Back-End Developer' },
    });
    expect(run.completedAt).not.toBeNull();
  });

  it('batch runs: shared batchId; the rejected file is ERROR with its safe reason and no AI call', async () => {
    const ok = await byId(runIds.batchOk);
    const rejected = await byId(runIds.batchRejected);
    expect(ok).toMatchObject({ status: 'SUCCESS', batchId, cvFileName: 'batch-ok.txt', llmCallsLogged: 1 });
    expect(ok.result.type).toBe('cv_recommendation');
    const stored = await prisma.agentRun.findUnique({ where: { id: runIds.batchRejected } });
    expect(rejected).toMatchObject({
      status: 'ERROR', batchId, cvFileName: 'batch-bad.pdf', result: null, llmCallsLogged: 0, errorMessage: stored!.errorMessage,
    });
    expect(rejected.errorMessage).toBeTruthy();
  });

  it('sentiment runs: result reference on success; provider failure shown generically', async () => {
    const ok = await byId(runIds.sentimentOk);
    expect(ok).toMatchObject({ status: 'SUCCESS', agentName: SENTIMENT_AGENT_NAME, cvDocumentId: null, llmCallsLogged: 1 });
    expect(ok.result).toMatchObject({ type: 'sentiment_result', sentiment: 'POSITIVE' });

    const failed = await byId(runIds.sentimentFailed);
    const stored = await prisma.agentRun.findUnique({ where: { id: runIds.sentimentFailed } });
    expect(stored!.errorMessage).toContain(PROVIDER_DETAIL); // the stored record is untouched...
    expect(failed).toMatchObject({ status: 'ERROR', result: null, llmCallsLogged: 1, errorMessage: 'The AI provider request failed.' });
  });

  it('flags seed demo runs instead of hiding or altering them', async () => {
    expect((await byId(runIds.seed)).isSeedData).toBe(true);
    expect((await byId(runIds.sentimentOk)).isSeedData).toBe(false);
  });

  it('never returns CV text, feedback text, provider detail, prompts or token counts', async () => {
    const bodies = [
      JSON.stringify((await listRuns('admin', '?limit=100')).body),
      JSON.stringify((await listRuns('userA', '?limit=100')).body),
      JSON.stringify((await listRuns('userB', '?limit=100')).body),
      ...(await Promise.all(Object.values(runIds).map(async id => JSON.stringify((await request(app).get(`/api/runs/${id}`).set(auth('admin'))).body)))),
    ];
    for (const body of bodies) {
      for (const forbidden of [CV_SENTINEL, FEEDBACK_SENTINEL, PROVIDER_DETAIL, 'org-SECRET', 'inputTokens', 'outputTokens', 'rawResponse', 'rationale', '"content"', 'password']) {
        expect(body).not.toContain(forbidden);
      }
    }
  });
});
