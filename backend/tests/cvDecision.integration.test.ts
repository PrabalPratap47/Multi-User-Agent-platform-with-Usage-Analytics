import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import { cvFeedbackFrom } from './fixtures/cvFeedback.js';
import config from '../src/config/env.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvClassificationAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import { LLMService, type LLMProviderClient, type LLMProviderResponse } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';

const EMAILS = {
  userA: 'cv-decision-user-a@test.local',
  userB: 'cv-decision-user-b@test.local',
} as const;

let userAId: number;

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

  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });

  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  const userA = await prisma.user.create({ data: { email: EMAILS.userA, password: passwordHash, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAILS.userB, password: passwordHash, role: 'USER' } });
  userAId = userA.id;
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

function mockClient(response: LLMProviderResponse): LLMProviderClient {
  return { messages: { create: async () => response } };
}

function validResponseText(primary: string, evidence: string): string {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence[primary] = 0.9;
  return JSON.stringify({
    primaryCategory: primary,
    secondaryCategories: [],
    confidence,
    rationale: [{ category: primary, evidence }],
    feedback: cvFeedbackFrom(evidence),
  });
}

/** Creates a fresh recommendation for userA to decide on in each test. */
async function createRecommendationForUserA(): Promise<{ id: number; accessToken: string }> {
  __setCvClassificationAgentForTesting(
    new CVClassificationAgent(
      new LLMService(
        mockClient({
          content: [
            {
              type: 'text',
              text: validResponseText(
                'Back-End Developer',
                '5 years building REST APIs with Node.js and Express.'
              ),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        })
      )
    )
  );

  const { accessToken } = await loginAs(EMAILS.userA);
  const res = await request(app)
    .post('/api/cv/classify')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ cvContent: '5 years building REST APIs with Node.js and Express.' });

  return { id: res.body.data.id, accessToken };
}

describe('CV decision workflow - ACCEPT', () => {
  it('accepts the original recommendation as the final decision', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ decisionType: 'ACCEPT' });

    expect(res.status).toBe(201);
    expect(res.body.data.decisionType).toBe('ACCEPT');
    expect(res.body.data.finalPrimaryCategory).toBe('Back-End Developer');
    expect(res.body.data.finalSecondaryCategories).toEqual([]);
    expect(res.body.data.recommendationId).toBe(id);
    expect(res.body.data.userId).toBe(userAId);
    expect(res.body.data.reason).toBeNull();

    // Storage requirements: decision ID, user ID, CV ID, agent run ID,
    // original recommendation, final decision/category, reason, timestamp.
    const stored = await prisma.recommendationDecision.findUnique({ where: { id: res.body.data.id } });
    expect(stored).not.toBeNull();
    expect(stored!.cvDocumentId).toBeTypeOf('number');
    expect(stored!.agentRunId).toBeTypeOf('string');
    expect(stored!.timestamp).toBeInstanceOf(Date);

    const recommendation = await prisma.cvRecommendation.findUnique({ where: { id } });
    expect(stored!.cvDocumentId).toBe(recommendation!.cvDocumentId);
    expect(stored!.agentRunId).toBe(recommendation!.runId);
  });
});

describe('CV decision workflow - MODIFY', () => {
  it('fails without a reason', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ decisionType: 'MODIFY', finalPrimaryCategory: 'Front-End Developer' });

    expect(res.status).toBe(400);

    const count = await prisma.recommendationDecision.count({ where: { recommendationId: id } });
    expect(count).toBe(0);
  });

  it('succeeds with a reason and a different primary category', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        decisionType: 'MODIFY',
        finalPrimaryCategory: 'Front-End Developer',
        reason: 'Reviewer judged the frontend work as more representative of this role.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.decisionType).toBe('MODIFY');
    expect(res.body.data.finalPrimaryCategory).toBe('Front-End Developer');
    expect(res.body.data.reason).toBe('Reviewer judged the frontend work as more representative of this role.');
  });

  it('rejects a MODIFY that does not actually change anything from the original', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        decisionType: 'MODIFY',
        finalPrimaryCategory: 'Back-End Developer', // same as the original
        reason: 'No real change.',
      });

    expect(res.status).toBe(400);
  });
});

describe('CV decision workflow - REJECT', () => {
  it('fails without a reason', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ decisionType: 'REJECT' });

    expect(res.status).toBe(400);

    const count = await prisma.recommendationDecision.count({ where: { recommendationId: id } });
    expect(count).toBe(0);
  });

  it('succeeds with a reason, and stores no final category', async () => {
    const { id, accessToken } = await createRecommendationForUserA();

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ decisionType: 'REJECT', reason: 'This classification does not match the candidate at all.' });

    expect(res.status).toBe(201);
    expect(res.body.data.decisionType).toBe('REJECT');
    expect(res.body.data.finalPrimaryCategory).toBeNull();
    expect(res.body.data.finalSecondaryCategories).toEqual([]);
    expect(res.body.data.reason).toBe('This classification does not match the candidate at all.');
  });
});

describe('CV decision workflow - authorization', () => {
  it('rejects an unauthenticated decision request', async () => {
    const { id } = await createRecommendationForUserA();

    const res = await request(app).post(`/api/cv/results/${id}/decision`).send({ decisionType: 'ACCEPT' });

    expect(res.status).toBe(401);
  });

  it('forbids user B from deciding on user A\'s recommendation', async () => {
    const { id } = await createRecommendationForUserA();
    const { accessToken: tokenB } = await loginAs(EMAILS.userB);

    const res = await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ decisionType: 'ACCEPT' });

    expect(res.status).toBe(403);

    const count = await prisma.recommendationDecision.count({ where: { recommendationId: id } });
    expect(count).toBe(0);
  });

  it('forbids user B from listing decisions on user A\'s recommendation', async () => {
    const { id, accessToken } = await createRecommendationForUserA();
    await request(app)
      .post(`/api/cv/results/${id}/decision`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ decisionType: 'ACCEPT' });

    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    const res = await request(app)
      .get(`/api/cv/results/${id}/decisions`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });
});
