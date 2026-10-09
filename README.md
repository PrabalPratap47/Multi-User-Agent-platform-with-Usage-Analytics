# Multi-User Agent Platform with Usage Analytics

A full-stack web application with two LLM agents: **CV Classification** and **Feedback Sentiment**.

- **Human review:** an Accept / Modify / Reject workflow for CV recommendations.
- **Usage logging:** per-call logging of real provider token usage, cost and latency.
- **Access control:** role-based access (Admin / User) with per-user data isolation.
- **Dashboard:** analytics built from database records, plus import of external agent logs.

## Contents

- [Verification status](#verification-status)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [OpenAI configuration and key safety](#openai-configuration-and-key-safety)
- [Demo accounts (local development only)](#demo-accounts-local-development-only)
- [Authentication, roles and data isolation](#authentication-roles-and-data-isolation)
- [The agents and the CV decision workflow](#the-agents-and-the-cv-decision-workflow)
- [Analytics](#analytics)
- [External agent logs](#external-agent-logs)
- [API endpoints](#api-endpoints)
- [Commands](#commands)
- [Tests and verification](#tests-and-verification)
- [Documentation index](#documentation-index)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

## Verification status

The evidence is recorded in the linked reports. "Last run" is the date the evidence was produced; later code changes are noted where they were not re-verified.

| Area | Status | Evidence (last run) | Caveat |
|---|---|---|---|
| Logging accuracy (raw provider usage = logged usage = dashboard) | VERIFIED, real OpenAI | [evaluation/logging-accuracy-report.md](evaluation/logging-accuracy-report.md) (2026-10-09, 6 calls) | — |
| Multi-user isolation and concurrency | VERIFIED, real OpenAI | [evaluation/multi-user-real-openai-report.md](evaluation/multi-user-real-openai-report.md) (2026-10-09, 72/72) | — |
| Security audit and prompt injection | VERIFIED | [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md); [evaluation/real-model-prompt-injection-report.md](evaluation/real-model-prompt-injection-report.md) (2026-10-08, 13/13 real-model cases) | Residual risks are listed in the audit |
| Full end-to-end | VERIFIED (after the run-count follow-up) | [evaluation/e2e-test-report.md](evaluation/e2e-test-report.md) (real OpenAI 2026-10-09: 367/368, plus the follow-up) | The real-OpenAI E2E runner was **not re-run** after the run-count follow-up, the Step 19 UI changes, or the Step 22 changes (usage-log failure reporting, agent runs listing) |
| UI/UX, accessibility, responsive layout | VERIFIED for the tested Chrome environments | [docs/UI_UX_REVIEW.md](docs/UI_UX_REVIEW.md) (2026-10-09, `verify:ui` 64/64; 72/72 after the AGENT RUNS tab was added in Step 22) | Headless Chrome at emulated widths only; no other browsers, physical devices or screen readers |
| Unit / integration test suite | 415/415 passing on 2026-10-10 (after Step 22 F-01–F-03, F-05–F-07, F-10, F-14 and F-23) | `cd backend && npm test` | Uses provider stubs only; no OpenAI calls |
| Documentation, fresh setup and documented workflows | See the report | [docs/DOCUMENTATION_REVIEW.md](docs/DOCUMENTATION_REVIEW.md) (2026-10-09: fresh-copy install, `db:setup`, 313/313 tests, startup, browser login, preview, Prisma Studio, PowerShell variants) | Not a literal `git clone`: the repository has no commits. Windows 10 / Node 24 / npm 12 only |

## Architecture

```
Browser ── React + Vite SPA (frontend/) ── HTTPS/JSON, Bearer token ──► Express API (backend/)
                                                                          ├── Auth, RBAC, validation (Zod)
                                                                          ├── Agents ──► OpenAI Chat Completions
                                                                          ├── Usage logging + analytics
                                                                          └── Prisma ──► SQLite (backend/data/*.db)
```

**Frontend** (`frontend/`, React 18, Vite, Tailwind, Zustand, Axios):

- The UI only. It knows the backend URL (`VITE_API_URL`) and the logged-in user's tokens; it holds no secrets.
- It never computes metrics: every number on the dashboard comes from the analytics API.
- It checks CV files before upload for convenience; the backend re-validates everything.

**Backend** (`backend/`, Node.js, Express 4, TypeScript, Prisma 6):

- Authentication and the role checks for every request.
- Both agents and the only OpenAI client (`src/services/llmService.ts`).
- Usage logging, analytics calculations (`src/services/analyticsService.ts`) and external log import.
- All data, in SQLite: `backend/data/dev.db` for development and `backend/data/test.db` for tests. See [docs/DATABASE.md](docs/DATABASE.md).

The repository is an npm workspace (`backend` + `frontend`). [ARCHITECTURE.md](ARCHITECTURE.md) is the original design proposal; its first section lists where the implementation differs.

## Prerequisites

- **Node.js 18.18 or newer** (required by Prisma 6) and npm. The verification runs listed above used Node.js 24.21.0 and npm 12.0.2 on Windows 10.
- **No database server.** SQLite files are created under `backend/data/`.
- **An OpenAI API key, only** for running the real agents and the real-OpenAI verification scripts. The test suite, the UI and the controlled browser checks need no key.
- **Google Chrome, only** for the browser checks (`verify:ui`, `verify:dashboard-run-outcomes`). They drive the installed Chrome through `playwright-core` and download no browser.

## Setup

Run from the repository root unless a step says otherwise. The blocks below are bash.

**Windows PowerShell 5.1** (the version built into Windows 10) has two differences:

- `cp` works there: it is an alias of `Copy-Item`.
- `&&` does **not**: it is a syntax error. Run `cd backend` and `npm run dev` as two separate commands, join them with `;`, or use PowerShell 7+.

```bash
# 1. Install both workspaces (also generates the Prisma Client)
npm install
#    npm 11+ may warn that install scripts of @prisma/*, prisma and esbuild were
#    "blocked". In the Step 20 fresh-copy test this was harmless: the workspace's own
#    postinstall still generated the Prisma Client. If it is missing:
#    cd backend && npm run db:generate

# 2. Backend environment files
cd backend
cp .env.example .env.local        # development -> data/dev.db
cp .env.test.example .env.test    # tests       -> data/test.db (no edits needed)
```

Edit `backend/.env.local`:

- `JWT_SECRET`: replace the placeholder with your own random value of 32+ characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The backend **refuses to start** while `JWT_SECRET` is missing, blank, shorter than 32 characters, or still a placeholder from the templates or docs. The value in `.env.test.example` is public and is accepted only by the test runner (`NODE_ENV=test`). Never reuse a secret from this repository, and use a different secret for any real deployment.
- `OPENAI_API_KEY`: your key, or leave it empty (see below).
- Leave `DATABASE_URL="file:../data/dev.db"` as it is.

```bash
# 3. Create the development database and seed demo data (still in backend/)
npm run db:setup          # = db:migrate:deploy + db:seed

# 4. Optional: run the test suite (uses its own data/test.db)
npm test
```

Start the servers in two terminals:

```bash
cd backend && npm run dev     # API on http://localhost:3001 (logs "Server running on ...")
cd frontend && npm run dev    # app on http://localhost:5173 (opens the browser)
```

- **Frontend environment (optional):** `cp frontend/.env.example frontend/.env.local` is needed only if the API is not at `http://localhost:3001`. It holds only `VITE_API_URL`.
- **Database created before 2026-10-08:** if your `backend/data/dev.db` predates that, run `npm run db:migrate:deploy` in `backend/` to apply the two later migrations.
- **Startup schema check.** Before serving requests, the backend compares the database's migration history with `backend/prisma/migrations/`. It refuses to start (`Refusing to start: …`, exit code 1) when:
  - a migration is pending;
  - the database is missing or not set up;
  - a migration failed;
  - the database has migrations this code doesn't know;
  - the migration state can't be read.

  The message names the migrations and the command to run, usually `cd backend && npm run db:migrate:deploy` (`npm run db:setup` for a new database). The check never applies or changes anything; back up `data/dev.db` first if its data matters.

All backend commands must run from `backend/`. Configuration is loaded from `.env.local` (or `.env.test` for tests) **in the current directory**. [SETUP.md](SETUP.md) has the step-by-step version and explains which command reads which env file.

## OpenAI configuration and key safety

| Variable (`backend/.env.local`) | Meaning |
|---|---|
| `OPENAI_API_KEY` | May be empty. The server still starts and logs a warning. Agent calls then fail with `OPENAI_API_KEY_MISSING` (HTTP 502 with a safe message, an `ERROR` usage row, and no request sent to OpenAI). |
| `OPENAI_MODEL` | Default `gpt-4o`. The single model used for every call. Costs are computed only for models in `backend/src/config/modelPricing.ts`: `gpt-4o` ($2.50 / $10.00 per 1M input/output tokens) and `gpt-4o-mini` ($0.15 / $0.60). Dated snapshots such as `gpt-4o-2024-08-06` use their base model's price. Other models are logged with cost "unknown" (`null`). |
| `AI_RATE_LIMIT_MAX_RUNS`, `AI_RATE_LIMIT_WINDOW_SECONDS` | Optional; defaults `60` and `600`. Per-user limit on AI runs started through the API (see "Rules" below). Positive integers; anything else stops startup with `Invalid environment variables`. |

**Rules:**

- **Where the key may live.** The key belongs only in `backend/.env.local`. Never put it in a `frontend/.env*` file: every `VITE_*` value is compiled into the JavaScript sent to the browser.
- **What git ignores.** `.gitignore` excludes `.env` and `.env.*` (except the `*.example` templates) and explicitly lists `backend/.env.local`. Never commit or paste the key anywhere.
- **Variables already set in the environment win over `.env.local`.** dotenv does not override them. If an `OPENAI_API_KEY` is set in your shell or OS user environment, it silently replaces the one in `.env.local`. This caused a real 401 during development. Remove it from the environment if you rely on `.env.local`.
- **Restart after editing.** Restart the backend after editing `.env.local`.
- **What the app never exposes.** The key is never logged or returned. Provider error messages are redacted (`sk-[REDACTED]`) before they are stored or shown. This is verified by the security tests and by the key scans recorded in the reports.

## Demo accounts (local development only)

`npm run db:seed` (also part of `db:setup`) creates these accounts, defined in `backend/src/db/seed.ts`:

| Email | Role | Password |
|---|---|---|
| admin@example.com | ADMIN | password123 |
| user1@example.com | USER | password123 |
| user2@example.com | USER | password123 |
| user3@example.com | USER | password123 |

- **Use them for local development only.** Never seed a shared or production database.
- **Running the seed deletes all existing rows first.**
- **Seed demo data is excluded from metrics.** The seed also creates a few demo CV/sentiment records. Their usage logs are flagged `isSeedData`, and analytics exclude them along with their runs, recommendations and decisions.
- **The login page lists these accounts only on the Vite dev server** (`import.meta.env.DEV`). A production build does not contain them; this was verified by scanning `frontend/dist` in Step 19.

## Authentication, roles and data isolation

Full detail is in [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

**Login and sessions**

- `POST /api/auth/login` returns a short-lived JWT access token (15 min, `JWT_EXPIRY_SECONDS`, HS256) and an opaque refresh token (7 days). The server stores only the refresh token's SHA-256 hash.
- **Identity comes from the server-side session, never from the request.** The access token carries a session id (`sid`). On every request `authenticateToken` loads that session and the user, **with their current role, from the database**. Logging out, a role change, or deleting the user therefore takes effect immediately.
- A user id in a request body or query string never changes who you are.
- Refresh tokens rotate on every use; reusing an old one is rejected.
- Wrong password and unknown email both return 400 with the same message. After 10 failed attempts for one email and IP within 15 minutes, login returns 429. The counter is kept in memory, so it resets when the backend restarts.
- **AI rate limit.** Requests that start AI work are limited per user: `POST /api/cv/classify`, `POST /api/cv/documents/:documentId/classify`, `POST /api/sentiment/analyze` and `POST /api/cv/batch`.
  - **Default:** 60 AI runs in any 10 minutes (a sliding window), for admins too. A batch costs one run per file. All four endpoints share one budget.
  - **Keying:** the budget belongs to the session user, so query parameters, headers, bodies and a second login don't change or reset it.
  - **Over the limit:** the API returns 429 `{ "success": false, "error": "Too many AI requests: ... Try again in N seconds.", "code": "TOO_MANY_REQUESTS", "details": { "retryAfterSeconds": N } }` with a `Retry-After: N` header. Nothing is created and no AI call is made.
  - **Refunds:** a request rejected with a 4xx (validation, not found, not yours) gives its runs back. A provider failure (502) does not.
  - **Not limited:** uploads without classification, results, batch status, runs, usage logs and analytics.
  - **Storage:** like the login counter, it is in memory, per process, and resets on restart. It is not shared between processes.

**Permissions**

| | Regular user | Admin |
|---|---|---|
| CV results, decisions, sentiment results, batches, agent runs, usage logs, imports | Own only. Another user's item by id → 403 | Everyone's |
| Analytics | Own data only; `?userId=` is ignored | Global, or one user's with `?userId=` |
| `GET /api/users`, `GET /api/analytics/by-user` | 403 | Allowed |
| Deciding on a CV recommendation | Own recommendations | Any (the decision is attributed to the admin; the CV stays with its owner) |

**Token storage.** The browser keeps the access and refresh tokens in `localStorage` (key `auth`). This is a recorded residual risk: an XSS bug would expose them (see the security audit).

## The agents and the CV decision workflow

Both agents share the same pattern:

1. One OpenAI call through `LLMService`.
2. The output is parsed and checked against a strict schema.
3. If it fails, there is exactly **one repair retry**.
4. If that also fails, the request fails safely: HTTP 502 with a fixed message. Raw model output is never returned.

Every call, including failures, writes one usage log row. User text is wrapped in an "untrusted data" block, and spoofed block markers are neutralised. See [docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md).

| | CV Classification Agent | Sentiment Analysis Agent |
|---|---|---|
| Input | `cvContent`: plain text, 10–50,000 characters (at least 10 after trimming, not binary); optional `fileName` | `text`: 1–5,000 characters |
| Output | `primaryCategory`, optional `secondaryCategories`, a `confidence` 0–1 for **every** category, and `rationale[]` with evidence quoted from the CV | `sentiment` (`positive` / `neutral` / `negative`, stored upper-case), `confidence` 0–1, `rationale` |
| Extra checks | Primary evidence must be grounded in the CV text; no leaked instructions or secret-like strings; evidence is sanitised | Rationale grounded in the feedback; leak check; sanitised |

The 9 categories are: PSS, DCS, Front-End Developer, Back-End Developer, Web Automation, Mobile Automation, AI Engineer, Chatbot Application Tester, Other.

**Decisions** (`POST /api/cv/results/:id/decision`):

- **ACCEPT** needs no reason; the final category is the recommendation's.
- **MODIFY** requires a reason (up to 2,000 characters) and must actually change the primary and/or secondary categories.
- **REJECT** requires a reason and has no final category.
- Decisions are **appended**. The original AI recommendation is never changed, and the history is returned newest first.

**Batch processing** of up to 20 CVs (at most 3 files, and so 3 AI calls, in flight per batch; the rest wait as Queued), with live progress and per-file partial failures, is described in [docs/BATCH_CV_PROCESSING.md](docs/BATCH_CV_PROCESSING.md).

## Analytics

Every metric is computed on the server, in `backend/src/services/analyticsService.ts`, from database records. The exact queries are in [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md).

**Excluded from every metric:**

- seed demo usage logs (`isSeedData`);
- the seed's demo runs, recommendations and decisions.

| Metric | Definition |
|---|---|
| Input / output / total tokens | Sums over `llm_usage_logs`, holding the provider's own `usage.prompt_tokens` / `completion_tokens`. A response without usage is logged as 0/0 with `MISSING_USAGE_DATA`, never estimated. |
| Estimated cost | Sum of each row's cost, computed when the call was logged from its tokens and the pricing table. Unpriced models contribute nothing. |
| Per user (admin only) / per agent | The same sums, grouped by user / by agent. |
| Run counts 24h / 7d / 30d | `agent_runs` started in each window. The windows overlap. |
| Successful / failed runs | All-time runs whose final `agent_runs.status` is `SUCCESS` / `ERROR`. Queued or running runs count toward neither. |
| Error rate per agent | `ERROR` usage rows ÷ all usage rows. This is **call-level**: a file rejected before any AI call is a failed run but not an error call. |
| Average latency per agent | Mean `latencyMs` of the usage rows, measured around each provider call. |
| CV acceptance rate | Per **original** recommended category: ACCEPT ÷ all decisions. MODIFY and REJECT are shown separately. |
| Time saved (**estimate**) | `max(0, completed CVs × 5 min − completed CVs × measured average CV-agent latency)`, in hours. The 5 minutes is an assumed manual-review baseline. |

`GET /api/analytics/evaluation` is a placeholder: it returns only a message. Evaluation results come from the CLI script below.

## External agent logs

Users import `.json` (array) or `.jsonl` log files from other agents, up to 2 MB:

- **Validation:** only `timestamp` and `agentName` are required. Each record is validated independently; invalid records are reported with their index and skipped.
- **Storage:** imported records live in their own tables and are **never mixed into internal analytics**. They get their own stats on the External Logs tab.
- **Access:** users see their own imports; admins see all.

Format and samples: [docs/EXTERNAL_LOG_FORMAT.md](docs/EXTERNAL_LOG_FORMAT.md), `docs/samples/`.

## API endpoints

All `/api/*` routes except login and refresh require `Authorization: Bearer <accessToken>`.

| Area | Endpoints |
|---|---|
| Health | `GET /health` → `{"status":"ok","message":"Server is healthy"}` |
| Auth | `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Users | `GET /api/users` (admin) |
| CV | `POST /api/cv/classify` (upload + classify), `POST /api/cv/documents`, `POST /api/cv/documents/:documentId/classify`, `POST /api/cv/batch` (202), `GET /api/cv/batch/:batchId/status`, `GET /api/cv/results`, `GET /api/cv/results/:id`, `POST /api/cv/results/:id/decision`, `GET /api/cv/results/:id/decisions` |
| Sentiment | `POST /api/sentiment/analyze`, `GET /api/sentiment/results`, `GET /api/sentiment/results/:id` |
| Usage logs | `GET /api/usage-logs` (own; all for admin), `GET /api/usage-logs/:userId` (self or admin, else 403) |
| Agent runs | `GET /api/runs` (own; all for admin, `?userId=` narrows an admin's view and is ignored for users; filters `agent`, `status`, `usage=incomplete`; `limit` 1–100, default 25; `offset`; returns `{ runs, total, limit, offset, agents }`), `GET /api/runs/:id` (owner or admin, else 403). Run metadata only: no CV/feedback text, prompts or tokens; provider failures are shown as a generic reason. Each run has `usageIssues` (`USAGE_UNKNOWN`, `COST_UNKNOWN`, `NO_USAGE_LOGGED`, `INTERRUPTED`; empty when its usage data is complete) |
| Analytics | `GET /api/analytics/summary` (alias `/tokens`), `/by-agent`, `/by-user` (admin), `/runs`, `/errors`, `/latency`, `/acceptance-rate`, `/time-saved`, `/usage-completeness` (whether the token/cost totals are complete; see [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md)), `/evaluation` (placeholder) |
| External logs | `POST /api/import/logs`, `GET /api/import/logs`, `GET /api/import/logs/:importId`, `GET /api/import/stats` |

Errors use the shape `{ "success": false, "error": "...", "code": "..." }`:

| Status | Meaning |
|---|---|
| 400 | Validation error (per-field details), malformed JSON or an invalid id |
| 401 / 403 | Not authenticated / not authorised |
| 404 | Not found |
| 413 | Body over 10 MB |
| 429 | Login throttled, or the per-user AI rate limit was reached (`Retry-After` header; see "Rules") |
| 502 | AI provider or model-output failure |
| 500 | Generic internal error (no internals exposed) |

## Commands

From the repository root: `npm run typecheck`, `npm run lint` and `npm run build` run in both workspaces.

**Backend** (`cd backend`):

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Dev server with reload / compile / run the compiled build |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:setup` | Create, migrate and seed `data/dev.db` |
| `npm run db:migrate:deploy` / `npm run db:seed` | Apply migrations / re-seed (deletes all rows) |
| `npm run db:migrate` | After editing `schema.prisma`: create a new migration (read the CHECK-constraint note in docs/DATABASE.md first) |
| `npm run db:studio` / `npm run db:generate` | Browse the dev DB / regenerate the Prisma Client |
| `npm run db:reset:test` | Delete and re-migrate `data/test.db` |

**Frontend** (`cd frontend`):

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm run preview` | Dev server (`:5173`) / production build to `dist/` / serve that build on `http://localhost:4173` |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

The frontend has no unit tests; its behaviour is covered by the browser checks below.

**Preview needs two settings:**

- **CORS.** The backend accepts only its `FRONTEND_URL` origin. Before logging in on the preview, set `FRONTEND_URL=http://localhost:4173` in `backend/.env.local` (or in the environment) and restart the backend. Otherwise every API call is blocked by CORS, and the login page shows "Could not reach the server".
- **API URL.** `VITE_API_URL` is fixed when the bundle is built, so set it **before** `npm run build`.

## Tests and verification

All run from `backend/`. "Controlled" means a scripted stand-in for OpenAI at the HTTP transport of the production adapter: it makes no network calls and invents no token counts.

| Command | Provider | Needs | Proves | Does not prove |
|---|---|---|---|---|
| `npm test` (415 tests, 25 files; filter by file name, e.g. `npm test -- security`) | Stubs, no OpenAI | `.env.test` | Auth, RBAC and isolation, validation, decisions, batch, analytics math, usage logging, import, prompt-injection handling, the security regressions | How the real model behaves |
| `npm run verify:ui` | Controlled, Chrome | Google Chrome | No page overflow, every control named, WCAG AA contrast on every tab for admin and a user at 1440/820/390/320 px; login error, logout, keyboard focus; CV, batch and sentiment flows in the UI | Other browsers, real devices, screen readers |
| `npm run verify:dashboard-run-outcomes` | Controlled, Chrome | Google Chrome | Successful/failed run counts: actions = database = API = rendered dashboard, with seed runs excluded | Real-model behaviour |
| `npm run verify:e2e-real-openai` | **Real OpenAI** (~23 calls, ≈ $0.09 last run) | API key | Full user/admin journeys, batch, concurrency, decisions, prompt injection, external logs, edge cases, usage logs = raw OpenAI usage = analytics | The rendered dashboard (that is covered by the browser checks) |
| `npm run verify:multi-user-real-openai` | **Real OpenAI** (~11 calls) | API key | Multi-user isolation and measured concurrency with real calls | — |
| `npm run verify:prompt-injection-real-openai` | **Real OpenAI** (~14 calls) | API key | Real-model responses to 13 injection cases, plus leak-detector controls | Attacks not in the set |
| `npm run audit:logging-accuracy` | **Real OpenAI** (~6 calls) | API key | Raw provider usage = logged usage = dashboard totals | — |
| `npm run eval:cv-classification` | **Real OpenAI** (27 calls) | API key, a seeded DB | Precision/recall per category on `evaluation/datasets/cv-classification-eval-v1.json` | Accuracy on real-world CVs (the dataset is small) |

**Databases.** Each `verify:*` and `audit:*` script recreates its own git-ignored database under `backend/data/`. `eval:cv-classification` writes into whatever `DATABASE_URL` points at, which is `dev.db` by default. To keep the dev data clean, give it a separate seeded database:

```bash
# bash (from backend/)
export DATABASE_URL="file:../data/cv-eval.db"
node ../node_modules/prisma/build/index.js migrate deploy && npm run db:seed && npm run eval:cv-classification
```

```powershell
# Windows PowerShell (from backend\)
$env:DATABASE_URL = "file:../data/cv-eval.db"
node ../node_modules/prisma/build/index.js migrate deploy; npm run db:seed; npm run eval:cv-classification
Remove-Item Env:\DATABASE_URL
```

**Reports.** Results are written to `evaluation/`. Real-OpenAI scripts cost money: run them only when you need fresh evidence.

[backend/TESTING.md](backend/TESTING.md) has the details, including the test-database safety guard.

## Documentation index

| Document | Contents |
|---|---|
| [SETUP.md](SETUP.md), [QUICK_START.md](QUICK_START.md) | Step-by-step and short setup |
| [backend/TESTING.md](backend/TESTING.md) | Test suite, test database, verification commands |
| [docs/DATABASE.md](docs/DATABASE.md) | Data model, SQLite details, migrations, seed |
| [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md) | Every metric's exact definition |
| [docs/USAGE_LOGGING.md](docs/USAGE_LOGGING.md) | How each LLM call is logged and costed |
| [docs/BATCH_CV_PROCESSING.md](docs/BATCH_CV_PROCESSING.md) | Batch upload, progress, partial failures |
| [docs/EXTERNAL_LOG_FORMAT.md](docs/EXTERNAL_LOG_FORMAT.md) | External log import format |
| [docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md) | Prompt-injection threat model and defences |
| [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md), [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md) | Security audit and fixes; `npm audit` findings |
| [docs/MULTI_USER_DEMO.md](docs/MULTI_USER_DEMO.md) | How to demonstrate multi-user isolation |
| [docs/UI_UX_REVIEW.md](docs/UI_UX_REVIEW.md) | Accessibility and responsive review |
| [docs/DOCUMENTATION_REVIEW.md](docs/DOCUMENTATION_REVIEW.md) | Documentation review and fresh-setup verification (Step 20) |
| [evaluation/](evaluation/) | Generated reports, including [e2e-test-report.md](evaluation/e2e-test-report.md) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Original design proposal (see its implementation notes) |
| [docs/archive/PROJECT_SUMMARY.md](docs/archive/PROJECT_SUMMARY.md) | **Historical** scaffolding snapshot from 2026-10-06 (what existed and what was still planned); superseded by this README |

## Known limitations

- **Real-OpenAI E2E not re-run.** The real-OpenAI E2E runner was last run before the run-count follow-up and the Step 19 UI changes. Those changes were verified with the test suite and the controlled browser checks instead.
- **UI coverage.**
  - Tested only in headless Chrome at emulated widths: no Firefox/Safari, physical devices or screen readers.
  - The decision radio group and the tab bar have no arrow-key navigation (Tab works).
  - On phones, tables scroll sideways.
  - There are no charts.
- **Tokens in the browser.** Access and refresh tokens are kept in `localStorage`, so an XSS bug would expose them.
- **SQLite.** One writer at a time; suited to local and academic use.
- **Plain-text CVs only.** No PDF/DOCX text extraction.
- **Batches and restarts.** Work in progress is not resumed after a backend restart. At the next start, before accepting requests, the backend marks runs left queued or running as failed, with a reason saying they were interrupted (no usage rows are invented). Users must resubmit them. This assumes one backend process per database. See [docs/BATCH_CV_PROCESSING.md](docs/BATCH_CV_PROCESSING.md).
- **Evaluation.** `GET /api/analytics/evaluation` is a placeholder. The CV evaluation dataset is small (27 samples), so its perfect score on 2026-10-09 is weak evidence of real-world accuracy.
- **Dependencies.** `npm audit` reports 22 findings, all in development and CLI tooling. Re-checked 2026-10-09, see [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md).
- **Deployment.** There is no Docker or deployment configuration and no production deployment guide.
- **Uncommitted browser checks.** Some browser checks used during development (the CV-screen and sentiment-screen tests and the all-metrics dashboard comparison) are not committed; the committed ones are `verify:ui` and `verify:dashboard-run-outcomes`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `The table main.users does not exist` | Run `npm run db:setup` in `backend/` |
| `Refusing to start: The database data/dev.db is behind the code: …` (or a column such as `providerResponseId` is missing) | Your `dev.db` predates a migration. Back it up if needed, then run `npm run db:migrate:deploy` in `backend/` |
| `Refusing to start: The database … does not exist` / `has no migration history` | Create it with `npm run db:setup` in `backend/` |
| `Refusing to start: … failed or unfinished migration` / `… migrations that this code does not have` / `Could not read the migration history` | Resolve the failed migration (Prisma `migrate resolve`), use code that matches the database, or check that `DATABASE_URL` points at a readable SQLite file. The server will not start until the state can be verified. |
| `Invalid environment variables` at startup | Fix the listed variable in `backend/.env.local`. For `JWT_SECRET` (missing, blank, under 32 characters, or a template placeholder), generate your own with the `node -e "...randomBytes(32)..."` command above. The message never prints the value. |
| Agent calls fail with `OPENAI_API_KEY_MISSING` or HTTP 401 | Set `OPENAI_API_KEY` in `backend/.env.local`, check that no other `OPENAI_API_KEY` is set in your environment, and restart the backend |
| CORS errors, or "Could not reach the server" on login while the backend is running | `FRONTEND_URL` in `backend/.env.local` must match the frontend origin: `http://localhost:5173` for `npm run dev`, `http://localhost:4173` for `npm run preview`. Restart the backend after changing it. |
| `The token '&&' is not a valid statement separator` | Windows PowerShell 5.1: run the two commands separately, or join them with `;` |
| Port already in use | Backend: `BACKEND_PORT` in `backend/.env.local`. Frontend: `server.port` in `frontend/vite.config.ts` (then set `FRONTEND_URL` to match) |
| `Refusing to use the test database` | Tests only run against `backend/data/test.db`: re-copy `backend/.env.test.example` to `backend/.env.test` |

## License

MIT
