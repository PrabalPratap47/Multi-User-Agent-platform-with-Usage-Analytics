# Multi-User Agent Platform with Usage Analytics

A full-stack web application where several authenticated users run three LLM agents, every model call is logged with the provider's real token usage, and dashboards report the results.

- **Agents:** CV Classification (with generated CV feedback), Sentiment Analysis, and CV Skills Extraction & Gap Analysis.
- **Human review:** Accept / Modify / Reject for CV recommendations; the original AI output is kept unchanged.
- **CV input:** `.txt` and text-based `.pdf`, singly or in batches of up to 20 with live progress.
- **Usage logging:** provider token counts, cost, latency and status for every call.
- **Access control:** Admin / User roles with server-side data isolation; admin user management.
- **Dashboard:** server-computed analytics and charts, plus import of external agent logs.

**Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md) is the canonical description of the implementation (components, auth, agents, database, logging, security, decisions). This README covers setup, usage and verification.

## Contents

- [Verification status](#verification-status)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [OpenAI configuration and key safety](#openai-configuration-and-key-safety)
- [Demo accounts (local development only)](#demo-accounts-local-development-only)
- [Features at a glance](#features-at-a-glance)
- [Authentication, roles and analytics](#authentication-roles-and-analytics)
- [API endpoints](#api-endpoints)
- [Commands](#commands)
- [Tests and verification](#tests-and-verification)
- [Documentation index](#documentation-index)
- [Known limitations](#known-limitations)
- [Security considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

## Verification status

"Last run" is the date the evidence was produced. Evidence produced before a later change does not cover that change.

| Area | Evidence (last run) | Status and caveats |
|---|---|---|
| Logging accuracy (raw provider usage = logged usage = dashboard) | [evaluation/logging-accuracy-report.md](evaluation/logging-accuracy-report.md) (2026-10-09, real OpenAI, 6 calls) | PASS |
| Multi-user isolation and concurrency | [evaluation/multi-user-real-openai-report.md](evaluation/multi-user-real-openai-report.md) (2026-10-09, real OpenAI, 72/72) | PASS |
| Prompt injection against the real model | [evaluation/real-model-prompt-injection-report.md](evaluation/real-model-prompt-injection-report.md) (2026-10-08, 13/13 cases) | PASS for those cases; a sample, not a guarantee |
| Security audit | [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) (2026-10-08, 105/105 rows) | Predates user management, deletions, PDF upload and the Skills Gap agent; those have their own tests |
| Full end-to-end, real OpenAI | [evaluation/e2e-test-report.md](evaluation/e2e-test-report.md) (2026-10-09, 367/368 plus a follow-up) | Not re-run since; later changes were verified with stub providers |
| CV classification precision / recall | [evaluation/cv-classification-report.md](evaluation/cv-classification-report.md) (2026-10-09, 27 samples) | 1.00 for every category; the dataset is small. Predates CV feedback |
| UI regression (`npm run verify:ui`) | `evaluation/ui-verification-results.json` (2026-10-11, 85/85, Chrome, controlled provider) | Headless Chrome at emulated widths only |
| Successful/failed run counts (`verify:dashboard-run-outcomes`) | `evaluation/dashboard-run-outcomes-results.json` (2026-10-09, 44/44) | — |
| Backend test suite (`npm test`) | 37 test files, stub providers only | 539/539 on 2026-10-12 (full run) |
| Skills Gap agent | `backend/tests/skillsGap*.test.ts` (stub provider) | **Never run against the real model** |

## Technology stack

| Layer | Technologies |
|---|---|
| Backend | Node.js, TypeScript, Express 4, Zod (validation), Winston (logging), `pdfjs-dist` (PDF text extraction) |
| AI | OpenAI Chat Completions through the official `openai` SDK (default model `gpt-4o`), called only from the backend |
| Database | SQLite through Prisma ORM 6 (schema and migrations in `backend/prisma/`) |
| Auth | JWT access tokens (`jsonwebtoken`, HS256), opaque refresh tokens stored as SHA-256 hashes, `bcryptjs` password hashing |
| Frontend | React 18, Vite 5, TypeScript, Tailwind CSS 3, Recharts (charts), Zustand (state), Axios, lucide-react (icons) |
| Testing | Vitest and Supertest (backend); `playwright-core` driving the installed Google Chrome for the browser checks |
| Tooling | npm workspaces (`backend`, `frontend`), ESLint, Prettier |

## Project structure

```text
.
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma                   # data model (SQLite)
│   │   ├── migrations/                     # SQLite migrations applied by Prisma
│   │   └── migrations_postgresql_archive/  # archived, never applied (see docs/DATABASE.md)
│   ├── src/
│   │   ├── agents/          # CV Classification, Sentiment, Skills Gap agents (prompts, schemas, output guards)
│   │   ├── config/          # environment validation, logger, model pricing
│   │   ├── controllers/     # HTTP handlers
│   │   ├── db/              # Prisma client, seed, test-database guard, startup migration check
│   │   ├── evaluation/      # verification / evaluation scripts (npm run verify:*, audit:*, eval:*)
│   │   ├── externalLogs/    # external agent log import
│   │   ├── middleware/      # auth, RBAC, rate limiting, error handling
│   │   ├── routes/          # Express routers
│   │   ├── services/        # business logic, LLM adapter, usage logging, analytics
│   │   ├── types/ utils/
│   │   ├── app.ts           # Express app
│   │   └── server.ts        # entry point
│   ├── tests/               # Vitest suites and fixtures (stub providers, no network)
│   ├── data/                # SQLite files are created here (git-ignored)
│   ├── .env.example         # template -> .env.local (development)
│   └── .env.test.example    # template -> .env.test (tests)
├── frontend/
│   ├── src/
│   │   ├── components/      # tabs, analytics, charts, CV, sentiment, skills gap, admin users
│   │   ├── hooks/ services/ store/ types/ utils/
│   │   └── App.tsx, main.tsx
│   ├── .env.example         # template -> .env.local (VITE_API_URL only)
│   └── vite.config.ts
├── docs/                    # analytics, database, logging, security and demo documentation; sample log files
├── evaluation/              # evaluation dataset (synthetic CVs) and generated verification reports
├── ARCHITECTURE.md          # canonical architecture description
├── SETUP.md, QUICK_START.md
└── package.json             # npm workspaces root
```

## Prerequisites

- **Node.js 18.18 or newer** (required by Prisma 6) and npm. Verified on Windows 10 with Node.js 24 and npm 12.
- **No database server.** SQLite files are created under `backend/data/`.
- **An OpenAI API key, only** for the real agents and the real-OpenAI verification scripts. The test suite, the UI and the controlled browser checks need no key.
- **Google Chrome, only** for the browser checks (`verify:ui`, `verify:dashboard-run-outcomes`). They drive the installed Chrome through `playwright-core`.

## Setup

Run from the repository root unless a step says otherwise. The blocks are bash. In **Windows PowerShell 5.1**, `cp` works (alias of `Copy-Item`) but `&&` does not: run the commands separately or join them with `;`.

```bash
# 0. Clone
git clone https://github.com/PrabalPratap47/Multi-User-Agent-platform-with-Usage-Analytics.git
cd Multi-User-Agent-platform-with-Usage-Analytics

# 1. Install both workspaces (also generates the Prisma Client)
npm install

# 2. Backend environment files
cd backend
cp .env.example .env.local        # development -> data/dev.db
cp .env.test.example .env.test    # tests       -> data/test.db (no edits needed)
```

Edit `backend/.env.local`:

- `JWT_SECRET`: your own random value of 32+ characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The backend **refuses to start** while it is missing, short or a placeholder from the templates or docs.
- `OPENAI_API_KEY`: your key, or leave it empty (agent calls then fail safely).
- Leave `DATABASE_URL="file:../data/dev.db"` as it is.

```bash
# 3. Database (still in backend/)
npm run db:setup            # NEW database only: migrate + seed demo data
# or, for an EXISTING database whose data you want to keep:
#   back up data/dev.db, then
npm run db:migrate:deploy   # applies pending migrations, deletes nothing

# 4. Optional: run the test suite (uses its own data/test.db)
npm test
```

> **Data safety.** `npm run db:setup` and `npm run db:seed` **delete every row** in the target database before inserting the demo data, including accounts created in Admin → Users. Never run them against a database you need. Use `db:migrate:deploy` to bring an existing database up to date.

Start the servers in two terminals:

```bash
cd backend && npm run dev     # API on http://localhost:3001 (logs "Server running on ...")
cd frontend && npm run dev    # app on http://localhost:5173 (opens the browser)
```

- **Frontend environment (optional):** `cp frontend/.env.example frontend/.env.local` only if the API is not at `http://localhost:3001`. It holds only `VITE_API_URL`.
- **Startup schema check.** The backend refuses to start (`Refusing to start: …`) while a migration is pending, the database is missing or not set up, a migration failed, the database has migrations this code doesn't know, or the state can't be read. The message names the command to run. The check never changes anything.

All backend commands run from `backend/` and read `.env.local` (or `.env.test` for tests) from the current directory. [SETUP.md](SETUP.md) has the step-by-step version.

## OpenAI configuration and key safety

| Variable (`backend/.env.local`) | Meaning |
|---|---|
| `OPENAI_API_KEY` | May be empty: the server starts with a warning, and agent calls fail with `OPENAI_API_KEY_MISSING` (HTTP 502, an `ERROR` usage row, no request sent). |
| `OPENAI_MODEL` | Default `gpt-4o`, used for every call. Costs are computed for `gpt-4o` ($2.50 / $10.00 per 1M input/output tokens) and `gpt-4o-mini` ($0.15 / $0.60), including their dated snapshots (`backend/src/config/modelPricing.ts`). Other models are logged with cost "unknown". |
| `AI_RATE_LIMIT_MAX_RUNS`, `AI_RATE_LIMIT_WINDOW_SECONDS` | Optional; defaults `60` and `600`. Per-user limit on AI runs (see below). |

- **Where the key may live:** only `backend/.env.local`. Never in a `frontend/.env*` file: every `VITE_*` value is compiled into the browser JavaScript.
- **What git ignores:** `.env` and `.env.*` (except the `*.example` templates), explicitly `backend/.env.local`, and all `*.db` / `*.db.backup` files.
- **Environment variables win over `.env.local`.** An `OPENAI_API_KEY` set in your shell or OS environment silently replaces the file's value (this caused a real 401 during development).
- **Restart the backend after editing `.env.local`.**
- **Never exposed:** the key is never logged or returned; provider error text is redacted (`sk-[REDACTED]`).

## Demo accounts (local development only)

`npm run db:seed` (also part of `db:setup`) creates these accounts, defined in `backend/src/db/seed.ts`:

| Email | Role | Password |
|---|---|---|
| admin@example.com | ADMIN | password123 |
| user1@example.com | USER | password123 |
| user2@example.com | USER | password123 |
| user3@example.com | USER | password123 |

- **Local development and demos only.** Never seed a shared or production database; the seed deletes all existing rows first.
- **Passwords may differ in your database.** An admin can change any password in Admin → Users; the seed is the only place the demo password is set.
- **First admin.** The seed is the only built-in way to create the first admin; there is no sign-up or first-run setup (see [ARCHITECTURE.md §B](ARCHITECTURE.md#initial-admin-provisioning-limitation)).
- **Demo data is excluded from metrics.** The seed's demo CV and sentiment records have usage logs flagged `isSeedData`, and analytics exclude them along with their runs, recommendations and decisions.
- **The login page lists these accounts only on the Vite dev server** (`import.meta.env.DEV`); a production build does not contain them.

## Features at a glance

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).

| Tab | What it does |
|---|---|
| ANALYTICS | Server-computed totals (tokens, estimated cost, estimated time saved), runs 24h/7d/30d and successful/failed, token consumption by agent (and by user for admins), error rate and latency by agent, a decision outcomes doughnut (accepted / modified / rejected), CV acceptance rate per category, and an "incomplete totals" notice when usage data is missing |
| MY RECORDS | Usage-log rows (own; all users for admins), newest first, 25 per page |
| AGENT RUNS | Runs with status, filters and details; "Usage incomplete" badges; runs of deleted users are not shown |
| CV PROCESSING | Upload and classify `.txt`/`.pdf` CVs (single or batch), see category, confidences, evidence and feedback, decide Accept/Modify/Reject, treemap of final decisions; admins can delete CVs |
| SENTIMENT | Analyse feedback text; sentiment breakdown doughnut; admins can delete results |
| SKILLS GAP ANALYSIS | Compare a CV with a target role and get a learning plan ([docs/SKILLS_GAP_AGENT.md](docs/SKILLS_GAP_AGENT.md)); admins can delete saved analyses |
| EXTERNAL LOGS | Import `.json`/`.jsonl` logs from another agent and view their separate statistics |
| ADMIN USERS (admin) | Token usage per active user (bar chart; deleted users are not shown); create users, change passwords, delete (deactivate) users |

**Roles in one line:** users see and act on their own data only; admins see everyone's, manage users and are the only role that can delete anything. Identity always comes from the server-side session, never from a user id in the request.

## Authentication, roles and analytics

**Authentication.** Users sign in with email and password; passwords are stored as bcrypt hashes. There is no self sign-up: accounts come from the seed or are created by an admin.

- **Access token:** a JWT signed with HS256 using `JWT_SECRET`, valid for `JWT_EXPIRY_SECONDS` (default 15 minutes), sent as `Authorization: Bearer <token>`. Every request also checks that the token's login session still exists, is not revoked or expired, and belongs to an active account, so logout and account deletion (deactivation) take effect immediately. The role is read from the database on each request, not from the token.
- **Refresh token:** an opaque random value valid for `REFRESH_TOKEN_EXPIRY_SECONDS` (default 7 days). Only its SHA-256 hash is stored. Each refresh revokes the used token and issues a new one; logout revokes the session.
- **Login throttling:** repeated failures for the same IP and email are locked out for 15 minutes (in memory).

**Roles.**

| Role | Can do |
|---|---|
| `USER` | Run the agents, decide on their own CV recommendations, and see only their own runs, results, usage logs and analytics |
| `ADMIN` | Everything a user can, across all users; see per-user token usage; create users, change passwords, delete (deactivate) users; delete CVs, sentiment results and skills-gap analyses |

Ownership checks happen on the server for every resource; a user id in the URL, query or body never decides who is asking.

**Analytics.** Every LLM call writes a usage-log row with the provider's reported input/output tokens, the model, latency, status and an estimated cost from `backend/src/config/modelPricing.ts`. The dashboard's figures (token totals and cost, runs by period, success/failure counts, error rate and latency per agent, decision outcomes, CV acceptance rate per category, estimated time saved) are computed by the backend from those rows, scoped to the caller's own data unless the caller is an admin. Seeded demo records are excluded. Exact definitions: [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md); logging details: [docs/USAGE_LOGGING.md](docs/USAGE_LOGGING.md).

**AI rate limit:** `POST /api/cv/classify`, `POST /api/cv/documents/:documentId/classify`, `POST /api/cv/batch` (one run per file), `POST /api/sentiment/analyze` and `POST /api/skills-gap/analyze` share a per-user budget (default 60 runs per 10 minutes, sliding window, admins included). Over the limit: 429 with `Retry-After`, nothing created and no AI call. A 4xx rejection refunds its runs; a provider failure (502) does not. The counter is in memory and resets on restart.

## API endpoints

All `/api/*` routes except login and refresh require `Authorization: Bearer <accessToken>`.

| Area | Endpoints |
|---|---|
| Health | `GET /health` → `{"status":"ok","message":"Server is healthy"}` |
| Auth | `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Users (admin) | `GET /api/users`, `POST /api/users`, `PUT /api/users/:id/password`, `DELETE /api/users/:id` (soft delete) |
| CV | `POST /api/cv/classify` (text or PDF; upload + classify), `POST /api/cv/documents`, `POST /api/cv/documents/:documentId/classify`, `DELETE /api/cv/documents/:documentId` (admin), `POST /api/cv/batch` (202), `GET /api/cv/batch/:batchId/status`, `GET /api/cv/results`, `GET /api/cv/results/:id`, `POST /api/cv/results/:id/decision`, `GET /api/cv/results/:id/decisions` |
| Sentiment | `POST /api/sentiment/analyze`, `GET /api/sentiment/results`, `GET /api/sentiment/results/:id`, `DELETE /api/sentiment/results/:id` (admin) |
| Skills gap | `GET /api/skills-gap/roles`, `POST /api/skills-gap/analyze`, `GET /api/skills-gap/analyses`, `GET /api/skills-gap/analyses/:id`, `DELETE /api/skills-gap/analyses/:id` (admin) |
| Usage logs | `GET /api/usage-logs` (own; all for admin, `?userId=` for admins; newest first; optional `limit` 1–500 and `offset`, default the newest 500; `meta: { total, limit, offset }`), `GET /api/usage-logs/:userId` (self or admin, else 403) |
| Agent runs | `GET /api/runs` (own; all for admin; `?userId=` for admins, `agent`, `status`, `usage=incomplete`, `limit` 1–100, `offset`), `GET /api/runs/:id` (owner or admin). Runs of deleted (deactivated) users are left out of the list and read as 404. Run metadata only: no CV/feedback text, prompts or tokens |
| Analytics | `GET /api/analytics/summary` (alias `/tokens`), `/by-agent`, `/by-user` (admin), `/runs`, `/errors`, `/latency`, `/acceptance-rate`, `/final-categories`, `/time-saved`, `/usage-completeness`, `/evaluation` (placeholder, returns only a message). Definitions: [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md) |
| External logs | `POST /api/import/logs`, `GET /api/import/logs`, `GET /api/import/logs/:importId`, `GET /api/import/stats` |

Errors use `{ "success": false, "error": "...", "code": "..." }`: 400 validation (per-field details), malformed JSON or invalid id; 401 / 403 not authenticated / not authorised; 404 not found; 409 conflict (duplicate email, last admin, CV still processing); 413 body over 10 MB; 429 login throttled or AI rate limit; 502 AI provider or model-output failure; 500 generic internal error.

## Commands

From the repository root: `npm run typecheck`, `npm run lint` and `npm run build` run in both workspaces.

**Backend** (`cd backend`):

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Dev server with reload / compile / run the compiled build |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:setup` | **New database only:** migrate and seed `data/dev.db` (deletes all rows) |
| `npm run db:migrate:deploy` | Apply pending migrations; keeps data (back up first) |
| `npm run db:seed` | Re-seed: **deletes all rows**, then inserts the demo data |
| `npm run db:migrate` | After editing `schema.prisma`: create a new migration (read the CHECK-constraint note in docs/DATABASE.md first) |
| `npm run db:studio` / `npm run db:generate` | Browse the dev database / regenerate the Prisma Client |
| `npm run db:reset:test` | Delete and re-migrate `data/test.db` |

**Frontend** (`cd frontend`): `npm run dev` (`:5173`), `npm run build` (to `dist/`), `npm run preview` (`http://localhost:4173`), `npm run typecheck`, `npm run lint`. The frontend has no unit tests; the browser checks cover it.

**Preview** needs `FRONTEND_URL=http://localhost:4173` in `backend/.env.local` (restart the backend), because the backend accepts only that one CORS origin. `VITE_API_URL` is fixed at build time, so set it before `npm run build`.

## Tests and verification

All run from `backend/`. "Controlled" means a scripted stand-in for OpenAI at the HTTP transport of the production adapter: no network calls and no invented token counts.

| Command | Provider | Needs | Proves | Does not prove |
|---|---|---|---|---|
| `npm test` (37 files; one file: `npm test -- adminUsers`) | Stubs, no OpenAI | `.env.test` | Auth, RBAC and isolation, user management, validation, decisions, deletions, batch, PDF extraction, analytics math, usage logging, import, prompt-injection handling, security regressions | How the real model behaves |
| `npm run verify:ui` | Controlled, Chrome | Google Chrome | No page overflow, named controls, WCAG AA contrast on every tab for admin and a user at 1440/820/390/320 px; login, logout, focus; CV, batch and sentiment flows | Other browsers, real devices, screen readers |
| `npm run verify:dashboard-run-outcomes` | Controlled, Chrome | Google Chrome | Successful/failed run counts: actions = database = API = rendered dashboard | Real-model behaviour |
| `npm run verify:e2e-real-openai` | **Real OpenAI** (~23 calls, ≈ $0.09 last run) | API key | Full user/admin journeys, batch, concurrency, decisions, prompt injection, external logs, usage logs = raw OpenAI usage = analytics | The rendered dashboard; the Skills Gap agent |
| `npm run verify:multi-user-real-openai` | **Real OpenAI** (~11 calls) | API key | Multi-user isolation and measured concurrency | — |
| `npm run verify:prompt-injection-real-openai` | **Real OpenAI** (~14 calls) | API key | Real-model responses to 13 injection cases | Attacks not in the set |
| `npm run audit:logging-accuracy` | **Real OpenAI** (~6 calls) | API key | Raw provider usage = logged usage = dashboard totals | — |
| `npm run eval:cv-classification` | **Real OpenAI** (27 calls) | API key, a seeded database | Precision/recall per category on `evaluation/datasets/cv-classification-eval-v1.json` | Accuracy on real-world CVs |

**Databases.** Each `verify:*` and `audit:*` script recreates its own git-ignored database under `backend/data/`. `eval:cv-classification` writes into whatever `DATABASE_URL` points at (`dev.db` by default) and needs the seeded admin. Give it a separate database so the seed does not wipe your development data:

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

Results are written to `evaluation/`. Real-OpenAI scripts cost money: run them only when you need fresh evidence. [backend/TESTING.md](backend/TESTING.md) has the details, including the test-database safety guard.

## Documentation index

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **Canonical architecture:** components, auth, agents, CV processing, database, logging, analytics, security, deployment, decisions, assignment metrics |
| [SETUP.md](SETUP.md), [QUICK_START.md](QUICK_START.md) | Step-by-step and short setup |
| [backend/TESTING.md](backend/TESTING.md) | Test suite, test database, verification commands |
| [docs/DATABASE.md](docs/DATABASE.md) | Data model, SQLite details, migrations, seed, retention |
| [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md) | Every metric's exact definition |
| [docs/USAGE_LOGGING.md](docs/USAGE_LOGGING.md) | How each LLM call is logged and costed |
| [docs/BATCH_CV_PROCESSING.md](docs/BATCH_CV_PROCESSING.md) | Upload formats, batch processing, progress, restart recovery |
| [docs/SKILLS_GAP_AGENT.md](docs/SKILLS_GAP_AGENT.md) | The Skills Extraction & Gap Analysis agent |
| [docs/EXTERNAL_LOG_FORMAT.md](docs/EXTERNAL_LOG_FORMAT.md) | External log import format; samples in `docs/samples/` |
| [docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md) | Prompt-injection threat model and defences |
| [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) | Live demo on a separate demo database (PowerShell) |
| [docs/MULTI_USER_DEMO.md](docs/MULTI_USER_DEMO.md) | Demonstrating multi-user isolation (verification script, browser, API) |
| [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md), [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md) | Security audit (2026-10-08); `npm audit` findings (re-checked 2026-10-11) |
| [docs/FINAL_COMPLIANCE_AUDIT.md](docs/FINAL_COMPLIANCE_AUDIT.md) | Requirements traceability (2026-10-09/10) |
| [docs/UI_UX_REVIEW.md](docs/UI_UX_REVIEW.md), [docs/DOCUMENTATION_REVIEW.md](docs/DOCUMENTATION_REVIEW.md) | Historical step reports: accessibility review (2026-10-09), fresh-setup verification (2026-10-09) |
| [evaluation/](evaluation/) | Evaluation dataset and generated reports, including [e2e-test-report.md](evaluation/e2e-test-report.md) |

## Known limitations

- **Real-model evidence is dated.** The real-OpenAI runs date from 2026-10-08/09 and were not repeated after the rate limit, run listing, PDF upload, CV feedback, Skills Gap agent, deletions or user management. The Skills Gap agent has never run against the real model.
- **First admin.** Only the destructive development seed creates the first admin; there is no safe production provisioning path.
- **Tokens in the browser.** Access and refresh tokens are in `localStorage`, so an XSS bug would expose them; no Content-Security-Policy is set.
- **In-memory limits.** Login throttling and the AI rate limit reset on restart and are per process.
- **SQLite.** One writer at a time; suited to local and academic use.
- **CV formats.** `.txt` and text-based `.pdf` only: no OCR for scanned PDFs, no DOCX.
- **Restarts.** Work in progress is not resumed: at the next start, queued or running runs are marked failed with a reason and must be resubmitted. One backend process per database is assumed.
- **Evaluation.** `GET /api/analytics/evaluation` is a placeholder. The CV evaluation set is 27 samples, so its perfect score is weak evidence of real-world accuracy. Time saved is an estimate based on an assumed 5-minute manual review.
- **UI coverage.** Headless Chrome at emulated widths only; no arrow-key navigation in the tab bar and decision radio group; wide tables scroll sideways on phones.
- **Dependencies.** `npm audit` reports 22 findings, all in development or CLI tooling ([docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md)).
- **Deployment.** No Docker, CI or deployment configuration, and no production deployment guide.

## Security considerations

- **Secrets stay on your machine.** `OPENAI_API_KEY` and `JWT_SECRET` belong only in `backend/.env.local`, which git ignores. The committed `*.example` templates contain placeholders only. The backend refuses to start with a missing, short or placeholder `JWT_SECRET`.
- **The OpenAI key never reaches the browser.** All model calls go through the backend; frontend env files hold only `VITE_API_URL`, and key-shaped text in provider errors is redacted before logging.
- **Databases are local and git-ignored.** `backend/data/*.db` (and backups) contain password hashes, refresh-token hashes, uploaded CV text and usage history. Never commit them or share them; recreate a database from the migrations instead.
- **CV and feedback text is sent to OpenAI.** Anything you upload or analyse is sent to the configured OpenAI model. Use synthetic or consented data.
- **Demo credentials are public.** The seeded accounts use `password123` and exist for local demos only. Change or remove them before any shared use, and never run the seed against a database you need.
- **Prompt injection.** CV and feedback text is treated as untrusted data, model output is validated against a schema and checked for leaked secrets or system-prompt text ([docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md)); this lowers the risk but is not a guarantee.
- **Browser storage and missing CSP.** Tokens are in `localStorage` and no Content-Security-Policy is set (see [Known limitations](#known-limitations)).
- **Before you push:** run `git status` and make sure no `.env*` file other than the `*.example` templates, no `*.db` file and no archive (`*.zip`) is staged.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Refusing to start: The database data/dev.db is behind the code: …` (or a missing column) | Back up `data/dev.db`, then run `npm run db:migrate:deploy` in `backend/` |
| `Refusing to start: The database … does not exist` / `has no migration history` / `The table main.users does not exist` | New database: run `npm run db:setup` in `backend/` |
| `Refusing to start: … failed or unfinished migration` / `… migrations that this code does not have` / `Could not read the migration history` | Resolve the failed migration (Prisma `migrate resolve`), use code that matches the database, or check that `DATABASE_URL` points at a readable SQLite file |
| `Invalid environment variables` at startup | Fix the listed variable in `backend/.env.local`; for `JWT_SECRET`, generate your own as shown above. The message never prints the value |
| Agent calls fail with `OPENAI_API_KEY_MISSING` or HTTP 401 | Set `OPENAI_API_KEY` in `backend/.env.local`, check that no other `OPENAI_API_KEY` is set in your environment, restart the backend |
| CORS errors, or "Could not reach the server" on login | `FRONTEND_URL` in `backend/.env.local` must match the frontend origin (`http://localhost:5173` for dev, `http://localhost:4173` for preview); restart the backend |
| Demo login fails with "Invalid email or password" | The password may have been changed in Admin → Users, or the account deactivated. Ask an admin to reset it; do not re-seed a database whose data you need |
| `The token '&&' is not a valid statement separator` | Windows PowerShell 5.1: run the commands separately, or join them with `;` |
| Port already in use | Backend: `BACKEND_PORT` in `backend/.env.local`. Frontend: `server.port` in `frontend/vite.config.ts` (then set `FRONTEND_URL` to match) |
| `Refusing to use the test database` | Tests only run against `backend/data/test.db`: re-copy `backend/.env.test.example` to `backend/.env.test` |

## License

MIT
