/**
 * F-06: a batch never has more than MAX_CONCURRENT_BATCH_FILES provider calls
 * in flight, every file is still processed exactly once, failures stay
 * isolated, and progress/results/usage logs stay correct.
 *
 * CONTROLLED: a gated stub provider holds every call open until the test
 * releases it, so the cap is observed directly (no timing assumptions and
 * no OpenAI calls).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { LLMService, type LLMProviderRequest, type LLMProviderResponse } from '../src/services/llmService.js';
import { MAX_CONCURRENT_BATCH_FILES, runWithConcurrencyLimit } from '../src/services/cvBatchService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';
import { cvFeedbackFrom } from './fixtures/cvFeedback.js';

const EMAILS = { userA: 'batch-cap-user-a@test.local', userB: 'batch-cap-user-b@test.local' } as const;
const EVIDENCE = 'Node.js and Express backend engineer';
const cvText = (n: number, extra = '') => `${EVIDENCE}, five years of REST APIs. FILE-${String(n).padStart(2, '0')} ${extra}`.trim();

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (userIds.length > 0) {
    await prisma.cvRecommendation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cvDocument.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const hash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  for (const email of Object.values(EMAILS)) await prisma.user.create({ data: { email, password: hash, role: 'USER' } });
});

afterEach(() => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  await cleanup();
});

async function waitUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function validJson(): string {
  const confidence: Record<string, number> = {};
  for (const category of CV_CATEGORIES) confidence[category] = 0;
  confidence['Back-End Developer'] = 0.9;
  return JSON.stringify({
    primaryCategory: 'Back-End Developer',
    secondaryCategories: [],
    confidence,
    rationale: [{ category: 'Back-End Developer', evidence: EVIDENCE }],
    feedback: cvFeedbackFrom(EVIDENCE),
  });
}

/**
 * CONTROLLED provider. Every call blocks until released. Behaviour comes from
 * markers in the CV text: PROVIDER_FAIL -> HTTP 503, BAD_OUTPUT -> non-JSON
 * (so the agent's repair retry runs), otherwise a valid classification.
 */
function gatedProvider() {
  let active = 0;
  let peak = 0;
  let seq = 0;
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const create = async (req: LLMProviderRequest): Promise<LLMProviderResponse> => {
    const content = req.messages[0].content;
    started.push(content.match(/FILE-\d+/)?.[0] ?? '?');
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>(resolve => pending.push(resolve));
      const usage = { prompt_tokens: 600, completion_tokens: 90 };
      if (content.includes('PROVIDER_FAIL')) throw { status: 503, name: 'APIError', message: 'Service unavailable (stub)' };
      if (content.includes('BAD_OUTPUT')) return { id: `chatcmpl-cap-${++seq}`, content: [{ type: 'text', text: 'not json' }], model: 'gpt-4o', usage };
      return { id: `chatcmpl-cap-${++seq}`, content: [{ type: 'text', text: validJson() }], model: 'gpt-4o', usage };
    } finally {
      active -= 1;
    }
  };
  return {
    install: () => __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService({ messages: { create } }))),
    releaseOne: () => pending.shift()?.(),
    releaseAll: () => pending.splice(0).forEach(resolve => resolve()),
    get active() { return active; },
    get peak() { return peak; },
    get waiting() { return pending.length; },
    started,
  };
}

async function submit(email: string, files: Array<{ fileName: string; mimeType?: string; content: string }>) {
  const { accessToken } = await loginAs(email);
  const res = await request(app)
    .post('/api/cv/batch')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ files: files.map(f => ({ mimeType: 'text/plain', ...f })) });
  expect(res.status).toBe(202);
  const batchId: string = res.body.data.batchId;
  const status = async () =>
    (await request(app).get(`/api/cv/batch/${batchId}/status`).set('Authorization', `Bearer ${accessToken}`)).body.data;
  const finished = async () => {
    const runs = await prisma.agentRun.findMany({ where: { batchId } });
    return runs.length === files.length && runs.every(r => r.status === 'SUCCESS' || r.status === 'ERROR');
  };
  return { batchId, status, finished };
}

describe('runWithConcurrencyLimit', () => {
  it('never exceeds the limit, starts items in order, and handles every item once', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runWithConcurrencyLimit([...Array(12).keys()], 3, async n => {
      seen.push(n);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1 + (n % 4)));
      active -= 1;
    });
    expect(peak).toBe(3);
    expect(seen).toEqual([...Array(12).keys()]);
  });

  it('a throwing worker does not strand the items queued behind it', async () => {
    const done: number[] = [];
    await runWithConcurrencyLimit([0, 1, 2, 3, 4, 5], 2, async n => {
      if (n % 2 === 0) throw new Error(`boom ${n}`);
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 3, 5]);
  });

  it('treats a non-finite or < 1 limit as 1 (sequential), never as "drop everything"', async () => {
    for (const limit of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      let active = 0;
      let peak = 0;
      const seen: number[] = [];
      await runWithConcurrencyLimit([0, 1, 2, 3], limit, async n => {
        seen.push(n);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
      });
      expect(seen, String(limit)).toEqual([0, 1, 2, 3]);
      expect(peak, String(limit)).toBe(1);
    }
  });

  it('handles an empty list', async () => {
    await expect(runWithConcurrencyLimit([], 3, async () => undefined)).resolves.toBeUndefined();
  });
});

describe('batch processing - concurrency cap', () => {
  it('the cap is 3 files (= provider calls) per batch', () => {
    expect(MAX_CONCURRENT_BATCH_FILES).toBe(3);
  });

  it('a 10-file batch holds 3 calls in flight, queues the rest honestly, and completes every file once', async () => {
    const provider = gatedProvider();
    provider.install();
    const files = Array.from({ length: 10 }, (_, i) => ({ fileName: `cv-${i + 1}.txt`, content: cvText(i + 1) }));
    const { batchId, status, finished } = await submit(EMAILS.userA, files);

    // Exactly MAX calls start, and no more while they are held open.
    await waitUntil(() => provider.waiting === MAX_CONCURRENT_BATCH_FILES, '3 calls in flight');
    await new Promise(resolve => setTimeout(resolve, 200));
    // Files are picked up in submission order; the three started together may
    // reach the provider in any order (each first marks its run RUNNING).
    expect([...provider.started].sort()).toEqual(['FILE-01', 'FILE-02', 'FILE-03']);
    expect(provider.active).toBe(3);
    expect(await status()).toMatchObject({ total: 10, processing: 3, queued: 7, completed: 0, failed: 0, percentage: 0 });

    // Finishing one file lets exactly the next queued file start.
    provider.releaseOne();
    await waitUntil(() => provider.started.length === 4 && provider.waiting === 3, 'FILE-04 started');
    expect(provider.started[3]).toBe('FILE-04');
    expect(await status()).toMatchObject({ processing: 3, queued: 6, completed: 1, failed: 0, percentage: 10 });

    // Drain one call at a time; the cap holds throughout.
    while (!(await finished())) {
      if (provider.waiting > 0) provider.releaseOne();
      expect(provider.active).toBeLessThanOrEqual(MAX_CONCURRENT_BATCH_FILES);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(provider.peak).toBe(MAX_CONCURRENT_BATCH_FILES);
    expect([...provider.started].sort()).toEqual(files.map((_, i) => `FILE-${String(i + 1).padStart(2, '0')}`)); // each exactly once
    const final = await status();
    expect(final).toMatchObject({ total: 10, processing: 0, queued: 0, completed: 10, failed: 0, percentage: 100 });
    expect(final.items.map((i: { fileName: string }) => i.fileName)).toEqual(files.map(f => f.fileName));
    expect(final.items.every((i: { recommendationId: number | null }) => i.recommendationId !== null)).toBe(true);

    const runs = await prisma.agentRun.findMany({ where: { batchId }, select: { id: true } });
    const logs = await prisma.llmUsageLog.findMany({ where: { runId: { in: runs.map(r => r.id) } } });
    expect(logs).toHaveLength(10); // one usage row per provider call
    expect(new Set(logs.map(l => l.providerResponseId)).size).toBe(10);
    expect(logs.every(l => l.status === 'SUCCESS' && l.inputTokens === 600 && l.outputTokens === 90)).toBe(true);
  }, 30_000);

  it('mixed failures stay isolated, the cap holds, and every file reaches its own correct outcome', async () => {
    const provider = gatedProvider();
    provider.install();
    const files = [
      { fileName: 'bad-type.doc', mimeType: 'application/msword', content: cvText(1) },
      { fileName: 'provider-fail-1.txt', content: cvText(2, 'PROVIDER_FAIL') },
      { fileName: 'ok-1.txt', content: cvText(3) },
      { fileName: 'too-short.txt', content: 'tiny' },
      { fileName: 'bad-output.txt', content: cvText(5, 'BAD_OUTPUT') },
      { fileName: 'ok-2.txt', content: cvText(6) },
      { fileName: 'binary.txt', content: '\u0000\u0001\u0002\u0003'.repeat(30) + 'FILE-07' },
      { fileName: 'ok-3.txt', content: cvText(8) },
      { fileName: 'provider-fail-2.txt', content: cvText(9, 'PROVIDER_FAIL') },
    ];
    const { batchId, status, finished } = await submit(EMAILS.userA, files);

    // Deterministic: files 1 and 4 are rejected without a provider call, so
    // files 2, 3 and 5 all reach the provider before anything is released.
    await waitUntil(() => provider.waiting === MAX_CONCURRENT_BATCH_FILES, '3 calls in flight', 15_000);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(provider.active).toBe(MAX_CONCURRENT_BATCH_FILES);

    // Release calls in bursts (let open calls pile up first) so several are in flight at once.
    while (!(await finished())) {
      expect(provider.active).toBeLessThanOrEqual(MAX_CONCURRENT_BATCH_FILES);
      if (provider.waiting > 0) {
        await new Promise(resolve => setTimeout(resolve, 15));
        expect(provider.active).toBeLessThanOrEqual(MAX_CONCURRENT_BATCH_FILES);
        provider.releaseAll();
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(provider.peak).toBe(MAX_CONCURRENT_BATCH_FILES); // parallel, and never above the cap
    // Rejected files never reach the provider; BAD_OUTPUT is called twice (attempt + repair).
    expect([...provider.started].sort()).toEqual(['FILE-02', 'FILE-03', 'FILE-05', 'FILE-05', 'FILE-06', 'FILE-08', 'FILE-09']);

    const final = await status();
    expect(final).toMatchObject({ total: 9, completed: 3, failed: 6, queued: 0, processing: 0, percentage: 100 });
    const byName = Object.fromEntries(final.items.map((i: { fileName: string }) => [i.fileName, i])) as Record<string, { state: string; error: string | null; recommendationId: number | null; runId: string }>;
    for (const ok of ['ok-1.txt', 'ok-2.txt', 'ok-3.txt']) expect(byName[ok]).toMatchObject({ state: 'completed', error: null });
    expect(byName['bad-type.doc'].error).toMatch(/Unsupported file type/);
    expect(byName['too-short.txt'].error).toMatch(/too short/);
    expect(byName['binary.txt'].error).toMatch(/does not appear to be valid decoded text/);
    expect(byName['bad-output.txt'].error).toMatch(/did not pass validation/);
    expect(byName['provider-fail-1.txt'].error).toMatch(/AI provider request failed/);
    expect(byName['provider-fail-2.txt'].error).toMatch(/AI provider request failed/);

    // Usage rows: one per provider call, attached to the right run.
    const logsFor = async (name: string) => prisma.llmUsageLog.findMany({ where: { runId: byName[name].runId } });
    for (const name of ['bad-type.doc', 'too-short.txt', 'binary.txt']) expect(await logsFor(name)).toHaveLength(0);
    for (const name of ['ok-1.txt', 'ok-2.txt', 'ok-3.txt']) expect((await logsFor(name)).map(l => l.status)).toEqual(['SUCCESS']);
    for (const name of ['provider-fail-1.txt', 'provider-fail-2.txt']) {
      expect((await logsFor(name)).map(l => [l.status, l.errorCode])).toEqual([['ERROR', 'HTTP_503']]);
    }
    expect(await logsFor('bad-output.txt')).toHaveLength(2);
    expect(await prisma.cvRecommendation.count({ where: { runId: { in: final.items.map((i: { runId: string }) => i.runId) } } })).toBe(3);
    expect(await prisma.agentRun.count({ where: { batchId } })).toBe(9);
  }, 30_000);

  it('two users\' concurrent batches are each capped, both progress at once, and never mix', async () => {
    const provider = gatedProvider();
    provider.install();
    const a = await submit(EMAILS.userA, Array.from({ length: 5 }, (_, i) => ({ fileName: `a-${i + 1}.txt`, content: cvText(i + 1, 'USER-A') })));
    const b = await submit(EMAILS.userB, Array.from({ length: 5 }, (_, i) => ({ fileName: `b-${i + 1}.txt`, content: cvText(i + 1, 'USER-B') })));

    // The cap is per batch: 3 + 3 calls open, neither batch waits for the other.
    await waitUntil(() => provider.waiting === 2 * MAX_CONCURRENT_BATCH_FILES, 'both batches at their cap');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(provider.waiting).toBe(6);
    expect(await a.status()).toMatchObject({ processing: 3, queued: 2 });
    expect(await b.status()).toMatchObject({ processing: 3, queued: 2 });

    while (!((await a.finished()) && (await b.finished()))) {
      if (provider.waiting > 0) provider.releaseOne();
      for (const batch of [a, b]) {
        const running = await prisma.agentRun.count({ where: { batchId: batch.batchId, status: 'RUNNING' } });
        expect(running).toBeLessThanOrEqual(MAX_CONCURRENT_BATCH_FILES);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const [userA, userB] = await Promise.all(Object.values(EMAILS).map(email => prisma.user.findUniqueOrThrow({ where: { email } })));
    for (const [batch, owner] of [[a, userA], [b, userB]] as const) {
      const runs = await prisma.agentRun.findMany({ where: { batchId: batch.batchId }, include: { cvRecommendation: true, llmUsageLogs: true } });
      expect(runs).toHaveLength(5);
      expect(runs.every(r => r.userId === owner.id && r.status === 'SUCCESS')).toBe(true);
      expect(runs.every(r => r.cvRecommendation?.userId === owner.id)).toBe(true);
      expect(runs.every(r => r.llmUsageLogs.length === 1 && r.llmUsageLogs[0].userId === owner.id)).toBe(true);
      expect(await batch.status()).toMatchObject({ completed: 5, failed: 0, percentage: 100 });
    }
  }, 30_000);
});
