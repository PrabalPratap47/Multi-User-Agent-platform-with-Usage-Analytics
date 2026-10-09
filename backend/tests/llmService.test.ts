import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../src/db/client.js';
import {
  LLMService,
  LLMServiceError,
  MISSING_USAGE_ERROR_CODE,
  type LLMProviderClient,
  type LLMProviderRequest,
  type LLMProviderResponse,
} from '../src/services/llmService.js';
import { calculateCost } from '../src/utils/costCalculator.js';
import { AgentContext } from '../src/types/index.js';

const TEST_AGENT_NAME = 'LLM Service Test Agent';
const TEST_USER_EMAIL = 'llm-service-test-user@test.local';

let userId: number;
let agentId: number;
let context: AgentContext;

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: TEST_USER_EMAIL } });
  if (user) {
    await prisma.llmUsageLog.deleteMany({ where: { userId: user.id } });
  }
  await prisma.user.deleteMany({ where: { email: TEST_USER_EMAIL } });
  await prisma.agent.deleteMany({ where: { name: TEST_AGENT_NAME } });
}

beforeAll(async () => {
  await cleanup();

  const user = await prisma.user.create({
    data: { email: TEST_USER_EMAIL, password: 'unused-hash', role: 'USER' },
  });
  const agent = await prisma.agent.create({
    data: { name: TEST_AGENT_NAME, description: 'Used only by llmService.test.ts' },
  });

  userId = user.id;
  agentId = agent.id;
  context = { userId: user.id, userEmail: user.email, userRole: 'user' };
});

afterAll(async () => {
  await cleanup();
});

function mockClient(
  impl: (req: LLMProviderRequest) => Promise<LLMProviderResponse>
): LLMProviderClient {
  return { messages: { create: impl } };
}

// llm_usage_logs.runId is a real foreign key to agent_runs, so every call
// under test needs an actual run row to attach its usage log to.
async function newRunId(): Promise<string> {
  const run = await prisma.agentRun.create({ data: { userId, agentId, agentName: TEST_AGENT_NAME } });
  return run.id;
}

async function latestLogFor(runId: string) {
  return prisma.llmUsageLog.findFirst({ where: { runId }, orderBy: { id: 'desc' } });
}

describe('LLMService - successful calls', () => {
  it('returns the parsed text and the exact token counts from the provider response', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
        model: 'gpt-4o',
        // Field names match OpenAI's real Chat Completions usage object
        // (prompt_tokens / completion_tokens), not a generic placeholder.
        usage: { prompt_tokens: 500, completion_tokens: 120 },
      }))
    );

    const result = await service.call({
      systemInstructions: 'You are a test agent.',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
      model: 'gpt-4o',
    });

    expect(result.responseText).toBe('{"ok":true}');
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(120);
    expect(result.usage.status).toBe('success');
    expect(result.usage.usageDataMissing).toBeUndefined();
  });

  it('persists a matching llm_usage_logs row with the correct user, agent, model and cost', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'hi' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 500, completion_tokens: 120 },
      }))
    );

    await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
      model: 'gpt-4o',
    });

    const log = await latestLogFor(runId);
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(userId);
    expect(log!.agentId).toBe(agentId);
    expect(log!.agentName).toBe(TEST_AGENT_NAME);
    expect(log!.model).toBe('gpt-4o');
    expect(log!.inputTokens).toBe(500);
    expect(log!.outputTokens).toBe(120);
    expect(log!.status).toBe('SUCCESS');
    expect(log!.errorCode).toBeNull();
    expect(log!.estimatedCost).toBeCloseTo(
      calculateCost({ input_tokens: 500, output_tokens: 120 }, 'gpt-4o'),
      10
    );
  });
});

describe('LLMService - failed calls', () => {
  it('throws LLMServiceError and still persists an ERROR row with 0 tokens and the error details', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { status: 429, name: 'RateLimitError', message: 'Rate limited' };
      })
    );

    await expect(
      service.call({
        systemInstructions: 'sys',
        userContent: 'hello',
        agentName: TEST_AGENT_NAME,
        context,
        runId,
      })
    ).rejects.toThrow(LLMServiceError);

    const log = await latestLogFor(runId);
    expect(log).not.toBeNull();
    expect(log!.status).toBe('ERROR');
    expect(log!.inputTokens).toBe(0);
    expect(log!.outputTokens).toBe(0);
    expect(log!.errorCode).toBe('HTTP_429');
    expect(log!.errorMessage).toBe('Rate limited');
    expect(log!.estimatedCost).toBeCloseTo(0, 10);
  });

  it('wraps a plain network error (no status code) with a sensible error code', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(
      service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId })
    ).rejects.toThrow(LLMServiceError);

    const log = await latestLogFor(runId);
    expect(log!.errorCode).toBe('TypeError');
    expect(log!.errorMessage).toBe('fetch failed');
  });

  it('redacts an API key echoed in a provider error before storing or rethrowing it', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw {
          status: 401,
          name: 'AuthenticationError',
          message: 'Incorrect API key provided: sk-proj-abc*****************wxyz. You can find your API key at ...',
        };
      })
    );

    const error = await service
      .call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMServiceError);
    expect((error as Error).message).not.toMatch(/sk-proj|wxyz/);
    const log = await latestLogFor(runId);
    expect(log!.errorCode).toBe('HTTP_401');
    expect(log!.errorMessage).toContain('sk-[REDACTED]');
    expect(log!.errorMessage).not.toMatch(/sk-proj|wxyz/);
  });
});

describe('LLMService - missing usage fields', () => {
  it('records 0 tokens (not an estimate) and flags MISSING_USAGE_DATA when usage is entirely absent', async () => {
    const runId = await newRunId();
    const longText = 'x'.repeat(5000); // deliberately long - proves tokens are NOT derived from length
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: longText }],
        model: 'gpt-4o',
        // usage intentionally omitted
      }))
    );

    const result = await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
    });

    expect(result.responseText).toBe(longText);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.usageDataMissing).toBe(true);

    const log = await latestLogFor(runId);
    expect(log!.status).toBe('SUCCESS');
    expect(log!.inputTokens).toBe(0);
    expect(log!.outputTokens).toBe(0);
    expect(log!.errorCode).toBe(MISSING_USAGE_ERROR_CODE);
  });

  it('treats a partially-present usage object (only one field) as missing, not a partial estimate', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'partial' }],
        usage: { prompt_tokens: 42 }, // completion_tokens omitted
      }))
    );

    const result = await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
    });

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.usageDataMissing).toBe(true);
  });
});

describe('LLMService - token extraction', () => {
  it('extracts tokens strictly from usage.prompt_tokens/completion_tokens, independent of response or prompt length', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'OK' }], // 2-character response
        usage: { prompt_tokens: 5000, completion_tokens: 3000 }, // deliberately uncorrelated with text length
      }))
    );

    const result = await service.call({
      systemInstructions: 'sys',
      userContent: 'a'.repeat(10000), // long prompt, also uncorrelated with the usage numbers above
      agentName: TEST_AGENT_NAME,
      context,
      runId,
    });

    expect(result.usage.inputTokens).toBe(5000);
    expect(result.usage.outputTokens).toBe(3000);

    const log = await latestLogFor(runId);
    expect(log!.inputTokens).toBe(5000);
    expect(log!.outputTokens).toBe(3000);
  });
});

describe('LLMService - latency calculation', () => {
  it('records latency reflecting real elapsed time around a successful call', async () => {
    const runId = await newRunId();
    const DELAY_MS = 60;
    const service = new LLMService(
      mockClient(async () => {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      })
    );

    const result = await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
    });

    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(result.usage.latencyMs).toBeLessThan(DELAY_MS + 2000);

    const log = await latestLogFor(runId);
    expect(log!.latencyMs).toBe(result.usage.latencyMs);
  });

  it('records latency on the error path too', async () => {
    const runId = await newRunId();
    const DELAY_MS = 40;
    const service = new LLMService(
      mockClient(async () => {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        throw new Error('boom');
      })
    );

    await expect(
      service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId })
    ).rejects.toThrow();

    const log = await latestLogFor(runId);
    expect(log!.latencyMs).toBeGreaterThanOrEqual(DELAY_MS - 5);
  });
});

describe('LLMService - error status and malformed/edge-case responses', () => {
  it('surfaces a provider error status code distinctly for different HTTP errors (e.g. 401 vs 429 vs 500)', async () => {
    const cases: Array<{ status: number; name: string; message: string; expectedCode: string }> = [
      { status: 401, name: 'AuthenticationError', message: 'Invalid API key', expectedCode: 'HTTP_401' },
      { status: 429, name: 'RateLimitError', message: 'Rate limited', expectedCode: 'HTTP_429' },
      { status: 500, name: 'InternalServerError', message: 'Server error', expectedCode: 'HTTP_500' },
    ];

    for (const testCase of cases) {
      const runId = await newRunId();
      const service = new LLMService(
        mockClient(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw { status: testCase.status, name: testCase.name, message: testCase.message };
        })
      );

      await expect(
        service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId })
      ).rejects.toThrow(LLMServiceError);

      const log = await latestLogFor(runId);
      expect(log!.errorCode).toBe(testCase.expectedCode);
      expect(log!.status).toBe('ERROR');
    }
  });

  it('treats a response with a null message content (e.g. a refusal) as empty text, not a crash', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [], // adapter maps a null/missing message.content to an empty content array
        model: 'gpt-4o',
        usage: { prompt_tokens: 15, completion_tokens: 0 },
      }))
    );

    const result = await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
    });

    expect(result.responseText).toBe('');
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.usageDataMissing).toBeUndefined();
  });
});

describe('LLMService - cost calculation integration', () => {
  it('persists an estimatedCost that matches calculateCost() for the actual logged tokens and model', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'hi' }],
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }))
    );

    await service.call({
      systemInstructions: 'sys',
      userContent: 'hello',
      agentName: TEST_AGENT_NAME,
      context,
      runId,
      model: 'gpt-4o-mini',
    });

    const log = await latestLogFor(runId);
    expect(log!.model).toBe('gpt-4o-mini');
    expect(log!.estimatedCost).toBeCloseTo(
      calculateCost({ input_tokens: 1000, output_tokens: 200 }, 'gpt-4o-mini')!,
      10
    );
  });

  it('logs the snapshot model OpenAI reports and prices it at the base model rate', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'hi' }],
        model: 'gpt-4o-mini-2024-07-18',
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }))
    );

    await service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId, model: 'gpt-4o-mini' });

    const log = await latestLogFor(runId);
    expect(log!.model).toBe('gpt-4o-mini-2024-07-18');
    expect(log!.estimatedCost).toBeCloseTo(1000 * (0.15 / 1_000_000) + 200 * (0.6 / 1_000_000), 12);
  });

  it('records a null estimatedCost (not a guess) for a model with no configured price, keeping the real tokens', async () => {
    const runId = await newRunId();
    const service = new LLMService(
      mockClient(async () => ({
        content: [{ type: 'text', text: 'hi' }],
        model: 'some-unpriced-model',
        usage: { prompt_tokens: 300, completion_tokens: 40 },
      }))
    );

    await service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: TEST_AGENT_NAME, context, runId, model: 'some-unpriced-model' });

    const log = await latestLogFor(runId);
    expect(log!.inputTokens).toBe(300);
    expect(log!.outputTokens).toBe(40);
    expect(log!.estimatedCost).toBeNull();
  });
});
