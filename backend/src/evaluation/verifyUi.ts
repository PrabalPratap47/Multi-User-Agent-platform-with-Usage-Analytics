import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * UI regression checks (Step 19): accessibility, responsive layout and the
 * main user flows, in Google Chrome against the real frontend (Vite) and the
 * real API. No OpenAI credits: agent runs use a CONTROLLED provider (the
 * production OpenAI adapter with a scripted fetch; "CTRL-RUN-FAIL" in the
 * input makes the provider reject the request).
 *
 * For admin and a regular user, at 1440 / 820 / 390 / 320 px, on every tab:
 *   - no horizontal page scrolling (wide tables scroll inside their card);
 *   - every visible form control and button has an accessible name;
 *   - all visible text meets WCAG AA contrast (4.5:1, 3:1 for large text).
 * Plus: a failed login shows the server's message in an alert; login,
 * role-specific tabs and logout; visible keyboard focus; a single CV
 * classified through the UI and decided (REJECT needs a reason), collapsed and
 * expanded, then deleted by an admin through its confirmation dialog (a
 * regular user has no Delete action, on CVs or sentiment); sticky dashboard
 * tabs while scrolling; a batch
 * with one failing file reports the failure; a sentiment result matches the API.
 *
 * Run with: `npm run verify:ui` from backend/ (needs Google Chrome).
 * Uses backend/data/ui-verify.db (git-ignored, recreated each run) and
 * writes evaluation/ui-verification-results.json.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, '..', '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');
const DB_FILE = join(BACKEND_ROOT, 'data', 'ui-verify.db');
const DATABASE_URL = 'file:../data/ui-verify.db';
const RESULTS_JSON = join(PROJECT_ROOT, 'evaluation', 'ui-verification-results.json');
const WEB_PORT = 5176;
const WEB = `http://localhost:${WEB_PORT}`;
const PASSWORD = 'password123'; // seeded demo password (src/db/seed.ts)
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 }, narrow: { width: 320, height: 640 } };
const USERS = { admin: 'admin@example.com', user1: 'user1@example.com' } as const;
const FAIL = 'CTRL-RUN-FAIL';
const CV_TEXT = 'Backend engineer building REST APIs in Go and PostgreSQL for five years.';

interface Check {
  area: string;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(area: string, name: string, pass: boolean, detail = '') {
  checks.push({ area, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let completionSeq = 0;
const completion = (content: string) =>
  jsonResponse(200, {
    id: `chatcmpl-CONTROLLED-${++completionSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'controlled-stub',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }],
  });
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

// Runs inside the page (kept as a string: the backend has no DOM typings).
const AUDIT = `(() => {
  const vw = window.innerWidth;
  const inScroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1 && !inScroller(el)) offenders.push(el.tagName.toLowerCase() + ' "' + (el.textContent || '').trim().slice(0, 40) + '"');
  }
  const nameOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(' ').map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    if (el.id && document.querySelector('label[for="' + el.id + '"]')) return document.querySelector('label[for="' + el.id + '"]').textContent.trim();
    if (el.closest('label')) return el.closest('label').textContent.trim();
    if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)) return (el.textContent || '').trim();
    return '';
  };
  const unnamed = [...document.querySelectorAll('input, select, textarea, button, a[href], summary')]
    .filter(el => el.type !== 'hidden' && el.getClientRects().length > 0 && !nameOf(el))
    .map(el => el.tagName.toLowerCase() + (el.type ? '[type=' + el.type + ']' : ''));
  const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { for (let p = el; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const lowContrast = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || el.getClientRects().length === 0) continue;
    if (el.closest('button:disabled, input:disabled, textarea:disabled, select:disabled')) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    let o = fg.a; for (let p = el; p; p = p.parentElement) o *= Number(getComputedStyle(p).opacity);
    const eff = { r: fg.r * o + bg.r * (1 - o), g: fg.g * o + bg.g * (1 - o), b: fg.b * o + bg.b * (1 - o) };
    const L1 = lum(eff), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) lowContrast.push('"' + el.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(2) + ':1');
  }
  return { overflowPx: document.documentElement.scrollWidth - vw, offenders: offenders.slice(0, 5), unnamed, lowContrast: lowContrast.slice(0, 5), lowContrastCount: lowContrast.length };
})()`;

const FOCUS_PROBE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  return { el: el.tagName.toLowerCase() + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + '"', visible: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && cs.boxShadow !== '') };
})()`;

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
  process.env.FRONTEND_URL = WEB;
  process.env.OPENAI_API_KEY = ''; // no real provider call is possible in this process
  process.env.LOG_LEVEL = 'error';

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

  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${apiOrigin}/api${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: ((await res.json().catch(() => null)) as { data?: unknown } | null)?.data };
  };

  try {
    // Realistic data through the real API, so every tab has rows, cards and a pending decision.
    const token: Record<string, string> = {};
    for (const [who, email] of Object.entries(USERS)) token[who] = ((await api('POST', '/auth/login', undefined, { email, password: PASSWORD })).data as { accessToken: string }).accessToken;
    const accepted = (await api('POST', '/cv/classify', token.user1, { cvContent: CV_TEXT, fileName: 'accepted-backend.txt' })).data as { id: number };
    await api('POST', `/cv/results/${accepted.id}/decision`, token.user1, { decisionType: 'ACCEPT' });
    await api('POST', '/cv/classify', token.user1, { cvContent: CV_TEXT, fileName: 'pending-backend-engineer-with-a-very-long-file-name-for-wrapping.txt' });
    await api('POST', '/cv/classify', token.user1, { cvContent: `${FAIL} ${CV_TEXT}`, fileName: 'failing.txt' });
    await api('POST', '/sentiment/analyze', token.user1, { text: 'The export feature works great and saves our team time every week.' });
    for (const [file, format] of [['external-agent-logs-valid.json', 'json'], ['external-agent-logs-mixed.jsonl', 'jsonl']] as const) {
      await api('POST', '/import/logs', token.user1, { sourceAgentName: 'Legacy Screening Bot', fileName: file, format, content: readFileSync(join(PROJECT_ROOT, 'docs', 'samples', file), 'utf8') });
    }

    const viteBin = [join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), join(PROJECT_ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')].find(p => existsSync(p));
    if (!viteBin) throw new Error('vite is not installed - run npm install at the repository root');
    vite = spawn(process.execPath, [viteBin, join(PROJECT_ROOT, 'frontend'), '--port', String(WEB_PORT), '--strictPort'], {
      cwd: join(PROJECT_ROOT, 'frontend'),
      env: { ...process.env, BROWSER: 'none', VITE_API_URL: apiOrigin },
      stdio: 'ignore',
    });
    await waitForHttp(WEB, 90_000);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    {
      // Warm-up: let the dev server finish its first compile before measuring anything.
      const warm = await browser.newPage();
      await warm.goto(WEB);
      await warm.locator('#email').waitFor({ timeout: 60_000 });
      await warm.waitForTimeout(2000);
      await warm.close();
    }

    const login = async (page: Page, email: string) => {
      await page.goto(WEB);
      await page.fill('#email', email);
      await page.fill('#password', PASSWORD);
      await page.getByRole('button', { name: 'Login' }).click();
      await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 });
    };
    const settle = async (page: Page) => {
      await page.waitForFunction('!/Loading/.test(document.body.innerText)', null, { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    };
    const tabNames = (page: Page) => page.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button').allInnerTexts();

    // ── Layout + accessibility audit: every tab, both roles, four widths ──
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport, locale: 'en-US' });
      const page = await ctx.newPage();

      await page.goto(WEB);
      await page.locator('#email').waitFor();
      const loginAudit = (await page.evaluate(AUDIT)) as { overflowPx: number; unnamed: string[]; lowContrastCount: number; lowContrast: string[] };
      await page.fill('#email', 'nobody@example.com');
      await page.fill('#password', 'wrong-password');
      await page.getByRole('button', { name: 'Login' }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 10_000 });
      const alertText = (await alert.innerText()).trim();
      check('Login', `${vpName}: a failed login shows the server's message in an alert`, alertText === 'Invalid email or password', `"${alertText}"`);
      const errorAudit = (await page.evaluate(AUDIT)) as typeof loginAudit;
      check('Layout', `${vpName} login page: no horizontal scroll, every control named, text contrast AA`, loginAudit.overflowPx <= 0 && loginAudit.unnamed.length === 0 && loginAudit.lowContrastCount === 0 && errorAudit.lowContrastCount === 0, `overflow ${loginAudit.overflowPx}px; unnamed [${loginAudit.unnamed.join(', ')}]; low contrast ${loginAudit.lowContrastCount + errorAudit.lowContrastCount} ${[...loginAudit.lowContrast, ...errorAudit.lowContrast].join(' | ')}`);
      await ctx.close();

      for (const [who, email] of Object.entries(USERS)) {
        const userCtx = await browser.newContext({ viewport, locale: 'en-US' });
        const p = await userCtx.newPage();
        await login(p, email);
        const tabs = (await tabNames(p)).map(t => t.trim());
        if (vpName === 'desktop') {
          check('Roles', `${who}: dashboard tabs match the role`, who === 'admin' ? tabs.includes('ADMIN USERS') : !tabs.includes('ADMIN USERS'), tabs.join(', '));
        }
        for (const tab of tabs) {
          await p.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: tab, exact: true }).click();
          await settle(p);
          if (tab === 'CV PROCESSING' && who === 'user1') {
            // Expand the pending result (records start collapsed) and open its full decision form (select, checkboxes, reason).
            const pending = p.getByRole('article').filter({ hasText: 'Awaiting review' }).first();
            await pending.getByRole('button', { expanded: false }).first().click();
            await pending.getByRole('radio', { name: 'MODIFY' }).click();
          }
          const current = await p.locator('[aria-current="page"]').allInnerTexts();
          const a = (await p.evaluate(AUDIT)) as { overflowPx: number; offenders: string[]; unnamed: string[]; lowContrast: string[]; lowContrastCount: number };
          check(
            'Layout',
            `${vpName} ${who} ${tab}: no horizontal page scroll, every control named, text contrast AA, active tab announced`,
            a.overflowPx <= 0 && a.unnamed.length === 0 && a.lowContrastCount === 0 && current.length === 1 && current[0].trim() === tab,
            `overflow ${a.overflowPx}px${a.offenders.length ? ` (${a.offenders.join('; ')})` : ''}; unnamed [${a.unnamed.join(', ')}]; low contrast ${a.lowContrastCount}${a.lowContrast.length ? ` (${a.lowContrast.join('; ')})` : ''}`
          );
        }
        if (vpName === 'desktop' && who === 'admin') {
          await p.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: 'ANALYTICS', exact: true }).click();
          await settle(p);
          await p.locator('body').click({ position: { x: 2, y: 2 } });
          const stops: Array<{ el: string; visible: boolean }> = [];
          for (let i = 0; i < 30; i++) {
            await p.keyboard.press('Tab');
            const s = (await p.evaluate(FOCUS_PROBE)) as { el: string; visible: boolean } | null;
            if (s) stops.push(s);
          }
          const hidden = stops.filter(s => !s.visible);
          check('Keyboard', 'admin desktop: every focus stop in the first 30 Tab presses has a visible focus indicator', stops.length >= 10 && hidden.length === 0, `${stops.length} stops; without indicator: ${hidden.map(h => h.el).join(', ') || 'none'}`);
        }
        await userCtx.close();
      }
    }

    // ── A table wider than a phone scrolls inside its card, by keyboard too ──
    {
      const mobileCtx = await browser.newContext({ viewport: VIEWPORTS.mobile, locale: 'en-US' });
      const m = await mobileCtx.newPage();
      await login(m, USERS.user1);
      await m.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: 'MY RECORDS', exact: true }).click();
      await settle(m);
      const region = m.getByRole('region', { name: 'Usage records (scrolls sideways)' });
      const found = (await region.count()) === 1;
      let scrolled = 0;
      if (found) {
        await region.focus();
        for (let i = 0; i < 8; i++) await m.keyboard.press('ArrowRight');
        scrolled = Number(await m.evaluate(`document.querySelector('[role="region"][aria-label="Usage records (scrolls sideways)"]').scrollLeft`));
      }
      const hint = await m.getByText('Scroll sideways to see every column.').count();
      check('Layout', 'mobile: the usage-records table is a named, focusable scroll region with a visible hint, and the keyboard scrolls it', found && hint === 1 && scrolled > 0, `region ${found}, hint ${hint}, scrolled ${scrolled}px`);
      await mobileCtx.close();
    }

    // ── Flows through the UI (desktop) ──
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop, locale: 'en-US' });
    const page = await ctx.newPage();
    await login(page, USERS.user1);

    const runs = (await api('GET', '/analytics/runs', token.user1)).data as { successful: number; failed: number };
    const section = (title: string) => page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) });
    const usage = section('Agent Usage');
    await usage.getByText('Failed Runs').waitFor();
    const cardValue = async (title: string) => (await usage.locator('div.bg-gradient-to-br', { hasText: title }).locator('p').nth(1).innerText()).trim();
    const shown = { successful: await cardValue('Successful Runs'), failed: await cardValue('Failed Runs') };
    check('Dashboard', 'Successful / Failed Runs cards show the API values', shown.successful === String(runs.successful) && shown.failed === String(runs.failed), `dashboard ${shown.successful}/${shown.failed}, API ${runs.successful}/${runs.failed}`);

    await page.getByRole('button', { name: 'CV PROCESSING', exact: true }).click();
    await section('Classification results').getByRole('article').first().waitFor({ timeout: 20_000 });
    await page.setInputFiles('#cv-files', { name: 'ui-single.txt', mimeType: 'text/plain', buffer: Buffer.from(`UI single upload. ${CV_TEXT}`) });
    await page.getByRole('button', { name: 'Classify CV', exact: true }).click();
    const card = page.getByRole('article').filter({ hasText: 'ui-single.txt' });
    await card.waitFor({ timeout: 30_000 });
    check('CV', 'a CV uploaded through the UI is classified and shows its category, confidence and evidence', (await card.innerText()).includes('Back-End Developer') && (await card.innerText()).includes('90% (0.90)') && (await card.innerText()).includes('building REST APIs in Go and PostgreSQL'));
    const ruleText = await card.getByText('Modify and Reject require a reason.').count();
    check('CV', 'the decision form states that Modify and Reject require a reason before anything is chosen', ruleText === 1);
    await card.getByRole('radio', { name: 'REJECT' }).click();
    await card.getByRole('button', { name: 'Submit decision' }).click();
    const reasonError = await card.getByText('A reason is required to reject a recommendation.').count();
    const reasonBox = card.getByRole('textbox', { name: /Reason/ });
    const described = await reasonBox.getAttribute('aria-describedby');
    check('CV', 'REJECT without a reason is refused in the UI, and the error is linked to the reason field', reasonError === 1 && (await reasonBox.getAttribute('aria-invalid')) === 'true' && !!described && (await page.locator(`#${described}`).innerText()).includes('A reason is required'), `aria-describedby=${described}`);
    await reasonBox.fill('Not a fit for the current openings.');
    await card.getByRole('button', { name: 'Submit decision' }).click();
    await card.getByText('Decision saved: REJECT').waitFor({ timeout: 10_000 });
    const results = (await api('GET', '/cv/results', token.user1)).data as Array<{ cvDocument?: { fileName?: string }; decisions: Array<{ decisionType: string; reason: string | null }> }>;
    const saved = results.find(r => r.cvDocument?.fileName === 'ui-single.txt')?.decisions[0];
    check('CV', 'the REJECT decision with its reason is stored (API)', saved?.decisionType === 'REJECT' && saved.reason === 'Not a fit for the current openings.');

    const recordToggle = card.getByRole('button', { name: 'ui-single.txt', exact: true });
    const recordDetails = card.locator('section[aria-label="Original AI recommendation"]');
    const openAfterUpload = (await recordToggle.getAttribute('aria-expanded')) === 'true' && (await recordDetails.isVisible());
    await recordToggle.click();
    const collapsedText = await card.innerText();
    const collapsedOk = (await recordToggle.getAttribute('aria-expanded')) === 'false' && !(await recordDetails.isVisible()) && collapsedText.includes('AI recommendation: Back-End Developer · Final: none (rejected)');
    await recordToggle.click();
    check('CV', 'a CV record opens after upload, collapses to its summary line and expands again', openAfterUpload && collapsedOk && (await recordDetails.isVisible()), collapsedText.split('\n').slice(0, 4).join(' / '));

    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    const scrolledBy = Number(await page.evaluate('window.scrollY'));
    const tabsTop = (await page.getByRole('navigation', { name: 'Dashboard sections' }).boundingBox())?.y ?? -1;
    check('Layout', 'the dashboard tabs stay at the top of the screen while scrolling', scrolledBy > 0 && Math.abs(tabsTop) < 1, `scrolled ${scrolledBy}px, tabs at y=${tabsTop}`);
    await page.evaluate('window.scrollTo(0, 0)');

    // Deleting is admin only: the regular user gets no Delete action; an admin deletes through the dialog.
    check('CV', 'a regular user sees no Delete action on CV records', (await page.getByRole('button', { name: /^Delete / }).count()) === 0);
    const adminCtx = await browser.newContext({ viewport: VIEWPORTS.desktop, locale: 'en-US' });
    const adminPage = await adminCtx.newPage();
    await login(adminPage, USERS.admin);
    await adminPage.getByRole('button', { name: 'CV PROCESSING', exact: true }).click();
    const adminCard = adminPage.getByRole('article').filter({ hasText: 'ui-single.txt' });
    await adminCard.getByRole('button', { name: 'Delete ui-single.txt' }).click();
    await adminPage.getByRole('dialog', { name: 'Delete this CV permanently?' }).getByRole('button', { name: 'Delete permanently' }).click();
    await adminCard.waitFor({ state: 'detached', timeout: 10_000 });
    await adminCtx.close();
    const afterDelete = (await api('GET', '/cv/results', token.user1)).data as Array<{ cvDocument?: { fileName?: string } }>;
    check('CV', "an admin deletes a user's CV through the confirmation dialog; it disappears from the list and the API", !afterDelete.some(r => r.cvDocument?.fileName === 'ui-single.txt'));

    await page.setInputFiles('#cv-files', [
      { name: 'ui-batch-ok.txt', mimeType: 'text/plain', buffer: Buffer.from(`UI batch ok. ${CV_TEXT}`) },
      { name: 'ui-batch-fails.txt', mimeType: 'text/plain', buffer: Buffer.from(`${FAIL} UI batch failing file. ${CV_TEXT}`) },
    ]);
    await page.getByRole('button', { name: 'Classify 2 CVs' }).click();
    const batch = section('Batch processing');
    await batch.getByText('Partially completed: 1 of 2 CVs classified, 1 failed.', { exact: false }).waitFor({ timeout: 30_000 });
    const batchText = await batch.innerText();
    check('Batch', 'a partial batch failure is reported as such, with a Failed badge and the reason next to the failed file', batchText.includes('Failed 1') && /ui-batch-fails\.txt[\s\S]*The AI provider request failed/.test(batchText) && batchText.includes('Completed'), batchText.split('\n').slice(0, 6).join(' / '));

    await page.getByRole('button', { name: 'SENTIMENT', exact: true }).click();
    await page.getByLabel('Feedback text').fill('Support answered quickly and the new reports are great.');
    await page.getByRole('button', { name: 'Analyze sentiment' }).click();
    const latest = page.getByRole('status', { name: 'Sentiment result' });
    await latest.waitFor({ timeout: 20_000 });
    const latestText = await latest.innerText();
    const sentiments = (await api('GET', '/sentiment/results', token.user1)).data as Array<{ id: number; sentiment: string; confidence: number }>;
    check('Sentiment', 'the sentiment result shown matches the stored result (API)', latestText.includes('Positive') && latestText.includes(`Result #${sentiments[0].id}`) && latestText.includes('90% (0.90)'));
    await page.getByRole('heading', { name: 'Your sentiment results' }).waitFor();
    check('Sentiment', 'a regular user sees no Delete action on sentiment results', (await page.getByRole('button', { name: /^Delete / }).count()) === 0);

    await page.getByRole('button', { name: 'Logout' }).click();
    await page.locator('#email').waitFor({ timeout: 10_000 });
    const storedAuth = await page.evaluate('localStorage.getItem("auth")');
    await page.reload();
    const stillLoggedOut = await page.locator('#email').isVisible();
    check('Login', 'logout returns to the login form, clears the stored session and stays logged out after reload', stillLoggedOut && (storedAuth === null || !String(storedAuth).includes('accessToken":"ey')), '');
    await ctx.close();

    const passed = checks.filter(c => c.pass).length;
    mkdirSync(dirname(RESULTS_JSON), { recursive: true });
    writeFileSync(RESULTS_JSON, JSON.stringify({ overall: passed === checks.length ? 'PASS' : 'FAIL', generatedAt: new Date().toISOString(), provider: 'CONTROLLED (no OpenAI calls)', browser: 'Google Chrome (headless, via playwright-core)', viewports: VIEWPORTS, checks }, null, 2) + '\n');
    console.log(`\nUI verification: ${passed === checks.length ? 'PASS' : 'FAIL'} - ${passed}/${checks.length} checks`);
    process.exitCode = passed === checks.length ? 0 : 1;
  } finally {
    if (browser) await browser.close();
    vite?.kill();
    server.close();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(`UI verification did not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
