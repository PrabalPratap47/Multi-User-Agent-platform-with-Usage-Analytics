import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Step 16 - REAL OpenAI multi-user and concurrency verification.
 *
 * Real application end to end: a fresh SQLite file seeded by the real seed
 * script (demo users), the real Express app on an ephemeral port, real
 * POST /api/auth/login, real agent/analytics endpoints, and REAL OpenAI
 * calls through the production adapter (createOpenAIClient). The only
 * addition is a recording fetch that captures each raw OpenAI response
 * (id, model, usage) and how many calls are in flight - never headers.
 *
 * Costs roughly 12-16 short gpt-4o calls. Requires a valid OPENAI_API_KEY.
 * Run with: `npm run verify:multi-user-real-openai` from backend/.
 * Writes evaluation/multi-user-real-openai-report.{md,json}.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, '..', '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');
const DB_FILE = join(BACKEND_ROOT, 'data', 'multi-user-real.db');
const DATABASE_URL = 'file:../data/multi-user-real.db';
const REPORT_MD = join(PROJECT_ROOT, 'evaluation', 'multi-user-real-openai-report.md');
const REPORT_JSON = join(PROJECT_ROOT, 'evaluation', 'multi-user-real-openai-report.json');
const PASSWORD = 'password123'; // seeded demo password (src/db/seed.ts)

type Regular = 'user1' | 'user2' | 'user3';
type Who = Regular | 'admin';
const USERS: Regular[] = ['user1', 'user2', 'user3'];
const EMAIL: Record<Who, string> = {
  user1: 'user1@example.com',
  user2: 'user2@example.com',
  user3: 'user3@example.com',
  admin: 'admin@example.com',
};

const CV: Record<Regular, { text: string; expected: string }> = {
  user1: {
    expected: 'Back-End Developer',
    text: 'Reference MU-USER1-CV. Maria Lopez - Backend Engineer. Six years designing REST and GraphQL APIs in Node.js and Express, PostgreSQL schema design, Redis caching and event-driven microservices on Kafka. Led the migration of a payments monolith to services with full CI/CD.',
  },
  user2: {
    expected: 'Front-End Developer',
    text: 'Reference MU-USER2-CV. Tom Becker - Frontend Developer. Four years building React and TypeScript single-page applications, a shared component library with Storybook, responsive CSS and WCAG accessibility audits. Improved Lighthouse performance scores from 60 to 95.',
  },
  user3: {
    expected: 'Web Automation',
    text: 'Reference MU-USER3-CV. Aisha Khan - QA Automation Engineer. Built Selenium WebDriver and Cypress end-to-end suites for a large e-commerce web shop, page-object frameworks, cross-browser runs on Selenium Grid and nightly regression reporting in Jenkins.',
  },
};
const CONCURRENT_CV: Record<'user1' | 'user2', { text: string; expected: string }> = {
  user1: {
    expected: 'AI Engineer',
    text: 'Reference MU-USER1-CV-CONCURRENT. Dana Cruz - Machine Learning Engineer. Builds retrieval-augmented generation pipelines on large language models, fine-tunes transformer models in PyTorch, and deploys embedding search with vector databases.',
  },
  user2: {
    expected: 'Mobile Automation',
    text: 'Reference MU-USER2-CV-CONCURRENT. Robin Park - Mobile QA Engineer. Automates Android and iOS app testing with Appium, Espresso and XCUITest, runs device-farm suites on BrowserStack and maintains mobile regression pipelines.',
  },
};
const FEEDBACK: Record<Regular, { text: string; expected: string }> = {
  user1: { expected: 'positive', text: 'Reference MU-USER1-SENTIMENT. The new dashboard is fantastic - setup took five minutes and support answered my question right away.' },
  user2: { expected: 'negative', text: 'Reference MU-USER2-SENTIMENT. Checkout failed three times and nobody has replied to my support ticket in a week.' },
  user3: { expected: 'neutral', text: 'Reference MU-USER3-SENTIMENT. The update moved the settings menu to the sidebar. I have not decided yet whether I prefer it.' },
};
const MIXED_FEEDBACK = {
  user1: 'Reference MU-USER1-SENTIMENT-CONCURRENT. Exporting reports to PDF is quick and the layout looks professional.',
  user3: 'Reference MU-USER3-SENTIMENT-CONCURRENT. The mobile app crashes every time I try to upload a photo.',
};
const MIXED_CV_USER2 =
  'Reference MU-USER2-CV-MIXED. Lee Morgan - Conversational AI QA. Tests chatbot applications end to end: intent recognition, dialogue flows, fallback handling and LLM answer quality for customer-support bots.';

// ── Raw OpenAI capture ────────────────────────────────────────────────────

interface ProviderCall {
  responseId: string | null;
  httpStatus: number;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  marker: string | null;
  startedAt: number;
  endedAt: number;
}
const providerCalls: ProviderCall[] = [];
let inFlight = 0;
let peakInFlight = 0;

function recordingFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/chat/completions')) return fetch(input, init);
    // Which user's content this call carries: read the reference marker from
    // the request body (never the headers).
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const marker = bodyText.match(/MU-USER[123]-[A-Z-]+/)?.[0] ?? null;
    const startedAt = Date.now();
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const response = await fetch(input, init);
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { id?: string; model?: string; usage?: Record<string, unknown> } | null;
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      providerCalls.push({
        responseId: body?.id ?? null,
        httpStatus: response.status,
        model: body?.model ?? null,
        promptTokens: num(body?.usage?.prompt_tokens),
        completionTokens: num(body?.usage?.completion_tokens),
        totalTokens: num(body?.usage?.total_tokens),
        marker,
        startedAt,
        endedAt: Date.now(),
      });
      return response;
    } finally {
      inFlight -= 1;
    }
  };
}

const markerOwner = (marker: string | null): Regular | null =>
  (marker?.match(/MU-(USER[123])-/)?.[1].toLowerCase() as Regular | undefined) ?? null;

// ── Check bookkeeping ─────────────────────────────────────────────────────

interface Check {
  section: string;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(section: string, name: string, pass: boolean, detail = '') {
  checks.push({ section, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

interface Timed {
  status: number;
  body: { data?: Record<string, unknown> & { id?: number; runId?: string }; error?: string } | null;
  startedAt: number;
  endedAt: number;
}

async function main() {
  if (process.env.NODE_ENV === 'test') throw new Error('Refusing to run under NODE_ENV=test.');
  process.env.DATABASE_URL = DATABASE_URL;

  const { default: config } = await import('../config/env.js');
  if (!config.OPENAI_API_KEY.trim()) throw new Error('OPENAI_API_KEY is not set - real OpenAI calls are required.');
  const { default: dotenv } = await import('dotenv');
  const fileKey = (() => {
    try {
      return dotenv.parse(readFileSync(join(BACKEND_ROOT, '.env.local'))).OPENAI_API_KEY ?? '';
    } catch {
      return '';
    }
  })();
  const keySource = config.OPENAI_API_KEY === fileKey ? 'backend/.env.local' : 'process environment';

  // Fresh database: real migrations + the real seed script (demo users and agents).
  mkdirSync(dirname(DB_FILE), { recursive: true });
  for (const s of ['', '-journal', '-wal', '-shm']) rmSync(DB_FILE + s, { force: true });
  const req = createRequire(import.meta.url);
  const env = { ...process.env, DATABASE_URL };
  execFileSync(process.execPath, [req.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(BACKEND_ROOT, 'prisma', 'schema.prisma')], { cwd: BACKEND_ROOT, env, stdio: 'pipe' });
  execFileSync(process.execPath, [req.resolve('tsx/cli'), 'src/db/seed.ts'], { cwd: BACKEND_ROOT, env, stdio: 'pipe' });

  const { default: prisma } = await import('../db/client.js');
  const { default: app } = await import('../app.js');
  const { createOpenAIClient, LLMService } = await import('../services/llmService.js');
  const { getModelPricing } = await import('../config/modelPricing.js');
  const { isPrimaryRationaleGrounded } = await import('../agents/cvClassification/outputGuard.js');
  const cvModule = await import('../agents/CVClassificationAgent.js');
  const sentimentModule = await import('../agents/SentimentAgent.js');

  // Production agents + production OpenAI adapter; only fetch records.
  const llm = new LLMService(createOpenAIClient({ fetch: recordingFetch() }));
  cvModule.__setCvClassificationAgentForTesting(new cvModule.CVClassificationAgent(llm));
  sentimentModule.__setSentimentAgentForTesting(new sentimentModule.SentimentAgent(llm));

  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const http = async (method: string, path: string, token?: string, body?: unknown): Promise<Timed> => {
    const startedAt = Date.now();
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Timed['body'];
    return { status: res.status, body: json, startedAt, endedAt: Date.now() };
  };
  const overlaps = (a: { startedAt: number; endedAt: number }, b: { startedAt: number; endedAt: number }) =>
    a.startedAt < b.endedAt && b.startedAt < a.endedAt;

  const token = {} as Record<Who, string>;
  const uid = {} as Record<Who, number>;
  const cvRuns: Array<{ who: Regular; label: string; recId: number; docId: number; runId: string; category: string; expected: string; window: Timed }> = [];
  const sentimentRuns: Array<{ who: Regular; label: string; resultId: number; runId: string; sentiment: string; expected: string; window: Timed }> = [];

  const runCv = async (who: Regular, label: string, text: string, expected: string, t: Timed) => {
    const ok = t.status === 201 && !!t.body?.data;
    check(label, `${who}: CV Classification Agent (real OpenAI) -> HTTP 201`, ok, ok ? '' : `HTTP ${t.status} ${t.body?.error ?? ''}`);
    if (!ok) return;
    const d = t.body!.data! as { id: number; cvDocumentId: number; runId: string; userId: number; primaryCategory: string };
    const run = await prisma.agentRun.findUnique({ where: { id: d.runId } });
    const doc = await prisma.cvDocument.findUnique({ where: { id: d.cvDocumentId } });
    const rec = await prisma.cvRecommendation.findUnique({ where: { id: d.id } });
    check(label, `${who}: result, CV document and run all belong to ${who}`, d.userId === uid[who] && doc?.userId === uid[who] && run?.userId === uid[who] && run?.cvDocumentId === d.cvDocumentId && run?.status === 'SUCCESS');
    check(label, `${who}: the stored CV is ${who}'s own text`, !!doc?.content.includes(text.slice(0, 30)));
    const rationale = (rec?.rationale ?? []) as Array<{ category: string; evidence: string }>;
    check(label, `${who}: the model's evidence is grounded in ${who}'s own CV`, isPrimaryRationaleGrounded(d.primaryCategory, rationale, text), `category ${d.primaryCategory} (expected ${expected})`);
    cvRuns.push({ who, label, recId: d.id, docId: d.cvDocumentId, runId: d.runId, category: d.primaryCategory, expected, window: t });
  };
  const runSentiment = async (who: Regular, label: string, expected: string, t: Timed) => {
    const ok = t.status === 201 && !!t.body?.data;
    check(label, `${who}: Sentiment Agent (real OpenAI) -> HTTP 201`, ok, ok ? '' : `HTTP ${t.status} ${t.body?.error ?? ''}`);
    if (!ok) return;
    const d = t.body!.data! as { id: number; runId: string; userId: number; sentiment: string };
    const run = await prisma.agentRun.findUnique({ where: { id: d.runId } });
    check(label, `${who}: sentiment result and run belong to ${who}`, d.userId === uid[who] && run?.userId === uid[who] && run?.status === 'SUCCESS', `sentiment ${d.sentiment} (expected ${expected})`);
    sentimentRuns.push({ who, label, resultId: d.id, runId: d.runId, sentiment: d.sentiment, expected, window: t });
  };

  try {
    // ── Login (real flow) ──
    for (const who of Object.keys(EMAIL) as Who[]) {
      const res = await http('POST', '/auth/login', undefined, { email: EMAIL[who], password: PASSWORD });
      const data = res.body?.data as { accessToken: string; user: { id: number } } | undefined;
      check('Login', `${who} logs in through POST /api/auth/login`, res.status === 200 && !!data?.accessToken);
      token[who] = data!.accessToken;
      uid[who] = data!.user.id;
      const me = await http('GET', '/auth/me', token[who]);
      check('Login', `${who}: identity comes from the session token`, (me.body?.data as { id: number } | undefined)?.id === uid[who]);
    }

    // ── Tests 1-3: each user runs both agents ──
    for (const [i, who] of USERS.entries()) {
      const label = `Test ${i + 1} - ${who}`;
      await runCv(who, label, CV[who].text, CV[who].expected, await http('POST', '/cv/classify', token[who], { cvContent: CV[who].text, fileName: `${who}-cv.txt` }));
      await runSentiment(who, label, FEEDBACK[who].expected, await http('POST', '/sentiment/analyze', token[who], { text: FEEDBACK[who].text }));
    }

    // ── Concurrency A: user1 and user2 classify CVs at the same time ──
    let callsBefore = providerCalls.length;
    peakInFlight = 0;
    const [a1, a2] = await Promise.all([
      http('POST', '/cv/classify', token.user1, { cvContent: CONCURRENT_CV.user1.text, fileName: 'user1-concurrent.txt' }),
      http('POST', '/cv/classify', token.user2, { cvContent: CONCURRENT_CV.user2.text, fileName: 'user2-concurrent.txt' }),
    ]);
    const peakA = peakInFlight;
    await runCv('user1', 'Concurrency A', CONCURRENT_CV.user1.text, CONCURRENT_CV.user1.expected, a1);
    await runCv('user2', 'Concurrency A', CONCURRENT_CV.user2.text, CONCURRENT_CV.user2.expected, a2);
    const callsA = providerCalls.slice(callsBefore);
    const c1 = callsA.find(c => markerOwner(c.marker) === 'user1');
    const c2 = callsA.find(c => markerOwner(c.marker) === 'user2');
    const r1 = a1.body?.data?.runId ? await prisma.agentRun.findUnique({ where: { id: a1.body.data.runId } }) : null;
    const r2 = a2.body?.data?.runId ? await prisma.agentRun.findUnique({ where: { id: a2.body.data.runId } }) : null;
    const runWindow = (r: typeof r1) => (r ? { startedAt: r.startedAt.getTime(), endedAt: r.completedAt?.getTime() ?? 0 } : { startedAt: 0, endedAt: 0 });
    const concurrencyEvidence = {
      http: { user1: [a1.startedAt, a1.endedAt], user2: [a2.startedAt, a2.endedAt] },
      provider: { user1: c1 ? [c1.startedAt, c1.endedAt] : null, user2: c2 ? [c2.startedAt, c2.endedAt] : null, peakConcurrentCalls: peakA },
      dbRuns: { user1: r1 ? [runWindow(r1).startedAt, runWindow(r1).endedAt] : null, user2: r2 ? [runWindow(r2).startedAt, runWindow(r2).endedAt] : null },
    };
    check('Concurrency A', 'HTTP requests overlapped (user1 start < user2 end AND user2 start < user1 end)', overlaps(a1, a2), `user1 ${a1.endedAt - a1.startedAt} ms, user2 ${a2.endedAt - a2.startedAt} ms`);
    check('Concurrency A', 'real OpenAI calls overlapped', !!c1 && !!c2 && overlaps(c1, c2));
    check('Concurrency A', 'peak concurrent OpenAI calls >= 2', peakA >= 2, `peak ${peakA}`);
    check('Concurrency A', 'stored run start/complete intervals overlapped', !!r1 && !!r2 && overlaps(runWindow(r1), runWindow(r2)));
    check('Concurrency A', 'distinct run ids', !!r1 && !!r2 && r1.id !== r2.id);

    // ── Concurrency B: three users, both agents at once ──
    callsBefore = providerCalls.length;
    peakInFlight = 0;
    const [b1, b2, b3] = await Promise.all([
      http('POST', '/sentiment/analyze', token.user1, { text: MIXED_FEEDBACK.user1 }),
      http('POST', '/cv/classify', token.user2, { cvContent: MIXED_CV_USER2, fileName: 'user2-mixed.txt' }),
      http('POST', '/sentiment/analyze', token.user3, { text: MIXED_FEEDBACK.user3 }),
    ]);
    const peakB = peakInFlight;
    await runSentiment('user1', 'Concurrency B', 'positive', b1);
    await runCv('user2', 'Concurrency B', MIXED_CV_USER2, 'Chatbot Application Tester', b2);
    await runSentiment('user3', 'Concurrency B', 'negative', b3);
    check('Concurrency B', 'three users and both agents overlapped', overlaps(b1, b2) && overlaps(b2, b3), `peak ${peakB}`);
    check('Concurrency B', 'peak concurrent OpenAI calls >= 2', peakB >= 2, `peak ${peakB}`);
    void callsBefore;

    // ── Decisions at the same time (no OpenAI involved) ──
    const u1Rec = cvRuns.find(r => r.who === 'user1' && r.label.startsWith('Test'));
    const u2Rec = cvRuns.find(r => r.who === 'user2' && r.label.startsWith('Test'));
    let decisionConcurrency: 'PASS' | 'FAIL' | 'NOT TESTED' = 'NOT TESTED';
    if (u1Rec && u2Rec) {
      const originals = await prisma.cvRecommendation.findMany({ where: { id: { in: [u1Rec.recId, u2Rec.recId] } } });
      const missingReason = await http('POST', `/cv/results/${u1Rec.recId}/decision`, token.user1, { decisionType: 'MODIFY', finalPrimaryCategory: 'Other' });
      const missingRejectReason = await http('POST', `/cv/results/${u2Rec.recId}/decision`, token.user2, { decisionType: 'REJECT' });
      check('Decisions', 'MODIFY and REJECT without a reason are rejected (400)', missingReason.status === 400 && missingRejectReason.status === 400);
      const [d1, d2] = await Promise.all([
        http('POST', `/cv/results/${u1Rec.recId}/decision`, token.user1, { decisionType: 'MODIFY', finalPrimaryCategory: 'Other', reason: 'user1 concurrent modify' }),
        http('POST', `/cv/results/${u2Rec.recId}/decision`, token.user2, { decisionType: 'REJECT', reason: 'user2 concurrent reject' }),
      ]);
      const dec1 = d1.body?.data?.id ? await prisma.recommendationDecision.findUnique({ where: { id: d1.body.data.id } }) : null;
      const dec2 = d2.body?.data?.id ? await prisma.recommendationDecision.findUnique({ where: { id: d2.body.data.id } }) : null;
      const ok1 = !!dec1 && dec1.userId === uid.user1 && dec1.recommendationId === u1Rec.recId && dec1.cvDocumentId === u1Rec.docId && dec1.agentRunId === u1Rec.runId && dec1.decisionType === 'MODIFY';
      const ok2 = !!dec2 && dec2.userId === uid.user2 && dec2.recommendationId === u2Rec.recId && dec2.cvDocumentId === u2Rec.docId && dec2.agentRunId === u2Rec.runId && dec2.decisionType === 'REJECT' && dec2.finalPrimaryCategory === null;
      check('Decisions', 'concurrent user1 MODIFY and user2 REJECT each attached to their own CV, run and user', d1.status === 201 && d2.status === 201 && ok1 && ok2);
      const after = await prisma.cvRecommendation.findMany({ where: { id: { in: [u1Rec.recId, u2Rec.recId] } } });
      check('Decisions', 'original recommendations unchanged', JSON.stringify(after) === JSON.stringify(originals));
      decisionConcurrency = checks.filter(c => c.section === 'Decisions').every(c => c.pass) ? 'PASS' : 'FAIL';
    }

    // ── Cross-user authorization ──
    const pairs: Array<[Regular, Regular]> = [['user1', 'user2'], ['user2', 'user1'], ['user1', 'user3'], ['user2', 'user3'], ['user3', 'user1'], ['user3', 'user2']];
    for (const [attacker, victim] of pairs) {
      const v = cvRuns.find(r => r.who === victim);
      const vs = sentimentRuns.find(r => r.who === victim);
      if (!v || !vs) {
        check('Isolation', `${attacker} -> ${victim}: denied`, false, `no ${victim} records to test against`);
        continue;
      }
      const before = providerCalls.length;
      const attempts = [
        await http('GET', `/cv/results/${v.recId}`, token[attacker]),
        await http('GET', `/cv/results/${v.recId}/decisions`, token[attacker]),
        await http('POST', `/cv/results/${v.recId}/decision`, token[attacker], { decisionType: 'ACCEPT' }),
        await http('POST', `/cv/documents/${v.docId}/classify`, token[attacker], {}),
        await http('GET', `/sentiment/results/${vs.resultId}`, token[attacker]),
        await http('GET', `/usage-logs/${uid[victim]}`, token[attacker]),
      ];
      const allDenied = attempts.every(a => a.status === 403);
      const leaked = attempts.some(a => JSON.stringify(a.body).includes(`MU-${victim.toUpperCase()}`));
      check('Isolation', `${attacker} -> ${victim}: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied`, allDenied && !leaked && providerCalls.length === before, `${attempts.map(a => a.status).join('/')}; OpenAI calls triggered: ${providerCalls.length - before}`);
    }
    for (const who of USERS) {
      const lists = [await http('GET', '/cv/results', token[who]), await http('GET', '/sentiment/results', token[who]), await http('GET', '/usage-logs', token[who])];
      const own = lists.every(l => (l.body?.data as unknown as Array<{ userId: number }>).every(r => r.userId === uid[who]));
      check('Isolation', `${who}'s CV, sentiment and usage-log lists contain only ${who}'s rows`, own);
      const summary = (await http('GET', '/analytics/summary', token[who])).body?.data as unknown as { totalInputTokens: number; totalOutputTokens: number };
      const mine = await prisma.llmUsageLog.aggregate({ where: { userId: uid[who], isSeedData: false }, _sum: { inputTokens: true, outputTokens: true } });
      check('Isolation', `${who}'s dashboard summary equals ${who}'s own real usage only`, summary.totalInputTokens === mine._sum.inputTokens && summary.totalOutputTokens === mine._sum.outputTokens, `${summary.totalInputTokens} in / ${summary.totalOutputTokens} out`);
    }

    // ── Usage logging: every real OpenAI call vs. its usage log row ──
    const logs = await prisma.llmUsageLog.findMany({ where: { isSeedData: false }, include: { run: true }, orderBy: { id: 'asc' } });
    const successfulCalls = providerCalls.filter(c => c.httpStatus === 200);
    const usageRows = successfulCalls.map(call => {
      const log = logs.find(l => l.providerResponseId === call.responseId);
      const owner = markerOwner(call.marker);
      const pricing = log ? getModelPricing(log.model) : null;
      const expectedCost = log && pricing ? log.inputTokens * pricing.inputPerToken + log.outputTokens * pricing.outputPerToken : null;
      const problems: string[] = [];
      if (!log) problems.push('no usage log row');
      else {
        if (!owner || log.userId !== uid[owner]) problems.push('user mismatch');
        if (log.inputTokens !== call.promptTokens) problems.push('input tokens differ');
        if (log.outputTokens !== call.completionTokens) problems.push('output tokens differ');
        if (log.model !== call.model) problems.push('model differs');
        if (log.status !== 'SUCCESS') problems.push('status not SUCCESS');
        if (!(log.latencyMs > 0)) problems.push('no latency');
        if (expectedCost === null || log.estimatedCost === null || Math.abs(log.estimatedCost - expectedCost) > 1e-12) problems.push('cost mismatch');
        if (!log.run || log.run.userId !== log.userId) problems.push('run not owned by the same user');
      }
      return { call, log, owner, expectedCost, problems };
    });
    const unmatched = logs.filter(l => l.status === 'SUCCESS' && !successfulCalls.some(c => c.responseId === l.providerResponseId));
    check('Usage logging', `every successful real OpenAI call has a matching usage log (user, agent, model, tokens, latency, status, cost, run, response id)`, usageRows.length > 0 && usageRows.every(r => r.problems.length === 0), `${usageRows.filter(r => r.problems.length === 0).length}/${usageRows.length} rows exact`);
    check('Usage logging', 'no usage log row without a real OpenAI response', unmatched.length === 0, `${unmatched.length} unmatched`);
    check('Usage logging', 'no failed (non-200) OpenAI responses', providerCalls.every(c => c.httpStatus === 200), `${providerCalls.filter(c => c.httpStatus !== 200).length} non-200`);

    // ── Admin global views ──
    const rawIn = successfulCalls.reduce((s, c) => s + (c.promptTokens ?? 0), 0);
    const rawOut = successfulCalls.reduce((s, c) => s + (c.completionTokens ?? 0), 0);
    const adminSummary = (await http('GET', '/analytics/summary', token.admin)).body?.data as unknown as { totalInputTokens: number; totalOutputTokens: number; callCount: number; estimatedCost: number };
    const dbAgg = await prisma.llmUsageLog.aggregate({ where: { isSeedData: false }, _sum: { inputTokens: true, outputTokens: true, estimatedCost: true }, _count: { _all: true } });
    check('Admin', 'admin global summary = database totals = raw OpenAI usage totals', adminSummary.totalInputTokens === dbAgg._sum.inputTokens && dbAgg._sum.inputTokens === rawIn && adminSummary.totalOutputTokens === dbAgg._sum.outputTokens && dbAgg._sum.outputTokens === rawOut, `input ${rawIn} / output ${rawOut}`);
    const byUser = (await http('GET', '/analytics/by-user', token.admin)).body?.data as unknown as Array<{ userId: number; email: string; totalInputTokens: number; totalOutputTokens: number; callCount: number }>;
    const perUser = USERS.map(who => {
      const calls = usageRows.filter(r => r.owner === who).map(r => r.call);
      const raw = { in: calls.reduce((s, c) => s + (c.promptTokens ?? 0), 0), out: calls.reduce((s, c) => s + (c.completionTokens ?? 0), 0), calls: calls.length };
      const row = byUser.find(u => u.userId === uid[who]);
      return { who, raw, row };
    });
    check('Admin', 'per-user breakdown lists all three users with their exact raw OpenAI token totals', perUser.every(p => p.row && p.row.totalInputTokens === p.raw.in && p.row.totalOutputTokens === p.raw.out && p.row.callCount === p.raw.calls));
    const byAgent = (await http('GET', '/analytics/by-agent', token.admin)).body?.data as unknown as Array<{ agentName: string; totalInputTokens: number; callCount: number }>;
    const agentRaw = (name: string) => usageRows.filter(r => r.log?.agentName === name).reduce((s, r) => s + (r.call.promptTokens ?? 0), 0);
    check('Admin', 'per-agent breakdown matches raw OpenAI usage for both agents', [cvModule.CV_CLASSIFICATION_AGENT_NAME, sentimentModule.SENTIMENT_AGENT_NAME].every(n => byAgent.find(a => a.agentName === n)?.totalInputTokens === agentRaw(n)));
    const adminLists = { cv: (await http('GET', '/cv/results', token.admin)).body?.data as unknown as Array<{ userId: number }>, sentiment: (await http('GET', '/sentiment/results', token.admin)).body?.data as unknown as Array<{ userId: number }> };
    check('Admin', "admin sees all three users' CV and sentiment results", USERS.every(w => adminLists.cv.some(r => r.userId === uid[w]) && adminLists.sentiment.some(r => r.userId === uid[w])));
    const adminDenied = await Promise.all(USERS.map(w => http('GET', '/analytics/by-user', token[w])));
    check('Admin', 'regular users are denied the admin per-user view (403)', adminDenied.every(r => r.status === 403));

    // ── Report ──
    const status = (section: string) => (checks.filter(c => c.section.startsWith(section)).every(c => c.pass) ? 'PASS' : 'FAIL');
    const userStatus = (who: Regular) => (checks.filter(c => c.name.startsWith(`${who}:`) || c.name.startsWith(`${who} `)).every(c => c.pass) ? 'PASS' : 'FAIL');
    const totalCost = usageRows.reduce((s, r) => s + (r.log?.estimatedCost ?? 0), 0);
    const passed = checks.filter(c => c.pass).length;
    const summary = {
      overall: checks.every(c => c.pass) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      keySource,
      configuredModel: config.OPENAI_MODEL,
      realOpenAICalls: providerCalls.length,
      successfulRealOpenAICalls: successfulCalls.length,
      peakConcurrentProviderCalls: Math.max(peakA, peakB),
      rawTokens: { input: rawIn, output: rawOut },
      totalEstimatedCostUsd: totalCost,
      userStatus: Object.fromEntries(USERS.map(w => [w, userStatus(w)])),
      decisionConcurrency,
      checks: { passed, failed: checks.length - passed },
    };
    mkdirSync(dirname(REPORT_JSON), { recursive: true });
    writeFileSync(
      REPORT_JSON,
      JSON.stringify(
        {
          ...summary,
          concurrencyEvidence,
          cvRuns: cvRuns.map(r => ({ who: r.who, label: r.label, runId: r.runId, category: r.category, expected: r.expected, httpMs: r.window.endedAt - r.window.startedAt })),
          sentimentRuns: sentimentRuns.map(r => ({ who: r.who, label: r.label, runId: r.runId, sentiment: r.sentiment, expected: r.expected, httpMs: r.window.endedAt - r.window.startedAt })),
          usage: usageRows.map(r => ({ user: r.owner, agent: r.log?.agentName, runId: r.log?.runId, model: r.call.model, rawInputTokens: r.call.promptTokens, loggedInputTokens: r.log?.inputTokens, rawOutputTokens: r.call.completionTokens, loggedOutputTokens: r.log?.outputTokens, totalTokens: r.call.totalTokens, latencyMs: r.log?.latencyMs, status: r.log?.status, estimatedCost: r.log?.estimatedCost, providerResponseIdStored: !!r.log?.providerResponseId, problems: r.problems })),
          perUser: perUser.map(p => ({ user: p.who, rawInputTokens: p.raw.in, rawOutputTokens: p.raw.out, calls: p.raw.calls, dashboardInputTokens: p.row?.totalInputTokens, dashboardOutputTokens: p.row?.totalOutputTokens })),
          checksDetail: checks,
        },
        null,
        2
      ) + '\n'
    );

    const fmtTime = (ms: number) => new Date(ms).toISOString().slice(11, 23);
    const md = [
      '# Multi-User Real OpenAI Verification (Step 16)',
      '',
      `**Overall: ${summary.overall}** · ${passed}/${checks.length} checks passed · generated ${summary.generatedAt}`,
      '',
      '## REAL OPENAI',
      '',
      'Everything in this section used the **real OpenAI API**. It ran on the real application: a fresh database seeded by the real seed script, real logins (`POST /api/auth/login`) as user1, user2, user3 and admin, and the real HTTP endpoints. Calls went through the production OpenAI adapter, wrapped only by a recording `fetch` that reads each raw response (id, model, usage) and counts calls in flight. Token values come directly from OpenAI\'s `usage.prompt_tokens` / `usage.completion_tokens`.',
      '',
      `- **API key source:** ${keySource} (the value is never printed)`,
      `- **Configured model:** ${config.OPENAI_MODEL}`,
      `- **Real OpenAI calls:** ${providerCalls.length} (${successfulCalls.length} HTTP 200)`,
      `- **Raw OpenAI tokens:** ${rawIn} input / ${rawOut} output`,
      `- **Estimated cost of this run:** $${totalCost.toFixed(4)}`,
      `- **Peak concurrent OpenAI calls:** ${summary.peakConcurrentProviderCalls}`,
      '',
      '| Area | Result |',
      '|---|---|',
      ...USERS.map(w => `| ${w}: both agents (real OpenAI) | ${summary.userStatus[w]} |`),
      `| CV Classification Agent (real OpenAI) | ${cvRuns.length > 0 && checks.filter(c => c.name.includes('CV Classification Agent')).every(c => c.pass) ? 'PASS' : 'FAIL'} |`,
      `| Sentiment Agent (real OpenAI) | ${sentimentRuns.length > 0 && checks.filter(c => c.name.includes('Sentiment Agent')).every(c => c.pass) ? 'PASS' : 'FAIL'} |`,
      `| Real concurrency | ${status('Concurrency')} |`,
      `| User isolation | ${status('Isolation')} |`,
      `| Admin access | ${status('Admin')} |`,
      `| Usage logging | ${status('Usage logging')} |`,
      `| Concurrent decisions | ${decisionConcurrency} |`,
      '',
      '### Concurrency evidence (user1 and user2 classifying CVs at the same time)',
      '',
      '| | user1 | user2 |',
      '|---|---|---|',
      `| HTTP request | ${fmtTime(a1.startedAt)} → ${fmtTime(a1.endedAt)} | ${fmtTime(a2.startedAt)} → ${fmtTime(a2.endedAt)} |`,
      `| OpenAI call | ${c1 ? `${fmtTime(c1.startedAt)} → ${fmtTime(c1.endedAt)}` : '-'} | ${c2 ? `${fmtTime(c2.startedAt)} → ${fmtTime(c2.endedAt)}` : '-'} |`,
      `| Stored run (start → complete) | ${r1 ? `${fmtTime(runWindow(r1).startedAt)} → ${fmtTime(runWindow(r1).endedAt)}` : '-'} | ${r2 ? `${fmtTime(runWindow(r2).startedAt)} → ${fmtTime(runWindow(r2).endedAt)}` : '-'} |`,
      '',
      `Peak concurrent OpenAI calls: **${peakA}** (concurrency A), **${peakB}** (concurrency B: user1 sentiment, user2 CV and user3 sentiment at once). Times are UTC.`,
      '',
      '### Agent runs',
      '',
      '| User | Phase | Agent | Run ID | Model output | Expected (informational) | HTTP time |',
      '|---|---|---|---|---|---|---:|',
      ...cvRuns.map(r => `| ${r.who} | ${r.label} | CV Classification | ${r.runId} | ${r.category} | ${r.expected} | ${r.window.endedAt - r.window.startedAt} ms |`),
      ...sentimentRuns.map(r => `| ${r.who} | ${r.label} | Sentiment | ${r.runId} | ${r.sentiment} | ${r.expected} | ${r.window.endedAt - r.window.startedAt} ms |`),
      '',
      '"Expected" is what a reader would anticipate; the real model\'s answer is reported as returned and is not a pass/fail criterion. Grounding of CV evidence in that user\'s own CV is a pass/fail check.',
      '',
      '### Usage logs vs. raw OpenAI responses (every real call)',
      '',
      '| User | Agent | Run ID | Model | Raw in | Logged in | Raw out | Logged out | Total | Latency | Status | Cost (USD) | Response id stored | Result |',
      '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|',
      ...usageRows.map(r => `| ${r.owner ?? '?'} | ${r.log?.agentName ?? '-'} | ${r.log?.runId ?? '-'} | ${r.call.model ?? '-'} | ${r.call.promptTokens ?? '-'} | ${r.log?.inputTokens ?? '-'} | ${r.call.completionTokens ?? '-'} | ${r.log?.outputTokens ?? '-'} | ${r.call.totalTokens ?? '-'} | ${r.log?.latencyMs ?? '-'} ms | ${r.log?.status ?? '-'} | ${r.log?.estimatedCost?.toFixed(6) ?? '-'} | ${r.log?.providerResponseId ? 'yes' : 'no'} | ${r.problems.length ? `FAIL: ${r.problems.join(', ')}` : 'PASS'} |`),
      '',
      '### Per-user totals (admin view vs. raw OpenAI usage)',
      '',
      '| User | Raw OpenAI input | Admin dashboard input | Raw OpenAI output | Admin dashboard output | Calls |',
      '|---|---:|---:|---:|---:|---:|',
      ...perUser.map(p => `| ${p.who} | ${p.raw.in} | ${p.row?.totalInputTokens ?? '-'} | ${p.raw.out} | ${p.row?.totalOutputTokens ?? '-'} | ${p.raw.calls} |`),
      '',
      '### All checks',
      '',
      '| Section | Check | Result | Detail |',
      '|---|---|---|---|',
      ...checks.map(c => `| ${c.section} | ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`),
      '',
      '## CONTROLLED (provider stub, not real OpenAI)',
      '',
      '`backend/tests/multiUserConcurrency.test.ts` (30 tests, part of `npm test`) runs the same multi-user, isolation, concurrency, usage-logging and concurrent-decision checks with a **scripted provider stub** in place of OpenAI. It proves the application pipeline deterministically on every test run. It is **not** evidence about the real OpenAI API.',
      '',
      `Re-run this verification with \`cd backend && npm run verify:multi-user-real-openai\` (about ${providerCalls.length} short ${config.OPENAI_MODEL} calls). Database used: \`backend/data/multi-user-real.db\` (git-ignored, recreated on each run).`,
      '',
    ].join('\n');
    writeFileSync(REPORT_MD, md);

    console.log(`\nMulti-user real OpenAI verification: ${summary.overall} - ${passed}/${checks.length} checks, ${providerCalls.length} real OpenAI calls, peak concurrency ${summary.peakConcurrentProviderCalls}`);
    console.log('Reports: evaluation/multi-user-real-openai-report.md, evaluation/multi-user-real-openai-report.json');
    process.exitCode = summary.overall === 'PASS' ? 0 : 1;
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(`Multi-user real OpenAI verification did not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
