/**
 * F-07: runs left PENDING/RUNNING by a previous backend process are failed
 * with an accurate reason at startup - never resumed, never left stuck - and
 * nothing else changes: terminal runs, owners, usage logs, analytics totals
 * and runs created by the current process stay exactly as they were.
 *
 * "Interrupted" runs are written directly in the states a killed process
 * leaves behind. No provider is called (a counting stub proves it) and the
 * startup check spawns the real server with no OpenAI key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { LLMService } from '../src/services/llmService.js';
import {
  recoverInterruptedRuns,
  INTERRUPTED_QUEUED_REASON,
  INTERRUPTED_RUNNING_REASON,
} from '../src/services/runRecoveryService.js';

const EMAILS = { userA: 'recovery-user-a@test.local', userB: 'recovery-user-b@test.local', startup: 'recovery-startup@test.local' } as const;
const ids = { userA: 0, userB: 0, startup: 0, cvAgent: 0, sentimentAgent: 0 };
let providerCalls = 0;

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

/** The rows a killed backend leaves for one user, plus finished runs that must not change. */
async function interruptedFixtures(userId: number, tag: string) {
  const batchId = `batch-${tag}-${Date.now()}`;
  const doc = (name: string) =>
    prisma.cvDocument.create({ data: { userId, batchId, fileName: name, content: `Node.js backend engineer CV ${tag} ${name}` } });
  const run = (data: { status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR'; agent: 'cv' | 'sentiment'; batch?: boolean; cvDocumentId?: number; errorMessage?: string; completedAt?: Date }) =>
    prisma.agentRun.create({
      data: {
        userId,
        agentId: data.agent === 'cv' ? ids.cvAgent : ids.sentimentAgent,
        agentName: data.agent === 'cv' ? CV_CLASSIFICATION_AGENT_NAME : SENTIMENT_AGENT_NAME,
        batchId: data.batch ? batchId : null,
        cvDocumentId: data.cvDocumentId ?? null,
        status: data.status,
        errorMessage: data.errorMessage ?? null,
        completedAt: data.completedAt ?? null,
      },
    });
  const usage = (runId: string, agent: 'cv' | 'sentiment', status: 'SUCCESS' | 'ERROR', inputTokens: number) =>
    prisma.llmUsageLog.create({
      data: {
        timestamp: new Date(), runId, userId,
        agentId: agent === 'cv' ? ids.cvAgent : ids.sentimentAgent,
        agentName: agent === 'cv' ? CV_CLASSIFICATION_AGENT_NAME : SENTIMENT_AGENT_NAME,
        model: 'gpt-4o', inputTokens, outputTokens: 50, latencyMs: 900, status,
        estimatedCost: inputTokens * 0.0000025 + 50 * 0.00001, providerResponseId: status === 'SUCCESS' ? `chatcmpl-${tag}-${runId}` : null,
      },
    });

  const finishedDoc = await doc('done.txt');
  const done = await run({ status: 'SUCCESS', agent: 'cv', batch: true, cvDocumentId: finishedDoc.id, completedAt: new Date('2026-10-01T10:00:00Z') });
  await usage(done.id, 'cv', 'SUCCESS', 700);
  await prisma.cvRecommendation.create({
    data: { cvDocumentId: finishedDoc.id, runId: done.id, userId, agentId: ids.cvAgent, primaryCategory: 'Back-End Developer', secondaryCategories: [], confidenceScore: 0.9, confidenceScores: {}, rationale: [], rawResponse: {} },
  });
  const failed = await run({ status: 'ERROR', agent: 'cv', batch: true, cvDocumentId: (await doc('bad.pdf')).id, errorMessage: 'Unsupported file type "application/pdf" - only text/plain is supported', completedAt: new Date('2026-10-01T10:00:01Z') });
  const queuedA = await run({ status: 'PENDING', agent: 'cv', batch: true, cvDocumentId: (await doc('queued-1.txt')).id });
  const queuedB = await run({ status: 'PENDING', agent: 'cv', batch: true, cvDocumentId: (await doc('queued-2.txt')).id });
  // Mid-call when the process died: its earlier attempt was already logged.
  const batchRunning = await run({ status: 'RUNNING', agent: 'cv', batch: true, cvDocumentId: (await doc('running.txt')).id });
  await usage(batchRunning.id, 'cv', 'SUCCESS', 650);
  const singleCv = await run({ status: 'RUNNING', agent: 'cv', cvDocumentId: (await prisma.cvDocument.create({ data: { userId, content: `single CV ${tag}` } })).id });
  const sentiment = await run({ status: 'RUNNING', agent: 'sentiment' });
  const failedSentiment = await run({ status: 'ERROR', agent: 'sentiment', errorMessage: 'The AI provider request failed.', completedAt: new Date('2026-10-01T10:00:02Z') });
  await usage(failedSentiment.id, 'sentiment', 'ERROR', 0);

  return {
    batchId,
    terminal: [done.id, failed.id, failedSentiment.id],
    queued: [queuedA.id, queuedB.id],
    running: [batchRunning.id, singleCv.id, sentiment.id],
  };
}

const snapshotRuns = (runIds: string[]) =>
  prisma.agentRun.findMany({ where: { id: { in: runIds } }, orderBy: { id: 'asc' } });
const snapshotUsage = (userIds: number[]) =>
  prisma.llmUsageLog.findMany({ where: { userId: { in: userIds } }, orderBy: { id: 'asc' } });

beforeAll(async () => {
  await cleanup();
  for (const name of [CV_CLASSIFICATION_AGENT_NAME, SENTIMENT_AGENT_NAME]) {
    await prisma.agent.upsert({ where: { name }, update: {}, create: { name, description: 'Upserted for tests', version: '1.0.0' } });
  }
  ids.cvAgent = (await prisma.agent.findUniqueOrThrow({ where: { name: CV_CLASSIFICATION_AGENT_NAME } })).id;
  ids.sentimentAgent = (await prisma.agent.findUniqueOrThrow({ where: { name: SENTIMENT_AGENT_NAME } })).id;
  const hash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  for (const key of ['userA', 'userB', 'startup'] as const) {
    ids[key] = (await prisma.user.create({ data: { email: EMAILS[key], password: hash, role: 'USER' } })).id;
  }
  // Any provider call during recovery would show up here.
  const counting = { messages: { create: async () => { providerCalls += 1; throw new Error('no provider call expected'); } } };
  __setCvClassificationAgentForTesting(new CVClassificationAgent(new LLMService(counting)));
  __setSentimentAgentForTesting(new SentimentAgent(new LLMService(counting)));
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  __setSentimentAgentForTesting(realSentimentAgent);
  await cleanup();
});

describe('recoverInterruptedRuns', () => {
  let a: Awaited<ReturnType<typeof interruptedFixtures>>;
  let b: Awaited<ReturnType<typeof interruptedFixtures>>;
  let cutoff: Date;
  let newRuns: string[];
  let terminalBefore: Awaited<ReturnType<typeof snapshotRuns>>;
  let usageBefore: Awaited<ReturnType<typeof snapshotUsage>>;
  let summaryBefore: unknown;
  let runCountsBefore: { successful: number; failed: number };

  beforeAll(async () => {
    a = await interruptedFixtures(ids.userA, 'a');
    b = await interruptedFixtures(ids.userB, 'b');
    await new Promise(resolve => setTimeout(resolve, 20));
    cutoff = new Date(); // "this process started here"
    await new Promise(resolve => setTimeout(resolve, 20));
    // Work the current process started after the cutoff: must never be touched.
    newRuns = [];
    for (const status of ['PENDING', 'RUNNING'] as const) {
      newRuns.push((await prisma.agentRun.create({ data: { userId: ids.userA, agentId: ids.cvAgent, agentName: CV_CLASSIFICATION_AGENT_NAME, batchId: 'batch-new', status } })).id);
    }
    terminalBefore = await snapshotRuns([...a.terminal, ...b.terminal]);
    usageBefore = await snapshotUsage([ids.userA, ids.userB]);
    const { accessToken } = await loginAs(EMAILS.userA);
    summaryBefore = (await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${accessToken}`)).body.data;
    runCountsBefore = (await request(app).get('/api/analytics/runs').set('Authorization', `Bearer ${accessToken}`)).body.data;
  });

  it('fails every interrupted run of every user with the reason for its state', async () => {
    const result = await recoverInterruptedRuns(cutoff);
    // At least this file's 4 queued + 6 running (test.db may hold other files' leftovers).
    expect(result.queued).toBeGreaterThanOrEqual(4);
    expect(result.running).toBeGreaterThanOrEqual(6);

    for (const fixture of [a, b]) {
      for (const run of await snapshotRuns(fixture.queued)) {
        expect(run).toMatchObject({ status: 'ERROR', errorMessage: INTERRUPTED_QUEUED_REASON, batchId: fixture.batchId });
        expect(run.completedAt).not.toBeNull();
      }
      for (const run of await snapshotRuns(fixture.running)) {
        expect(run).toMatchObject({ status: 'ERROR', errorMessage: INTERRUPTED_RUNNING_REASON });
        expect(run.completedAt).not.toBeNull();
      }
    }
    // Owners, batches and documents are unchanged.
    for (const run of await snapshotRuns([...a.queued, ...a.running])) expect(run.userId).toBe(ids.userA);
    for (const run of await snapshotRuns([...b.queued, ...b.running])) expect(run.userId).toBe(ids.userB);
    expect(providerCalls).toBe(0);
  });

  it('never touches finished runs, runs created after the cutoff, or usage logs', async () => {
    expect(await snapshotRuns([...a.terminal, ...b.terminal])).toEqual(terminalBefore);
    expect((await snapshotRuns(newRuns)).map(r => r.status).sort()).toEqual(['PENDING', 'RUNNING']);
    expect(await snapshotUsage([ids.userA, ids.userB])).toEqual(usageBefore); // no row added, removed or changed
    expect(await prisma.cvRecommendation.count({ where: { userId: { in: [ids.userA, ids.userB] } } })).toBe(2);
  });

  it('is idempotent: a second recovery changes nothing', async () => {
    const after1 = await snapshotRuns([...a.queued, ...a.running, ...a.terminal, ...b.queued, ...b.running, ...b.terminal, ...newRuns]);
    expect(await recoverInterruptedRuns(cutoff)).toEqual({ queued: 0, running: 0 });
    expect(await snapshotRuns([...a.queued, ...a.running, ...a.terminal, ...b.queued, ...b.running, ...b.terminal, ...newRuns])).toEqual(after1);
    expect(providerCalls).toBe(0);
  });

  it('token and cost analytics are unchanged; the recovered runs count as failed runs', async () => {
    const { accessToken } = await loginAs(EMAILS.userA);
    const summary = (await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${accessToken}`)).body.data;
    expect(summary).toEqual(summaryBefore);
    const counts = (await request(app).get('/api/analytics/runs').set('Authorization', `Bearer ${accessToken}`)).body.data;
    expect(counts.successful).toBe(runCountsBefore.successful);
    expect(counts.failed).toBe(runCountsBefore.failed + a.queued.length + a.running.length);
  });

  it('the batch status and run listing show the batch as finished with the reasons, owner-only', async () => {
    const { accessToken: tokenA } = await loginAs(EMAILS.userA);
    const status = (await request(app).get(`/api/cv/batch/${a.batchId}/status`).set('Authorization', `Bearer ${tokenA}`)).body.data;
    expect(status).toMatchObject({ total: 5, queued: 0, processing: 0, completed: 1, failed: 4, percentage: 100 });
    const reasons = Object.fromEntries(status.items.map((i: { fileName: string; error: string | null }) => [i.fileName, i.error]));
    expect(reasons['queued-1.txt']).toBe(INTERRUPTED_QUEUED_REASON);
    expect(reasons['queued-2.txt']).toBe(INTERRUPTED_QUEUED_REASON);
    expect(reasons['running.txt']).toBe(INTERRUPTED_RUNNING_REASON);
    expect(reasons['done.txt']).toBeNull();
    expect(reasons['bad.pdf']).toMatch(/Unsupported file type/);

    const listed = (await request(app).get(`/api/runs/${a.running[2]}`).set('Authorization', `Bearer ${tokenA}`)).body.data;
    expect(listed).toMatchObject({ status: 'ERROR', agentName: SENTIMENT_AGENT_NAME, errorMessage: INTERRUPTED_RUNNING_REASON });

    const { accessToken: tokenB } = await loginAs(EMAILS.userB);
    expect((await request(app).get(`/api/cv/batch/${a.batchId}/status`).set('Authorization', `Bearer ${tokenB}`)).status).toBe(403);
    expect((await request(app).get(`/api/runs/${a.running[0]}`).set('Authorization', `Bearer ${tokenB}`)).status).toBe(403);
  });
});

/** Starts `node --import tsx src/server.ts`, resolves with its output once it is listening, then stops it. */
async function runServerUntilListening(args: { cwd: string; env: NodeJS.ProcessEnv; serverPath: string; tsxImport: string }) {
  const child = spawn(process.execPath, ['--import', args.tsxImport, args.serverPath], {
    cwd: args.cwd,
    env: args.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 45_000);
      const onData = (d: Buffer) => {
        output += d.toString();
        if (output.includes('Server running on')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', code => reject(new Error(`server exited early (${code}):\n${output}`)));
    });
  } finally {
    child.kill();
    await exited;
  }
  return output;
}

describe('backend startup', () => {
  it('a failing recovery check is logged and does not block startup', async () => {
    // Empty temporary directory and minimal environment (no env file is read).
    // Since F-23 the server refuses an unmigrated database before recovery
    // runs, so the database here is a consistent copy of the fully migrated
    // test.db (the schema check passes) whose agent_runs table is renamed:
    // the recovery query itself fails.
    const dir = mkdtempSync(join(tmpdir(), 'run-recovery-startup-'));
    try {
      const copy = join(dir, 'migrated-copy.db');
      await prisma.$executeRawUnsafe(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
      // node:sqlite through require (Vite does not resolve it; @types/node predates it).
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
        DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
      };
      const db = new DatabaseSync(copy);
      db.exec('ALTER TABLE agent_runs RENAME TO agent_runs_hidden_for_test');
      db.close();
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      Object.assign(env, {
        NODE_ENV: 'development',
        DATABASE_URL: pathToFileURL(copy).href.replace(/^file:\/\/\//, 'file:'),
        JWT_SECRET: randomBytes(32).toString('hex'),
        OPENAI_API_KEY: '',
        BACKEND_PORT: '0',
        LOG_LEVEL: 'info',
      });
      const output = await runServerUntilListening({
        cwd: dir,
        env,
        serverPath: join(process.cwd(), 'src', 'server.ts'),
        tsxImport: pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
      });
      const schemaOk = output.indexOf('Database schema is up to date');
      const failure = output.indexOf('Could not check for agent runs interrupted by a previous backend process');
      expect(schemaOk, output).toBeGreaterThanOrEqual(0);
      expect(failure, output).toBeGreaterThan(schemaOk);
      expect(failure).toBeLessThan(output.indexOf('Server running on'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('recovers interrupted runs before it starts accepting requests', async () => {
    const fx = await interruptedFixtures(ids.startup, 'startup');
    const usageBefore = await snapshotUsage([ids.startup]);
    const terminalBefore = await snapshotRuns(fx.terminal);
    await new Promise(resolve => setTimeout(resolve, 20));

    // The real entry point, as one Node process (no tsx CLI wrapper), against
    // test.db with no OpenAI key and a random port.
    const output = await runServerUntilListening({
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', BACKEND_PORT: '0', LOG_LEVEL: 'info', OPENAI_API_KEY: '' },
      serverPath: 'src/server.ts',
      tsxImport: 'tsx',
    });

    // Recovery is logged before the server reports it is listening.
    const recoveredAt = output.indexOf('INTERRUPTED_RUNS_RECOVERED');
    expect(recoveredAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt).toBeLessThan(output.indexOf('Server running on'));

    for (const run of await snapshotRuns(fx.queued)) expect(run).toMatchObject({ status: 'ERROR', errorMessage: INTERRUPTED_QUEUED_REASON, userId: ids.startup });
    for (const run of await snapshotRuns(fx.running)) expect(run).toMatchObject({ status: 'ERROR', errorMessage: INTERRUPTED_RUNNING_REASON, userId: ids.startup });
    expect(await snapshotRuns(fx.terminal)).toEqual(terminalBefore);
    expect(await snapshotUsage([ids.startup])).toEqual(usageBefore);
  }, 60_000);
});
