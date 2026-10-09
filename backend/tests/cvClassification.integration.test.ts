import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  LLMService,
  type LLMProviderClient,
  type LLMProviderRequest,
  type LLMProviderResponse,
} from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const EMAILS = {
  userA: 'cv-integration-user-a@test.local',
  userB: 'cv-integration-user-b@test.local',
  admin: 'cv-integration-admin@test.local',
} as const;

let userAId: number;
let userBId: number;

async function cleanup() {
  const emails = Object.values(EMAILS);
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map(u => u.id);

  if (userIds.length > 0) {
    await prisma.recommendationDecision.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(async () => {
  await cleanup();

  // Shared with cvClassificationAgent.test.ts - upserted, never deleted.
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });

  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  const userA = await prisma.user.create({ data: { email: EMAILS.userA, password: passwordHash, role: 'USER' } });
  const userB = await prisma.user.create({ data: { email: EMAILS.userB, password: passwordHash, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAILS.admin, password: passwordHash, role: 'ADMIN' } });

  userAId = userA.id;
  userBId = userB.id;
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

function mockClient(
  responses: Array<(req: LLMProviderRequest) => Promise<LLMProviderResponse>>
): LLMProviderClient {
  let call = 0;
  return {
    messages: {
      create: async req => {
        const impl = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return impl(req);
      },
    },
  };
}

// `evidence` is a required parameter, not a generic default - the
// agent's outputGuard checks that primaryCategory's rationale shares
// real vocabulary with the CV text, so every call site must supply
// evidence actually grounded in whatever CV content that test sends.
function validResponseText(primary: string, evidence: string): string {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence[primary] = 0.9;
  return JSON.stringify({
    primaryCategory: primary,
    secondaryCategories: [],
    confidence,
    rationale: [{ category: primary, evidence }],
  });
}

/** Injects a mock-backed agent as the singleton the real controller/service use. */
function useAgentReturning(primary: string, evidence: string) {
  __setCvClassificationAgentForTesting(
    new CVClassificationAgent(new LLMService(mockClient([async () => ({
      content: [{ type: 'text', text: validResponseText(primary, evidence) }],
      usage: { input_tokens: 400, output_tokens: 90 },
    })])))
  );
}

function useAgentAlwaysFailing(sentinel: string) {
  __setCvClassificationAgentForTesting(
    new CVClassificationAgent(
      new LLMService(
        mockClient([
          async () => ({ content: [{ type: 'text', text: sentinel }], usage: { input_tokens: 5, output_tokens: 5 } }),
        ])
      )
    )
  );
}

describe('CV classification API - authentication', () => {
  it('rejects unauthenticated requests to every CV endpoint', async () => {
    const responses = await Promise.all([
      request(app).post('/api/cv/documents').send({ cvContent: 'x'.repeat(20) }),
      request(app).post('/api/cv/classify').send({ cvContent: 'x'.repeat(20) }),
      request(app).get('/api/cv/results'),
      request(app).get('/api/cv/results/1'),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
    }
  });
});

describe('CV classification API - happy path', () => {
  it('uploads a document, classifies it, and retrieves the result - end to end', async () => {
    useAgentReturning('Back-End Developer', '6 years as a Node.js and Express backend engineer.');
    const { accessToken } = await loginAs(EMAILS.userA);

    const uploadRes = await request(app)
      .post('/api/cv/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ cvContent: 'Experienced Node.js and Express backend engineer, 6 years.', fileName: 'cv.txt' });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.userId).toBe(userAId);
    const documentId = uploadRes.body.data.id;

    const classifyRes = await request(app)
      .post(`/api/cv/documents/${documentId}/classify`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    expect(classifyRes.status).toBe(201);
    expect(classifyRes.body.data.primaryCategory).toBe('Back-End Developer');
    expect(classifyRes.body.data.userId).toBe(userAId);
    expect(classifyRes.body.data.cvDocumentId).toBe(documentId);
    const recommendationId = classifyRes.body.data.id;
    const runId = classifyRes.body.data.runId;

    const getRes = await request(app)
      .get(`/api/cv/results/${recommendationId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(recommendationId);

    const listRes = await request(app).get('/api/cv/results').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((r: { id: number }) => r.id === recommendationId)).toBe(true);

    // Storage requirements: CV, result, original recommendation, run id,
    // authenticated user id, and timestamps are all actually persisted.
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('SUCCESS');
    expect(run!.userId).toBe(userAId);

    const log = await prisma.llmUsageLog.findFirst({ where: { runId } });
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(userAId);

    const document = await prisma.cvDocument.findUnique({ where: { id: documentId } });
    expect(document!.createdAt).toBeInstanceOf(Date);

    const recommendation = await prisma.cvRecommendation.findUnique({ where: { id: recommendationId } });
    expect(recommendation!.createdAt).toBeInstanceOf(Date);
    expect(recommendation!.runId).toBe(runId);
  });

  it('the convenience /classify endpoint creates both a document and a recommendation in one call', async () => {
    useAgentReturning('Web Automation', 'QA engineer automating web UIs with Playwright and Selenium for 3 years.');
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/cv/classify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ cvContent: 'QA engineer automating web UIs with Playwright and Selenium for 3 years.' });

    expect(res.status).toBe(201);
    expect(res.body.data.primaryCategory).toBe('Web Automation');

    const document = await prisma.cvDocument.findUnique({ where: { id: res.body.data.cvDocumentId } });
    expect(document).not.toBeNull();
    expect(document!.userId).toBe(userAId);
  });
});

describe('CV classification API - cross-user isolation', () => {
  it('forbids user B from classifying user A\'s document', async () => {
    useAgentReturning('Other', 'Some CV content belonging to user A.');
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const uploadRes = await request(app)
      .post('/api/cv/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ cvContent: 'Some CV content belonging to user A, long enough to pass validation.' });
    const documentId = uploadRes.body.data.id;

    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    const res = await request(app)
      .post(`/api/cv/documents/${documentId}/classify`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send();

    expect(res.status).toBe(403);
  });

  it('forbids user B from retrieving user A\'s result', async () => {
    useAgentReturning('Mobile Automation', 'Mobile QA engineer using Appium and Espresso for 4 years.');
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const classifyRes = await request(app)
      .post('/api/cv/classify')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ cvContent: 'Mobile QA engineer using Appium and Espresso for 4 years.' });
    const resultId = classifyRes.body.data.id;

    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    const res = await request(app)
      .get(`/api/cv/results/${resultId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });

  it('an admin can classify and view any user\'s document/result, which stays attributed to that user', async () => {
    useAgentReturning('AI Engineer', 'User A CV mentioning RAG pipelines and LLM fine-tuning work.');
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const uploadRes = await request(app)
      .post('/api/cv/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ cvContent: 'User A CV mentioning RAG pipelines and LLM fine-tuning work.' });
    const documentId = uploadRes.body.data.id;

    const { accessToken: adminToken } = await loginAs(EMAILS.admin);
    const classifyRes = await request(app)
      .post(`/api/cv/documents/${documentId}/classify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send();

    expect(classifyRes.status).toBe(201);
    // Attributed to the document's owner (user A), not the admin who
    // triggered it.
    expect(classifyRes.body.data.userId).toBe(userAId);

    const getRes = await request(app)
      .get(`/api/cv/results/${classifyRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);
  });
});

describe('CV classification API - validation and safe failure', () => {
  it('rejects CV content that is too short with a 400', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const res = await request(app)
      .post('/api/cv/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ cvContent: 'short' });

    expect(res.status).toBe(400);
  });

  it('rejects whitespace-only or whitespace-padded short CV content on both upload routes, without storing it or calling the agent', async () => {
    // Regression (Step 18 E2E): batch upload and the UI already trim before
    // the 10-character minimum; the single-CV routes accepted 40 spaces.
    let agentCalls = 0;
    __setCvClassificationAgentForTesting(
      new CVClassificationAgent(
        new LLMService(
          mockClient([
            async () => {
              agentCalls += 1;
              return { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } };
            },
          ])
        )
      )
    );
    const { accessToken } = await loginAs(EMAILS.userA);
    const documentsBefore = await prisma.cvDocument.count({ where: { userId: userAId } });

    for (const cvContent of [' '.repeat(40), `\n\t  tiny  ${' '.repeat(20)}\n`]) {
      for (const path of ['/api/cv/documents', '/api/cv/classify']) {
        const res = await request(app).post(path).set('Authorization', `Bearer ${accessToken}`).send({ cvContent });
        expect(res.status).toBe(400);
      }
    }
    expect(await prisma.cvDocument.count({ where: { userId: userAId } })).toBe(documentsBefore);
    expect(agentCalls).toBe(0);
  });

  it('returns a safe 502 (not the raw model output) when classification fails validation even after repair', async () => {
    const sentinel = 'SENTINEL_RAW_GARBAGE_TEXT_NOT_JSON_AT_ALL';
    useAgentAlwaysFailing(sentinel);
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/cv/classify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ cvContent: 'A CV long enough to pass the length check for this request.' });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(sentinel);
  });

  it('returns a 502 with the redacted provider reason (not a generic 500) when the AI provider call fails, and records it on the run', async () => {
    __setCvClassificationAgentForTesting(
      new CVClassificationAgent(
        new LLMService(
          mockClient([
            async () => {
              // eslint-disable-next-line @typescript-eslint/no-throw-literal
              throw { status: 401, name: 'AuthenticationError', message: 'Incorrect API key provided: sk-proj-abcd****wxyz.' };
            },
          ])
        )
      )
    );
    const { accessToken } = await loginAs(EMAILS.userA);

    const res = await request(app)
      .post('/api/cv/classify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ cvContent: 'A CV long enough to pass the length check for this request.' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The AI provider request failed: Incorrect API key provided: sk-[REDACTED].');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-proj|wxyz/);

    const run = await prisma.agentRun.findFirst({ where: { userId: userAId }, orderBy: { createdAt: 'desc' } });
    expect(run).toMatchObject({ status: 'ERROR', errorMessage: res.body.error });
    expect(run!.cvDocumentId).not.toBeNull();
  });
});
