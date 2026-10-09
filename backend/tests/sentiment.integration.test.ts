import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import {
  SentimentAgent,
  sentimentAgent as realSentimentAgent,
  __setSentimentAgentForTesting,
  SENTIMENT_AGENT_NAME,
} from '../src/agents/SentimentAgent.js';
import {
  LLMService,
  type LLMProviderClient,
  type LLMProviderRequest,
  type LLMProviderResponse,
} from '../src/services/llmService.js';

const EMAILS = {
  user1: 'sentiment-user-1@test.local',
  user2: 'sentiment-user-2@test.local',
  admin: 'sentiment-admin@test.local',
} as const;

const FEEDBACK = 'The onboarding was fast and the support team answered every question within minutes.';
const ids: Record<keyof typeof EMAILS, number> = { user1: 0, user2: 0, admin: 0 };

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.sentimentResult.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}

function mockClient(impl: (req: LLMProviderRequest) => Promise<LLMProviderResponse>): LLMProviderClient {
  return { messages: { create: impl } };
}

function useAgent(impl: (req: LLMProviderRequest) => Promise<LLMProviderResponse>) {
  __setSentimentAgentForTesting(new SentimentAgent(new LLMService(mockClient(impl))));
}

// The agent rejects rationales that share no words with the feedback, so the
// mock quotes the start of whatever feedback it was given.
const positiveResponse = async (req: LLMProviderRequest): Promise<LLMProviderResponse> => {
  const feedback = req.messages[0].content.split('\n')[1] ?? '';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ sentiment: 'positive', confidence: 0.92, rationale: `Mentions: ${feedback.slice(0, 40)}` }),
      },
    ],
    model: 'gpt-4o-mini-2024-07-18',
    usage: { prompt_tokens: 412, completion_tokens: 37 },
  };
};

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: SENTIMENT_AGENT_NAME },
    update: {},
    create: { name: SENTIMENT_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  ids.user1 = (await prisma.user.create({ data: { email: EMAILS.user1, password: passwordHash, role: 'USER' } })).id;
  ids.user2 = (await prisma.user.create({ data: { email: EMAILS.user2, password: passwordHash, role: 'USER' } })).id;
  ids.admin = (await prisma.user.create({ data: { email: EMAILS.admin, password: passwordHash, role: 'ADMIN' } })).id;
});

afterAll(async () => {
  __setSentimentAgentForTesting(realSentimentAgent);
  await cleanup();
});

beforeEach(() => useAgent(positiveResponse));

async function analyzeAs(email: string, body: Record<string, unknown>) {
  const { accessToken } = await loginAs(email);
  return request(app).post('/api/sentiment/analyze').set('Authorization', `Bearer ${accessToken}`).send(body);
}

describe('Sentiment API - authentication', () => {
  it('rejects unauthenticated requests to every sentiment endpoint', async () => {
    expect((await request(app).post('/api/sentiment/analyze').send({ text: FEEDBACK })).status).toBe(401);
    expect((await request(app).get('/api/sentiment/results')).status).toBe(401);
    expect((await request(app).get('/api/sentiment/results/1')).status).toBe(401);
  });
});

describe('Sentiment API - analyze, store and log usage', () => {
  it('stores the result for the authenticated user and ignores a client-supplied userId', async () => {
    const res = await analyzeAs(EMAILS.user1, { text: FEEDBACK, userId: ids.user2 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      userId: ids.user1,
      inputText: FEEDBACK,
      sentiment: 'POSITIVE',
      confidence: 0.92,
      rationale: `Mentions: ${FEEDBACK.slice(0, 40)}`.trim(),
    });

    const stored = await prisma.sentimentResult.findUnique({ where: { id: res.body.data.id } });
    expect(stored?.userId).toBe(ids.user1);
    const run = await prisma.agentRun.findUnique({ where: { id: res.body.data.runId } });
    expect(run).toMatchObject({ userId: ids.user1, agentName: SENTIMENT_AGENT_NAME, status: 'SUCCESS' });
  });

  it('writes an llm_usage_logs row with the provider-reported tokens for the same user and run', async () => {
    const res = await analyzeAs(EMAILS.user1, { text: FEEDBACK });
    const logs = await prisma.llmUsageLog.findMany({ where: { runId: res.body.data.runId } });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      userId: ids.user1,
      agentName: SENTIMENT_AGENT_NAME,
      model: 'gpt-4o-mini-2024-07-18',
      inputTokens: 412,
      outputTokens: 37,
      status: 'SUCCESS',
      isSeedData: false,
    });
    expect(logs[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(logs[0].estimatedCost).toBeCloseTo(412 * (0.15 / 1_000_000) + 37 * (0.6 / 1_000_000), 12);
  });

  it('rejects empty and over-long text with 400, creating no run and no usage log', async () => {
    const runsBefore = await prisma.agentRun.count({ where: { userId: ids.user1 } });
    const logsBefore = await prisma.llmUsageLog.count({ where: { userId: ids.user1 } });

    expect((await analyzeAs(EMAILS.user1, { text: '' })).status).toBe(400);
    expect((await analyzeAs(EMAILS.user1, { text: 'x'.repeat(5001) })).status).toBe(400);
    expect((await analyzeAs(EMAILS.user1, {})).status).toBe(400);

    expect(await prisma.agentRun.count({ where: { userId: ids.user1 } })).toBe(runsBefore);
    expect(await prisma.llmUsageLog.count({ where: { userId: ids.user1 } })).toBe(logsBefore);
  });
});

describe('Sentiment API - failures are safe and still logged', () => {
  it('returns a safe 502 for an invalid model response, logs both attempts, and records the reason on the run', async () => {
    useAgent(async () => ({ content: [{ type: 'text', text: 'RAW_MODEL_GARBAGE' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
    const res = await analyzeAs(EMAILS.user1, { text: FEEDBACK });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('RAW_MODEL_GARBAGE');

    const run = await prisma.agentRun.findFirst({ where: { userId: ids.user1, agentName: SENTIMENT_AGENT_NAME }, orderBy: { createdAt: 'desc' } });
    expect(run).toMatchObject({ status: 'ERROR', errorMessage: 'The AI response did not pass validation, even after one automatic retry.' });
    expect(await prisma.llmUsageLog.count({ where: { runId: run!.id } })).toBe(2);
    expect(await prisma.sentimentResult.count({ where: { runId: run!.id } })).toBe(0);
  });

  it('returns a 502 with a redacted reason (not a generic 500) when the AI provider call fails', async () => {
    useAgent(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { status: 401, name: 'AuthenticationError', message: 'Incorrect API key provided: sk-proj-abcd****wxyz.' };
    });
    const res = await analyzeAs(EMAILS.user1, { text: FEEDBACK });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The AI provider request failed: Incorrect API key provided: sk-[REDACTED].');
    const run = await prisma.agentRun.findFirst({ where: { userId: ids.user1, agentName: SENTIMENT_AGENT_NAME }, orderBy: { createdAt: 'desc' } });
    const log = await prisma.llmUsageLog.findFirst({ where: { runId: run!.id } });
    expect(log).toMatchObject({ status: 'ERROR', errorCode: 'HTTP_401', inputTokens: 0, outputTokens: 0 });
  });
});

describe('Sentiment API - ownership', () => {
  let user1ResultId: number;
  let user2ResultId: number;

  beforeAll(async () => {
    useAgent(positiveResponse);
    user1ResultId = (await analyzeAs(EMAILS.user1, { text: FEEDBACK })).body.data.id;
    user2ResultId = (await analyzeAs(EMAILS.user2, { text: 'Checkout kept failing and nobody replied to my ticket.' })).body.data.id;
  });

  it('user1 can view their own result and list only their own results', async () => {
    const { accessToken } = await loginAs(EMAILS.user1);
    const one = await request(app).get(`/api/sentiment/results/${user1ResultId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: user1ResultId, userId: ids.user1, user: { email: EMAILS.user1 } });

    const list = await request(app).get('/api/sentiment/results').set('Authorization', `Bearer ${accessToken}`);
    const owners = new Set(list.body.data.map((r: { userId: number }) => r.userId));
    expect([...owners]).toEqual([ids.user1]);
  });

  it("user2 cannot view user1's result, and never sees it in their list", async () => {
    const { accessToken } = await loginAs(EMAILS.user2);
    const res = await request(app).get(`/api/sentiment/results/${user1ResultId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(FEEDBACK);

    const list = await request(app).get('/api/sentiment/results').set('Authorization', `Bearer ${accessToken}`);
    const listIds = list.body.data.map((r: { id: number }) => r.id);
    expect(listIds).toContain(user2ResultId);
    expect(listIds).not.toContain(user1ResultId);
  });

  it("admin can view any user's result and lists results from every user with the owner's email", async () => {
    const { accessToken } = await loginAs(EMAILS.admin);
    const one = await request(app).get(`/api/sentiment/results/${user1ResultId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(one.status).toBe(200);
    expect(one.body.data.user.email).toBe(EMAILS.user1);

    const list = await request(app).get('/api/sentiment/results').set('Authorization', `Bearer ${accessToken}`);
    const emails = new Set(list.body.data.map((r: { user: { email: string } }) => r.user.email));
    expect(emails.has(EMAILS.user1)).toBe(true);
    expect(emails.has(EMAILS.user2)).toBe(true);
  });

  it('returns 404 for a result that does not exist', async () => {
    const { accessToken } = await loginAs(EMAILS.user1);
    const res = await request(app).get('/api/sentiment/results/999999').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });
});
