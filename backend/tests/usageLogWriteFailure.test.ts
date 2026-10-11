/**
 * F-02 regression: a usage-log row that cannot be written must be reported
 * as NOT persisted (explicit result + USAGE_LOG_WRITE_FAILED event), must
 * never look like a logged row, and must not cause a second provider call.
 *
 * All failures here are real database failures, not mocked Prisma calls:
 * a runId that violates the agent_runs foreign key, an unregistered agent,
 * and (for the HTTP path) a test-only SQLite trigger that aborts inserts for
 * one dedicated test user. Providers are CONTROLLED stubs - no OpenAI calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import logger from '../src/config/logging.js';
import {
  LLMService,
  LLMServiceError,
  type LLMProviderClient,
  type LLMProviderResponse,
} from '../src/services/llmService.js';
import { UsageLogService, USAGE_LOG_WRITE_FAILED_EVENT } from '../src/services/usageLogService.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvClassificationAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';
import { AgentContext } from '../src/types/index.js';
import { cvFeedbackFrom } from './fixtures/cvFeedback.js';

const TEST_AGENT_NAME = 'Usage Log Write Failure Test Agent';
const SERVICE_USER_EMAIL = 'usage-log-failure-service@test.local';
const HTTP_USER_EMAIL = 'usage-log-failure-http@test.local';
const TRIGGER = 'test_f02_block_usage_log_insert';
// Must never appear in the failure event: it stands in for prompt/CV text.
const CONTENT_SENTINEL = 'CONTENT_SENTINEL_MUST_NOT_BE_LOGGED_7731';

let serviceUserId: number;
let httpUserId: number;
let agentId: number;
let context: AgentContext;

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
  const users = await prisma.user.findMany({
    where: { email: { in: [SERVICE_USER_EMAIL, HTTP_USER_EMAIL] } },
    select: { id: true },
  });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: [SERVICE_USER_EMAIL, HTTP_USER_EMAIL] } } });
  await prisma.agent.deleteMany({ where: { name: TEST_AGENT_NAME } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  const serviceUser = await prisma.user.create({ data: { email: SERVICE_USER_EMAIL, password: 'unused-hash', role: 'USER' } });
  const httpUser = await prisma.user.create({ data: { email: HTTP_USER_EMAIL, password: passwordHash, role: 'USER' } });
  const agent = await prisma.agent.create({ data: { name: TEST_AGENT_NAME, description: 'Used only by usageLogWriteFailure.test.ts' } });
  serviceUserId = serviceUser.id;
  httpUserId = httpUser.id;
  agentId = agent.id;
  context = { userId: serviceUser.id, userEmail: serviceUser.email, userRole: 'user' };
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A CONTROLLED provider stub that counts how often it is called. */
function countingClient(impl: () => Promise<LLMProviderResponse>): LLMProviderClient & { calls: () => number } {
  let calls = 0;
  return {
    messages: {
      create: async () => {
        calls += 1;
        return impl();
      },
    },
    calls: () => calls,
  };
}

const successResponse = (id: string): LLMProviderResponse => ({
  id,
  content: [{ type: 'text', text: '{"ok":true}' }],
  model: 'gpt-4o',
  usage: { prompt_tokens: 812, completion_tokens: 97 },
});

async function newRunId(): Promise<string> {
  const run = await prisma.agentRun.create({ data: { userId: serviceUserId, agentId, agentName: TEST_AGENT_NAME } });
  return run.id;
}

function failureEvents(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(args => args[1] as Record<string, unknown> | undefined)
    .filter(meta => meta?.event === USAGE_LOG_WRITE_FAILED_EVENT) as Array<Record<string, unknown>>;
}

describe('usage logging - normal paths report persisted rows', () => {
  it('a successful call returns usageLogPersisted: true and its row exists', async () => {
    const runId = await newRunId();
    const client = countingClient(async () => successResponse('chatcmpl-f02-ok'));
    const result = await new LLMService(client).call({
      systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId, model: 'gpt-4o',
    });

    expect(result.usage.usageLogPersisted).toBe(true);
    const row = await prisma.llmUsageLog.findFirst({ where: { runId } });
    expect(row).not.toBeNull();
    expect(row!.providerResponseId).toBe('chatcmpl-f02-ok');
    expect(row!.inputTokens).toBe(812);
    expect(row!.outputTokens).toBe(97);
    expect(row!.status).toBe('SUCCESS');
  });

  it('a provider error still writes its ERROR row and reports usageLogPersisted: true', async () => {
    const runId = await newRunId();
    const client = countingClient(async () => {
      throw { status: 500, name: 'InternalServerError', message: 'upstream failed' };
    });
    const error = await new LLMService(client)
      .call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId })
      .catch(e => e);

    expect(error).toBeInstanceOf(LLMServiceError);
    expect((error as LLMServiceError).usage.usageLogPersisted).toBe(true);
    const row = await prisma.llmUsageLog.findFirst({ where: { runId } });
    expect(row!.status).toBe('ERROR');
    expect(row!.errorCode).toBe('HTTP_500');
  });

  it('logCall returns the id of the row it wrote', async () => {
    const runId = await newRunId();
    const result = await UsageLogService.logCall({
      timestamp: new Date(), runId, userId: serviceUserId, agentName: TEST_AGENT_NAME, model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 }, latencyMs: 20, status: 'success',
    });
    expect(result.persisted).toBe(true);
    const row = await prisma.llmUsageLog.findFirst({ where: { runId } });
    expect(result).toEqual({ persisted: true, logId: row!.id });
  });
});

describe('usage logging - a failed write is reported, never hidden', () => {
  it('logCall does not throw, returns persisted: false, and writes nothing on a database error', async () => {
    const before = await prisma.llmUsageLog.count();
    const result = await UsageLogService.logCall({
      timestamp: new Date(), runId: randomUUID(), userId: serviceUserId, agentName: TEST_AGENT_NAME, model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 }, latencyMs: 20, status: 'success',
    });
    expect(result).toEqual({ persisted: false, reason: 'DB_WRITE_FAILED' });
    expect(await prisma.llmUsageLog.count()).toBe(before);
  });

  it('logCall reports AGENT_NOT_REGISTERED (not success) for an unknown agent', async () => {
    const spy = vi.spyOn(logger, 'error');
    const before = await prisma.llmUsageLog.count();
    const result = await UsageLogService.logCall({
      timestamp: new Date(), userId: serviceUserId, agentName: 'No Such Agent F02', model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 }, latencyMs: 20, status: 'success',
    });
    expect(result).toEqual({ persisted: false, reason: 'AGENT_NOT_REGISTERED' });
    expect(await prisma.llmUsageLog.count()).toBe(before);
    expect(failureEvents(spy)).toHaveLength(1);
    expect(failureEvents(spy)[0].reason).toBe('AGENT_NOT_REGISTERED');
  });

  it('a successful provider call whose log write fails: result kept, one provider call, flagged, safe event', async () => {
    const spy = vi.spyOn(logger, 'error');
    const orphanRunId = randomUUID(); // violates the llm_usage_logs.runId foreign key
    const client = countingClient(async () => successResponse('chatcmpl-f02-unlogged'));

    const result = await new LLMService(client).call({
      systemInstructions: `system ${CONTENT_SENTINEL}`,
      userContent: `cv ${CONTENT_SENTINEL}`,
      agentName: TEST_AGENT_NAME,
      context,
      runId: orphanRunId,
      model: 'gpt-4o',
    });

    // The paid result is returned, not discarded, and never re-requested.
    expect(client.calls()).toBe(1);
    expect(result.responseText).toBe('{"ok":true}');
    expect(result.usage.status).toBe('success');
    expect(result.usage.inputTokens).toBe(812);
    expect(result.usage.outputTokens).toBe(97);
    expect(result.usage.usageLogPersisted).toBe(false);

    // Nothing was written that could pass for a logged row.
    expect(await prisma.llmUsageLog.count({ where: { runId: orphanRunId } })).toBe(0);
    expect(await prisma.llmUsageLog.count({ where: { providerResponseId: 'chatcmpl-f02-unlogged' } })).toBe(0);

    // Exactly one structured event, with the real provider numbers for reconciliation.
    const events = failureEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'DB_WRITE_FAILED',
      callStatus: 'success',
      runId: orphanRunId,
      userId: serviceUserId,
      agent: TEST_AGENT_NAME,
      model: 'gpt-4o',
      inputTokens: 812,
      outputTokens: 97,
      providerResponseId: 'chatcmpl-f02-unlogged',
    });
    expect(typeof events[0].dbError).toBe('string');
    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(String(events[0].dbError)).not.toContain('data:');
  });

  it('a failed provider call whose log write fails: still throws LLMServiceError, flagged, nothing written', async () => {
    const spy = vi.spyOn(logger, 'error');
    const orphanRunId = randomUUID();
    const client = countingClient(async () => {
      throw { status: 429, name: 'RateLimitError', message: 'Rate limited' };
    });

    const error = await new LLMService(client)
      .call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId: orphanRunId })
      .catch(e => e);

    expect(client.calls()).toBe(1);
    expect(error).toBeInstanceOf(LLMServiceError);
    expect((error as LLMServiceError).usage.status).toBe('error');
    expect((error as LLMServiceError).usage.usageLogPersisted).toBe(false);
    expect(await prisma.llmUsageLog.count({ where: { runId: orphanRunId } })).toBe(0);
    const events = failureEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'DB_WRITE_FAILED', callStatus: 'error', inputTokens: 0, outputTokens: 0 });
  });
});

describe('usage logging - HTTP path when the usage-log insert fails', () => {
  it('CV classify keeps its response contract, makes one provider call, and the run is detectable as unlogged', async () => {
    // Test-only database failure, scoped to one dedicated user in test.db.
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON llm_usage_logs WHEN NEW.userId = ${httpUserId} ` +
        `BEGIN SELECT RAISE(ABORT, 'simulated usage-log write failure'); END`
    );
    const spy = vi.spyOn(logger, 'error');
    const confidence: Record<string, number> = {};
    for (const category of CV_CATEGORIES) confidence[category] = 0;
    confidence['Back-End Developer'] = 0.9;
    const client = countingClient(async () => ({
      id: 'chatcmpl-f02-http',
      content: [{
        type: 'text',
        text: JSON.stringify({
          primaryCategory: 'Back-End Developer',
          secondaryCategories: [],
          confidence,
          rationale: [{ category: 'Back-End Developer', evidence: 'Node.js and Express backend engineer' }],
          feedback: cvFeedbackFrom('Node.js and Express backend engineer'),
        }),
      }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 640, completion_tokens: 120 },
    }));
    __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService(client)));

    try {
      const { accessToken } = await loginAs(HTTP_USER_EMAIL);
      const upload = await request(app)
        .post('/api/cv/documents')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cvContent: 'Experienced Node.js and Express backend engineer, 6 years.', fileName: 'cv.txt' });
      expect(upload.status).toBe(201);

      const classify = await request(app)
        .post(`/api/cv/documents/${upload.body.data.id}/classify`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send();

      // Existing contract unchanged: the classification succeeded and is returned.
      expect(classify.status).toBe(201);
      expect(classify.body.data.primaryCategory).toBe('Back-End Developer');
      expect(client.calls()).toBe(1);

      const runId: string = classify.body.data.runId;
      expect(await prisma.llmUsageLog.count({ where: { runId } })).toBe(0);
      expect(failureEvents(spy).map(e => e.runId)).toEqual([runId]);

      // The documented operator check finds exactly this run.
      const unlogged = await prisma.agentRun.findMany({
        where: { userId: httpUserId, status: 'SUCCESS', llmUsageLogs: { none: {} } },
        select: { id: true },
      });
      expect(unlogged.map(r => r.id)).toEqual([runId]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
  });
});
