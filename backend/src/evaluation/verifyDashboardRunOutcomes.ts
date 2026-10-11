import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

/**
 * Dashboard regression check for the run-outcome metric (successful /
 * failed runs): ACTIONS -> DATABASE -> ANALYTICS API -> rendered DASHBOARD.
 *
 * No OpenAI credits. Runs are created through the real HTTP API (real
 * auth, services, persistence) with a CONTROLLED provider: the production
 * OpenAI adapter with a scripted fetch that returns a valid completion
 * (run -> SUCCESS) or an HTTP 400 (run -> ERROR). The dashboard is the real
 * Vite frontend in Google Chrome, logged in through the login form.
 *
 * Checked twice: with only the seed's demo runs present (every eligible
 * count must be 0 - seed runs are excluded), then after creating a mixed
 * user (user1), an all-success user (user2) and an all-failure user (user3).
 *
 * Run with: `npm run verify:dashboard-run-outcomes` from backend/ (needs
 * Google Chrome installed). Uses backend/data/dashboard-verify.db
 * (git-ignored, recreated each run) and writes
 * evaluation/dashboard-run-outcomes-results.json.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, '..', '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');
const DB_FILE = join(BACKEND_ROOT, 'data', 'dashboard-verify.db');
const DATABASE_URL = 'file:../data/dashboard-verify.db';
const RESULTS_JSON = join(PROJECT_ROOT, 'evaluation', 'dashboard-run-outcomes-results.json');
const WEB_PORT = 5175;
const WEB = `http://localhost:${WEB_PORT}`;
const PASSWORD = 'password123'; // seeded demo password (src/db/seed.ts)

type Who = 'admin' | 'user1' | 'user2' | 'user3';
const EVERYONE: Who[] = ['admin', 'user1', 'user2', 'user3'];
const EMAIL: Record<Who, string> = {
  admin: 'admin@example.com',
  user1: 'user1@example.com',
  user2: 'user2@example.com',
  user3: 'user3@example.com',
};

const OK = 'CTRL-RUN-OK';
const FAIL = 'CTRL-RUN-FAIL';
const CV_TEXT = (marker: string) => `${marker} Backend engineer building REST APIs in Go and PostgreSQL for five years.`;
const FEEDBACK_TEXT = (marker: string) => `${marker} The export feature works great and saves our team time every week.`;

interface Check {
  phase: string;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(phase: string, name: string, pass: boolean, detail = '') {
  checks.push({ phase, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let completionSeq = 0;
const completion = (content: string) =>
  jsonResponse(200, {
    id: `chatcmpl-CONTROLLED-${++completionSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'controlled-stub',
    // No usage on purpose: a controlled response never invents token counts.
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }],
  });

// CONTROLLED provider: the request body decides the outcome; nothing leaves the process.
const controlledFetch: typeof fetch = async (_input, init) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  if (body.includes(FAIL)) return jsonResponse(400, { error: { message: 'CONTROLLED provider rejection', type: 'invalid_request_error' } });
  if (body.includes('[FEEDBACK TEXT - BEGIN')) {
    return completion(JSON.stringify({ sentiment: 'positive', confidence: 0.9, rationale: 'The export feature works great and saves time.' }));
  }
  return completion(
    JSON.stringify({
      primaryCategory: 'Back-End Developer',
      secondaryCategories: [],
      confidence: { PSS: 0.05, DCS: 0.05, 'Front-End Developer': 0.05, 'Back-End Developer': 0.9, 'Web Automation': 0.05, 'Mobile Automation': 0.05, 'AI Engineer': 0.05, 'Chatbot Application Tester': 0.05, Other: 0.05 },
      rationale: [{ category: 'Back-End Developer', evidence: 'building REST APIs in Go and PostgreSQL' }],
      feedback: 'The CV describes building REST APIs in Go and PostgreSQL for five years. It could be improved by adding measurable outcomes for that work.',
    })
  );
};

async function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  if (process.env.NODE_ENV === 'test') throw new Error('Refusing to run under NODE_ENV=test.');
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FRONTEND_URL = WEB; // CORS origin for the Vite dev server below
  process.env.OPENAI_API_KEY = ''; // no real provider call is possible in this process
  process.env.LOG_LEVEL = 'warn';

  mkdirSync(dirname(DB_FILE), { recursive: true });
  for (const s of ['', '-journal', '-wal', '-shm']) rmSync(DB_FILE + s, { force: true });
  const req = createRequire(import.meta.url);
  const childEnv = { ...process.env, DATABASE_URL };
  execFileSync(process.execPath, [req.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(BACKEND_ROOT, 'prisma', 'schema.prisma')], { cwd: BACKEND_ROOT, env: childEnv, stdio: 'pipe' });
  execFileSync(process.execPath, [req.resolve('tsx/cli'), 'src/db/seed.ts'], { cwd: BACKEND_ROOT, env: childEnv, stdio: 'pipe' });

  const { default: prisma } = await import('../db/client.js');
  const { default: app } = await import('../app.js');
  const { createOpenAIClient, LLMService } = await import('../services/llmService.js');
  const cvModule = await import('../agents/CVClassificationAgent.js');
  const sentimentModule = await import('../agents/SentimentAgent.js');
  const llm = new LLMService(createOpenAIClient({ apiKey: 'controlled-stub-not-a-key', fetch: controlledFetch }));
  cvModule.__setCvClassificationAgentForTesting(new cvModule.CVClassificationAgent(llm));
  sentimentModule.__setSentimentAgentForTesting(new sentimentModule.SentimentAgent(llm));

  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const apiOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let vite: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    const viteBin = [join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), join(PROJECT_ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')].find(p => existsSync(p));
    if (!viteBin) throw new Error('vite is not installed - run npm install at the repository root');
    vite = spawn(process.execPath, [viteBin, join(PROJECT_ROOT, 'frontend'), '--port', String(WEB_PORT), '--strictPort'], {
      cwd: join(PROJECT_ROOT, 'frontend'),
      env: { ...process.env, BROWSER: 'none', VITE_API_URL: apiOrigin },
      stdio: 'ignore',
    });
    await waitForHttp(WEB, 90_000);
    browser = await chromium.launch({ channel: 'chrome', headless: true });

    const api = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(`${apiOrigin}/api${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: ((await res.json().catch(() => null)) as { data?: unknown } | null)?.data };
    };
    const token = {} as Record<Who, string>;
    const uid = {} as Record<Who, number>;
    for (const who of EVERYONE) {
      const login = await api('POST', '/auth/login', undefined, { email: EMAIL[who], password: PASSWORD });
      const data = login.data as { accessToken: string; user: { id: number } };
      token[who] = data.accessToken;
      uid[who] = data.user.id;
    }

    // Independent database oracle: agent_runs.status, seed demo runs (isSeedData usage log) excluded.
    const notSeed = { llmUsageLogs: { none: { isSeedData: true } } };
    const oracle = async (who: Who) => {
      const scope = who === 'admin' ? {} : { userId: uid[who] };
      const since = (days: number) => ({ createdAt: { gte: new Date(Date.now() - days * 86_400_000) } });
      return {
        last24h: await prisma.agentRun.count({ where: { ...scope, ...notSeed, ...since(1) } }),
        last7d: await prisma.agentRun.count({ where: { ...scope, ...notSeed, ...since(7) } }),
        last30d: await prisma.agentRun.count({ where: { ...scope, ...notSeed, ...since(30) } }),
        successful: await prisma.agentRun.count({ where: { ...scope, ...notSeed, status: 'SUCCESS' } }),
        failed: await prisma.agentRun.count({ where: { ...scope, ...notSeed, status: 'ERROR' } }),
      };
    };
    // Seed demo runs are all SUCCESS: the API must differ from a naive SUCCESS count by exactly those runs.
    const seedEvidence = async (who: Who) => {
      const scope = who === 'admin' ? {} : { userId: uid[who] };
      return {
        naiveSuccessful: await prisma.agentRun.count({ where: { ...scope, status: 'SUCCESS' } }),
        seedSuccessful: await prisma.agentRun.count({ where: { ...scope, status: 'SUCCESS', llmUsageLogs: { some: { isSeedData: true } } } }),
      };
    };

    const renderedAgentUsage = async (who: Who) => {
      const context = await browser!.newContext({ locale: 'en-US' });
      const page = await context.newPage();
      await page.goto(WEB);
      await page.fill('#email', EMAIL[who]);
      await page.fill('#password', PASSWORD);
      await page.getByRole('button', { name: 'Login' }).click();
      await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 });
      const section = page.locator('section', { has: page.getByRole('heading', { name: 'Agent Usage', exact: true }) });
      await section.getByText('Failed Runs').waitFor({ timeout: 30_000 });
      const cards: Record<string, string> = {};
      for (const card of await section.locator('div.bg-gradient-to-br').all()) {
        const lines = card.locator('p');
        cards[(await lines.nth(0).innerText()).trim()] = (await lines.nth(1).innerText()).trim();
      }
      await context.close();
      return cards;
    };

    const verifyPhase = async (phase: string, expectedFromActions: Partial<Record<Who, { successful: number; failed: number }>>) => {
      const evidence: Record<string, unknown> = {};
      for (const who of EVERYONE) {
        const db = await oracle(who);
        const res = await api('GET', '/analytics/runs', token[who]);
        const a = res.data as { last24h: number; last7d: number; last30d: number; successful: number; failed: number };
        const ui = await renderedAgentUsage(who);
        const seed = await seedEvidence(who);
        const fmt = (n: number) => n.toLocaleString('en-US');
        const keys = ['last24h', 'last7d', 'last30d', 'successful', 'failed'] as const;
        check(phase, `${who}: API successful/failed (and 24h/7d/30d) equal the database${who === 'admin' ? ' (all eligible runs)' : ` (${who}'s runs only)`}`, res.status === 200 && Object.keys(a).length === keys.length && keys.every(k => a[k] === db[k]), `API ${a.successful}/${a.failed}, DB ${db.successful}/${db.failed}; windows API ${a.last24h}/${a.last7d}/${a.last30d}`);
        check(phase, `${who}: dashboard "Successful Runs" / "Failed Runs" cards show the API values`, ui['Successful Runs'] === fmt(a.successful) && ui['Failed Runs'] === fmt(a.failed) && ui['Last 24 Hours'] === fmt(a.last24h) && ui['Last 7 Days'] === fmt(a.last7d) && ui['Last 30 Days'] === fmt(a.last30d), `dashboard ${ui['Successful Runs']}/${ui['Failed Runs']}`);
        check(phase, `${who}: seed demo runs in scope are excluded (API successful = all SUCCESS runs ${seed.naiveSuccessful} - seed SUCCESS runs ${seed.seedSuccessful})`, seed.seedSuccessful > 0 && a.successful === seed.naiveSuccessful - seed.seedSuccessful, '');
        const exp = expectedFromActions[who];
        if (exp) check(phase, `${who}: database counts match what the API calls did (${exp.successful} succeeded, ${exp.failed} failed)`, db.successful === exp.successful && db.failed === exp.failed, '');
        evidence[who] = { database: db, api: a, dashboard: { successful: ui['Successful Runs'], failed: ui['Failed Runs'] }, seedSuccessfulRunsExcluded: seed.seedSuccessful };
      }
      return evidence;
    };

    // Phase 1: only the seed's demo runs exist -> every eligible count is zero.
    const before = await verifyPhase('zero runs (seed only)', Object.fromEntries(EVERYONE.map(w => [w, { successful: 0, failed: 0 }])));

    // Phase 2: create runs through the real API (CONTROLLED provider decides the outcome).
    const plan: Record<Exclude<Who, 'admin'>, Array<['cv' | 'sentiment', boolean]>> = {
      user1: [['cv', true], ['cv', true], ['sentiment', true], ['cv', false]], // mixed
      user2: [['cv', true], ['cv', true]], // all success
      user3: [['cv', false], ['sentiment', false]], // all failure
    };
    const fromActions: Partial<Record<Who, { successful: number; failed: number }>> = {};
    for (const [who, actions] of Object.entries(plan) as Array<[Exclude<Who, 'admin'>, Array<['cv' | 'sentiment', boolean]>]>) {
      let successful = 0;
      let failed = 0;
      for (const [kind, ok] of actions) {
        const marker = ok ? OK : FAIL;
        const res = kind === 'cv' ? await api('POST', '/cv/classify', token[who], { cvContent: CV_TEXT(marker), fileName: `${who}-${kind}.txt` }) : await api('POST', '/sentiment/analyze', token[who], { text: FEEDBACK_TEXT(marker) });
        if (res.status === 201) successful += 1;
        else if (res.status === 502) failed += 1;
        check('create runs', `${who}: ${kind} ${ok ? 'success' : 'failure'} request -> HTTP ${ok ? 201 : 502}`, res.status === (ok ? 201 : 502), `HTTP ${res.status}`);
      }
      fromActions[who] = { successful, failed };
    }
    fromActions.admin = Object.values(fromActions).reduce((s, x) => ({ successful: s.successful + (x?.successful ?? 0), failed: s.failed + (x?.failed ?? 0) }), { successful: 0, failed: 0 });
    const after = await verifyPhase('after mixed / all-success / all-failure runs', fromActions);

    for (const who of ['user1', 'user2', 'user3'] as const) {
      const denied = await api('GET', '/analytics/by-user', token[who]);
      check('authorization', `${who}: admin-only per-user analytics -> 403`, denied.status === 403, `HTTP ${denied.status}`);
    }
    const anonymous = await api('GET', '/analytics/runs');
    check('authorization', 'unauthenticated GET /api/analytics/runs -> 401', anonymous.status === 401, `HTTP ${anonymous.status}`);

    const passed = checks.filter(c => c.pass).length;
    mkdirSync(dirname(RESULTS_JSON), { recursive: true });
    writeFileSync(RESULTS_JSON, JSON.stringify({ overall: passed === checks.length ? 'PASS' : 'FAIL', generatedAt: new Date().toISOString(), provider: 'CONTROLLED (no OpenAI calls)', database: 'backend/data/dashboard-verify.db', phases: { zeroRuns: before, afterRuns: after }, checks }, null, 2) + '\n');
    console.log(`\nDashboard run-outcome verification: ${passed === checks.length ? 'PASS' : 'FAIL'} - ${passed}/${checks.length} checks`);
    process.exitCode = passed === checks.length ? 0 : 1;
  } finally {
    if (browser) await browser.close();
    vite?.kill();
    server.close();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(`Dashboard run-outcome verification did not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
