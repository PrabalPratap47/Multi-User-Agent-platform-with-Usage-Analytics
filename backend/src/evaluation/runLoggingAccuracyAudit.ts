import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditLoggingAccuracy,
  type LoggedUsageRow,
  type LoggingAccuracyResult,
  type RawProviderCall,
} from './loggingAccuracy.js';

/**
 * Usage logging accuracy audit (Step 15).
 *
 * Makes REAL OpenAI calls through the production services and the
 * production OpenAI adapter, recording each raw HTTP response body at the
 * fetch layer - independently of LLMService's own parsing. Then compares
 * the raw usage.prompt_tokens / usage.completion_tokens with the
 * llm_usage_logs rows and with the dashboard totals from
 * GET /api/analytics/summary.
 *
 * Uses its own fresh SQLite file (backend/data/logging-audit.db) so the
 * dashboard totals contain only the audited calls. Requires a valid
 * OPENAI_API_KEY (backend/.env.local, or the process environment, which
 * takes precedence). Writes no report if no real call succeeds.
 *
 * Run with: `npm run audit:logging-accuracy` from backend/.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, '..', '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');
const AUDIT_DB_FILE = join(BACKEND_ROOT, 'data', 'logging-audit.db');
const AUDIT_DATABASE_URL = 'file:../data/logging-audit.db';
const REPORT_JSON = join(PROJECT_ROOT, 'evaluation', 'logging-accuracy-report.json');
const REPORT_MD = join(PROJECT_ROOT, 'evaluation', 'logging-accuracy-report.md');

const CV_SAMPLES = [
  'Maria Lopez - Backend Engineer. 6 years building REST APIs with Node.js, Express and PostgreSQL. Designed event-driven microservices and CI/CD pipelines.',
  'Tom Becker - Frontend Developer. 4 years building React and TypeScript single-page apps, component libraries and accessible CSS layouts.',
  'Aisha Khan - QA Automation Engineer. Built Selenium and Cypress end-to-end suites for a large e-commerce site; maintains test reporting in CI.',
];
const FEEDBACK_SAMPLES = [
  'The new dashboard is fantastic - setup took five minutes and support answered my question right away.',
  'Checkout failed three times and I still have not received any reply to my support ticket.',
  'The update changed the menu layout. I have not decided yet whether I prefer it.',
];

interface SampleOutcome {
  agent: string;
  sample: number;
  ok: boolean;
  runId: string | null;
  error: string | null;
}

function recordingFetch(captures: RawProviderCall[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/chat/completions')) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { id?: string; model?: string; usage?: Record<string, unknown> } | null;
      const usage = body?.usage;
      captures.push({
        providerResponseId: body?.id ?? `no-id-http-${response.status}-${captures.length}`,
        httpStatus: response.status,
        model: body?.model ?? '',
        promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
        completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
        rawUsage: usage ?? null,
      });
    }
    return response;
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function markdownReport(meta: Record<string, string | number>, samples: SampleOutcome[], result: LoggingAccuracyResult): string {
  const t = result.totals;
  const lines: string[] = [
    '# Usage Logging Accuracy Report',
    '',
    `**Overall: ${result.pass ? 'PASS' : 'FAIL'}**`,
    '',
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    '## Method',
    '',
    '- Real OpenAI Chat Completions calls were made through the production services (`CvClassificationService`, `SentimentService`) and the production OpenAI adapter (`createOpenAIClient`).',
    '- **Raw** values were read from each HTTP response body (`usage.prompt_tokens`, `usage.completion_tokens`, `model`) by a recording `fetch`, independently of `LLMService`.',
    '- **Logged** values were read from `llm_usage_logs`, matched to each raw response by `providerResponseId` (the OpenAI response `id`).',
    '- **Dashboard** totals came from `GET /api/analytics/summary`, called over HTTP with the audit user\'s own login token.',
    '- No token value in this report was estimated, counted from text, or computed by a tokenizer.',
    '',
    '## Per-call comparison',
    '',
    '| Run ID | Agent | Model | Raw in | Logged in | Δ in | Raw out | Logged out | Δ out | Status | Result |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...result.calls.map(
      c =>
        `| ${c.runId ?? '-'} | ${c.agent ?? '-'} | ${c.rawModel}${c.loggedModel !== c.rawModel ? ` (logged: ${c.loggedModel})` : ''} | ${c.rawInputTokens ?? '-'} | ${c.loggedInputTokens ?? '-'} | ${c.inputDifference ?? '-'} | ${c.rawOutputTokens ?? '-'} | ${c.loggedOutputTokens ?? '-'} | ${c.outputDifference ?? '-'} | ${c.loggedStatus ?? '-'} | ${c.pass ? 'PASS' : `FAIL: ${c.problems.join('; ')}`} |`
    ),
    '',
    '## Totals',
    '',
    '| | Raw (OpenAI) | Logged (DB) | Dashboard | Δ logged-raw | Δ dashboard-raw |',
    '|---|---:|---:|---:|---:|---:|',
    `| Input tokens | ${t.rawInputTotal} | ${t.loggedInputTotal} | ${t.dashboardInputTotal} | ${t.inputDifference} | ${t.dashboardInputDifference} |`,
    `| Output tokens | ${t.rawOutputTotal} | ${t.loggedOutputTotal} | ${t.dashboardOutputTotal} | ${t.outputDifference} | ${t.dashboardOutputDifference} |`,
    '',
    `Totals: **${t.pass ? 'PASS' : 'FAIL'}**. Logged rows without a matching raw response: **${result.unmatchedLoggedRows.length}**.`,
    '',
    '## Samples',
    '',
    '| Agent | # | Outcome |',
    '|---|---:|---|',
    ...samples.map(s => `| ${s.agent} | ${s.sample} | ${s.ok ? `completed (run ${s.runId})` : `failed: ${s.error}`} |`),
    '',
    'A failed sample (e.g. the model response failed validation) still produces real, logged provider calls; those calls are audited above like any other.',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  if (process.env.NODE_ENV === 'test') {
    throw new Error('Refusing to run the logging audit under NODE_ENV=test.');
  }
  // Must be set before the app's config/env.ts is first imported (dotenv never overrides it).
  process.env.DATABASE_URL = AUDIT_DATABASE_URL;

  const { default: config } = await import('../config/env.js');
  if (!config.OPENAI_API_KEY.trim()) {
    throw new Error('OPENAI_API_KEY is not set in backend/.env.local - the audit needs real OpenAI calls. No report was written.');
  }

  // Fresh, fully migrated audit database.
  mkdirSync(dirname(AUDIT_DB_FILE), { recursive: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(AUDIT_DB_FILE + suffix, { force: true });
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', join(BACKEND_ROOT, 'prisma', 'schema.prisma')], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: AUDIT_DATABASE_URL },
    stdio: 'pipe',
  });

  const { default: prisma } = await import('../db/client.js');
  const { default: app } = await import('../app.js');
  const { default: bcryptjs } = await import('bcryptjs');
  const { createOpenAIClient, LLMService } = await import('../services/llmService.js');
  const cvModule = await import('../agents/CVClassificationAgent.js');
  const sentimentModule = await import('../agents/SentimentAgent.js');
  const { CvClassificationService } = await import('../services/cvClassificationService.js');
  const { SentimentService } = await import('../services/sentimentService.js');

  for (const name of [cvModule.CV_CLASSIFICATION_AGENT_NAME, sentimentModule.SENTIMENT_AGENT_NAME]) {
    await prisma.agent.upsert({ where: { name }, update: {}, create: { name, version: '1.0.0' } });
  }
  const password = randomBytes(18).toString('base64url');
  const auditUser = await prisma.user.create({
    data: {
      email: `logging-audit-${Date.now()}@audit.local`,
      password: await bcryptjs.hash(password, config.BCRYPT_SALT_ROUNDS),
      role: 'USER',
    },
  });
  const userPayload = { id: auditUser.id, email: auditUser.email, role: 'user' as const };

  // Production agents and adapter; only the fetch records raw responses.
  const captures: RawProviderCall[] = [];
  const llm = new LLMService(createOpenAIClient({ fetch: recordingFetch(captures) }));
  cvModule.__setCvClassificationAgentForTesting(new cvModule.CVClassificationAgent(llm));
  sentimentModule.__setSentimentAgentForTesting(new sentimentModule.SentimentAgent(llm));

  const samples: SampleOutcome[] = [];
  for (const [i, cvContent] of CV_SAMPLES.entries()) {
    try {
      const rec = await CvClassificationService.classifyContent(userPayload, { cvContent, fileName: `audit-cv-${i + 1}.txt` });
      samples.push({ agent: cvModule.CV_CLASSIFICATION_AGENT_NAME, sample: i + 1, ok: true, runId: rec.runId, error: null });
    } catch (error) {
      samples.push({ agent: cvModule.CV_CLASSIFICATION_AGENT_NAME, sample: i + 1, ok: false, runId: null, error: describeError(error) });
    }
  }
  for (const [i, text] of FEEDBACK_SAMPLES.entries()) {
    try {
      const result = await SentimentService.analyze(userPayload, text);
      samples.push({ agent: sentimentModule.SENTIMENT_AGENT_NAME, sample: i + 1, ok: true, runId: result.runId, error: null });
    } catch (error) {
      samples.push({ agent: sentimentModule.SENTIMENT_AGENT_NAME, sample: i + 1, ok: false, runId: null, error: describeError(error) });
    }
  }

  // Dashboard totals over HTTP, exactly as the frontend reads them.
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let dashboard: { totalInputTokens: number; totalOutputTokens: number; callCount: number; estimatedCost: number };
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: auditUser.email, password }),
    });
    const { data: session } = (await login.json()) as { data: { accessToken: string } };
    const summary = await fetch(`${base}/analytics/summary`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (!summary.ok) throw new Error(`GET /api/analytics/summary returned HTTP ${summary.status}`);
    dashboard = ((await summary.json()) as { data: typeof dashboard }).data;
  } finally {
    server.close();
  }

  const rows = await prisma.llmUsageLog.findMany({ where: { userId: auditUser.id }, orderBy: { id: 'asc' } });
  const loggedRows: LoggedUsageRow[] = rows.map(r => ({
    id: r.id,
    runId: r.runId,
    agentName: r.agentName,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    status: r.status,
    providerResponseId: r.providerResponseId,
  }));

  const result = auditLoggingAccuracy(captures, loggedRows, dashboard);
  if (result.calls.length === 0) {
    await prisma.$disconnect();
    const statuses = [...new Set(captures.map(c => c.httpStatus))].join(', ') || 'none';
    const firstError = samples.find(s => s.error)?.error ?? 'no calls were made';
    throw new Error(
      `No OpenAI call succeeded (HTTP statuses: ${statuses}; first error: ${firstError}). ` +
        'There is nothing real to audit, so no report was written.'
    );
  }
  const generatedAt = new Date().toISOString();
  const meta = {
    'Generated at': generatedAt,
    Provider: 'OpenAI Chat Completions (real API calls)',
    'Configured model (OPENAI_MODEL)': config.OPENAI_MODEL,
    'Real successful OpenAI calls audited': result.calls.length,
    'HTTP responses captured (incl. non-2xx)': captures.length,
    'Usage log rows in scope': loggedRows.length,
    'Dashboard call count': dashboard.callCount,
    'Audit database': 'backend/data/logging-audit.db (fresh for this run)',
  };

  mkdirSync(dirname(REPORT_JSON), { recursive: true });
  writeFileSync(
    REPORT_JSON,
    JSON.stringify(
      {
        executed: true,
        overall: result.pass ? 'PASS' : 'FAIL',
        generatedAt,
        provider: 'openai',
        configuredModel: config.OPENAI_MODEL,
        auditUser: auditUser.email,
        dashboardEndpoint: 'GET /api/analytics/summary',
        dashboard,
        samples,
        calls: result.calls.map(call => ({ ...call, rawUsage: captures.find(c => c.providerResponseId === call.providerResponseId)?.rawUsage ?? null })),
        unmatchedLoggedRows: result.unmatchedLoggedRows,
        totals: result.totals,
        nonSuccessHttpResponses: captures.filter(c => c.httpStatus < 200 || c.httpStatus >= 300).map(c => ({ httpStatus: c.httpStatus })),
      },
      null,
      2
    ) + '\n'
  );
  writeFileSync(REPORT_MD, markdownReport(meta, samples, result));
  await prisma.$disconnect();

  console.log(`Logging accuracy audit: ${result.pass ? 'PASS' : 'FAIL'} - ${result.calls.length} real calls audited`);
  console.log(`Input  tokens: raw ${result.totals.rawInputTotal} | logged ${result.totals.loggedInputTotal} | dashboard ${result.totals.dashboardInputTotal}`);
  console.log(`Output tokens: raw ${result.totals.rawOutputTotal} | logged ${result.totals.loggedOutputTotal} | dashboard ${result.totals.dashboardOutputTotal}`);
  console.log(`Reports: evaluation/logging-accuracy-report.json, evaluation/logging-accuracy-report.md`);
  process.exitCode = result.pass ? 0 : 1;
}

main().catch(error => {
  console.error(`Logging accuracy audit did not run: ${describeError(error)}`);
  process.exitCode = 1;
});
