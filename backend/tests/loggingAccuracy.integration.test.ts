import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { LLMService, createOpenAIClient } from '../src/services/llmService.js';
import { auditLoggingAccuracy, type LoggedUsageRow, type RawProviderCall } from '../src/evaluation/loggingAccuracy.js';

/**
 * End-to-end check of the logging path the audit relies on: OpenAI-format
 * HTTP responses go through the REAL OpenAI SDK and the production adapter
 * (createOpenAIClient), LLMService and UsageLogService, then the dashboard
 * endpoint. The HTTP bodies are canned here so the test runs without an API
 * key; the real-call audit is `npm run audit:logging-accuracy`.
 */

const EMAIL = 'logging-accuracy-it@test.local';
const AGENT = 'Logging Accuracy Test Agent';
let userId: number;
let agentId: number;

const RESPONSES = [
  { id: 'chatcmpl-it-1', model: 'gpt-4o-2024-08-06', usage: { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955, prompt_tokens_details: { cached_tokens: 0 } } },
  { id: 'chatcmpl-it-2', model: 'gpt-4o-2024-08-06', usage: { prompt_tokens: 1290, completion_tokens: 201, total_tokens: 1491 } },
  { id: 'chatcmpl-it-3', model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 377, completion_tokens: 38, total_tokens: 415 } },
];

/** A fetch that answers like the OpenAI API and records what it sent, like the audit's recording fetch. */
function cannedOpenAIFetch(queue: Array<{ status: number; body: unknown }>, captures: RawProviderCall[]): typeof fetch {
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('no canned response left');
    const body = next.body as { id?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    captures.push({
      providerResponseId: body.id ?? `no-id-http-${next.status}-${captures.length}`,
      httpStatus: next.status,
      model: body.model ?? '',
      promptTokens: body.usage?.prompt_tokens ?? null,
      completionTokens: body.usage?.completion_tokens ?? null,
      rawUsage: body.usage ?? null,
    });
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
}

function chatCompletion(r: (typeof RESPONSES)[number]) {
  return {
    id: r.id,
    object: 'chat.completion',
    created: 1760000000,
    model: r.model,
    choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}', refusal: null }, finish_reason: 'stop', logprobs: null }],
    usage: r.usage,
  };
}

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (user) {
    await prisma.llmUsageLog.deleteMany({ where: { userId: user.id } });
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  }
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.agent.deleteMany({ where: { name: AGENT } });
}

async function loggedRows(): Promise<LoggedUsageRow[]> {
  const rows = await prisma.llmUsageLog.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  return rows.map(r => ({
    id: r.id,
    runId: r.runId,
    agentName: r.agentName,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    status: r.status,
    providerResponseId: r.providerResponseId,
  }));
}

async function dashboardTotals() {
  const { accessToken } = await loginAs(EMAIL);
  const res = await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${accessToken}`);
  expect(res.status).toBe(200);
  return res.body.data as { totalInputTokens: number; totalOutputTokens: number; callCount: number };
}

const captures: RawProviderCall[] = [];

beforeAll(async () => {
  await cleanup();
  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  userId = (await prisma.user.create({ data: { email: EMAIL, password: passwordHash, role: 'USER' } })).id;
  agentId = (await prisma.agent.create({ data: { name: AGENT } })).id;

  const queue = [
    ...RESPONSES.map(r => ({ status: 200, body: chatCompletion(r) })),
    { status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-abcd****wxyz.', type: 'invalid_request_error', code: 'invalid_api_key' } } },
  ];
  const service = new LLMService(createOpenAIClient({ apiKey: 'test-key-not-real', fetch: cannedOpenAIFetch(queue, captures) }));
  const context = { userId, userEmail: EMAIL, userRole: 'user' as const };

  for (const r of RESPONSES) {
    const run = await prisma.agentRun.create({ data: { userId, agentId, agentName: AGENT } });
    await service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: AGENT, context, runId: run.id, model: r.model.startsWith('gpt-4o-mini') ? 'gpt-4o-mini' : 'gpt-4o' });
  }
  const failedRun = await prisma.agentRun.create({ data: { userId, agentId, agentName: AGENT } });
  await expect(service.call({ systemInstructions: 'sys', userContent: 'hello', agentName: AGENT, context, runId: failedRun.id })).rejects.toThrow();
});

afterAll(async () => {
  await prisma.agentRun.deleteMany({ where: { userId } });
  await cleanup();
});

describe('Logging accuracy - real OpenAI SDK path, DB rows and dashboard', () => {
  it('stores exactly the raw usage.prompt_tokens / usage.completion_tokens, model and response id for every successful call', async () => {
    const rows = await loggedRows();
    for (const r of RESPONSES) {
      const row = rows.find(x => x.providerResponseId === r.id);
      expect(row, r.id).toBeDefined();
      expect(row!.inputTokens).toBe(r.usage.prompt_tokens);
      expect(row!.outputTokens).toBe(r.usage.completion_tokens);
      expect(row!.model).toBe(r.model);
      expect(row!.status).toBe('SUCCESS');
    }
  });

  it('logs the failed (HTTP 401) call as ERROR with 0 tokens and no provider response id', async () => {
    const errorRows = (await loggedRows()).filter(r => r.status === 'ERROR');
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, providerResponseId: null });
  });

  it('raw sum = logged sum = dashboard total, with every per-call difference 0', async () => {
    const result = auditLoggingAccuracy(captures, await loggedRows(), await dashboardTotals());

    expect(result.calls).toHaveLength(3);
    expect(result.calls.every(c => c.inputDifference === 0 && c.outputDifference === 0)).toBe(true);
    expect(result.totals).toMatchObject({
      rawInputTotal: 812 + 1290 + 377,
      loggedInputTotal: 812 + 1290 + 377,
      dashboardInputTotal: 812 + 1290 + 377,
      rawOutputTotal: 143 + 201 + 38,
      loggedOutputTotal: 143 + 201 + 38,
      dashboardOutputTotal: 143 + 201 + 38,
    });
    expect(result.pass).toBe(true);
  });

  it('negative control: the audit FAILS if a stored row is altered by one token', async () => {
    const row = await prisma.llmUsageLog.findFirst({ where: { providerResponseId: 'chatcmpl-it-2' } });
    await prisma.llmUsageLog.update({ where: { id: row!.id }, data: { inputTokens: row!.inputTokens + 1 } });
    try {
      const result = auditLoggingAccuracy(captures, await loggedRows(), await dashboardTotals());
      expect(result.pass).toBe(false);
      expect(result.calls.find(c => c.providerResponseId === 'chatcmpl-it-2')!.inputDifference).toBe(1);
      expect(result.totals.dashboardInputDifference).toBe(1);
    } finally {
      await prisma.llmUsageLog.update({ where: { id: row!.id }, data: { inputTokens: row!.inputTokens } });
    }
  });
});
