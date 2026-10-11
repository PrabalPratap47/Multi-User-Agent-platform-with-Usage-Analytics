# Architecture: Multi-User Agent Platform with Usage Analytics

**Status:** describes the implementation as of 2026-10-11, checked against the source code, Prisma schema, migrations and `package.json` scripts on that date. Where this document and the code disagree, the code wins.

This file replaces the original design proposal of 2026-10-06, which was written before implementation and is kept in git history (initial commit). Topic documents in [`docs/`](docs/) hold the details; this document links to them rather than repeating them.

## Contents

- [A. System overview](#a-system-overview)
- [B. Authentication and authorization](#b-authentication-and-authorization)
- [C. Agent architecture](#c-agent-architecture)
- [D. CV processing and decisions](#d-cv-processing-and-decisions)
- [E. Database architecture](#e-database-architecture)
- [F. Usage logging and analytics](#f-usage-logging-and-analytics)
- [G. External logs](#g-external-logs)
- [H. Security and known limitations](#h-security-and-known-limitations)
- [I. Development and deployment](#i-development-and-deployment)
- [J. Architecture decisions](#j-architecture-decisions)
- [Assignment requirements and evaluation metrics](#assignment-requirements-and-evaluation-metrics)

---

## A. System overview

### Purpose

Several authenticated users run AI agents on their own data. Every model call is logged with the provider's real token usage, cost and latency, and dashboards report those records. Admins see everyone's data; users see only their own.

| Capability | Where |
|---|---|
| **CV Classification Agent**: classifies a CV (`.txt` or text-based `.pdf`) into 9 categories with per-category confidence, quoted evidence and 2–4 sentences of feedback | CV PROCESSING tab |
| **Human review**: Accept / Modify / Reject each recommendation; the original AI output is never overwritten | CV PROCESSING tab |
| **Batch processing** of up to 20 CVs with live progress and per-file failures | CV PROCESSING tab |
| **Sentiment Analysis Agent**: positive / neutral / negative, confidence, rationale | SENTIMENT tab |
| **CV Skills Extraction & Gap Analysis Agent**: compares a CV with one of 8 target roles and writes a learning plan | SKILLS GAP ANALYSIS tab |
| **Usage logging** of every provider call (tokens, cost, latency, status) | `llm_usage_logs` table |
| **Analytics**: token, cost, run, error-rate, latency, acceptance-rate and time-saved metrics, user-scoped | ANALYTICS tab, MY RECORDS, AGENT RUNS |
| **External agent logs**: import `.json`/`.jsonl` logs of another agent, analysed separately | EXTERNAL LOGS tab |
| **Admin user management**: create users, change passwords, delete (deactivate) users; admin-only deletion of CVs, sentiment results and saved skills-gap analyses | ADMIN USERS tab and per-record actions |

### Technologies

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 5, Tailwind CSS 3, Zustand (auth store), Axios, Recharts (charts) |
| Backend | Node.js (≥ 18.18), Express 4, TypeScript (ESM), Zod (validation), Winston (logging), `jsonwebtoken`, `bcryptjs`, official `openai` SDK, `pdfjs-dist` (PDF text extraction) |
| Database | SQLite through Prisma 6 (`prisma` / `@prisma/client` 6.19.x) |
| Tests | Vitest + Supertest against the real app and a real SQLite test database; browser checks drive installed Google Chrome through `playwright-core` |

The repository is an npm workspace with two packages, `backend/` and `frontend/`.

### Components

```
Browser
  └─ React SPA (frontend/, Vite)                      holds only VITE_API_URL and the user's tokens
       │  JSON over HTTP, Authorization: Bearer <access token>
       ▼
Express API (backend/src/app.ts, routes/ → controllers/ → services/)
  ├─ middleware/authMiddleware.ts   authenticateToken, requireUser, requireAdmin, requireSelfOrAdmin
  ├─ middleware/aiRateLimit.ts      per-user limit on AI-starting endpoints
  ├─ agents/                        CVClassificationAgent, SentimentAgent, SkillsGapAgent (+ schemas, prompts, guards)
  ├─ services/llmService.ts         the only OpenAI client; logs every call through usageLogService.ts
  ├─ services/analyticsService.ts   every dashboard metric
  ├─ externalLogs/ + services/externalAgentLogService.ts   external log import, kept separate
  └─ db/client.ts (Prisma) ──► SQLite file (backend/data/dev.db by default)
                                     ▲
OpenAI Chat Completions API ◄────────┘ (called only by llmService.ts)
```

- **Request path.** Each route file applies `authenticateToken` (and a role guard where needed). The controller validates input with Zod (`utils/validators.ts`) and calls a service. Services own authorization checks on single records, database access and agent calls. `middleware/errorHandler.ts` maps errors to `{ success: false, error, code }` without stack traces or internals.
- **Startup** (`src/server.ts`): (1) a read-only check that the database has exactly the checked-in migrations (refuses to start otherwise); (2) recovery of runs a previous process left `PENDING`/`RUNNING` (marked `ERROR` with a reason, never resumed); (3) listen on `BACKEND_PORT` (default 3001).

### Frontend–backend communication

- `frontend/src/services/api.ts` is a single Axios instance with base URL `VITE_API_URL` (default `http://localhost:3001`). A request interceptor adds `Authorization: Bearer <accessToken>`. On a 401 it calls `POST /api/auth/refresh` once (shared by concurrent requests), then replays the request; if refresh fails, the user is logged out.
- CORS allows exactly one origin, `FRONTEND_URL` (default `http://localhost:5173`).
- Request bodies are JSON (limit 10 MB). File uploads are JSON too: `.txt` content as text, `.pdf` as base64 (see [D](#d-cv-processing-and-decisions)).
- **Where numbers are computed.** Every ANALYTICS-tab number comes from `/api/analytics/*`, computed on the server. Two small summaries are counted in the browser from lists the API already returned and scoped: the treemap of final decisions on CV PROCESSING and the sentiment breakdown doughnut on SENTIMENT. The admin token-usage bar chart (ADMIN USERS) plots `GET /api/analytics/by-user`.

Dashboard tabs: ANALYTICS, MY RECORDS, AGENT RUNS, CV PROCESSING, SENTIMENT, SKILLS GAP ANALYSIS, EXTERNAL LOGS, and ADMIN USERS for admins only (`frontend/src/components/Dashboard.tsx`).

---

## B. Authentication and authorization

Code: `services/authService.ts`, `middleware/authMiddleware.ts`, `routes/auth.ts`, `services/usersService.ts`. Detailed test evidence: [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md), [backend/TESTING.md](backend/TESTING.md).

### Login and sessions

- `POST /api/auth/login` with `{ email, password }` checks the bcrypt hash. Wrong password, unknown email and deactivated account all return 400 "Invalid email or password". After 10 failures for one email from one IP within 15 minutes, login returns 429 (in-memory counter, per process).
- On success the server creates a **session**: a `refresh_tokens` row holding only the SHA-256 hash of an opaque random refresh token (default lifetime `REFRESH_TOKEN_EXPIRY_SECONDS` = 7 days). It returns:
  - an **access token**: a JWT signed HS256 with `JWT_SECRET`, lifetime `JWT_EXPIRY_SECONDS` (default 900 s), carrying the user id, email, role and `sid` (the session row id);
  - the refresh token itself.
- `POST /api/auth/refresh` (refresh token in the body) rotates: the old session is revoked and a new one issued; reusing an old refresh token fails.
- `POST /api/auth/logout` revokes the session. `GET /api/auth/me` returns the current user.
- The browser stores both tokens in `localStorage` (key `auth`, `frontend/src/store/authStore.ts`). This is a recorded residual risk (see [H](#h-security-and-known-limitations)).

### How identity is determined

`authenticateToken` verifies the JWT signature (HS256 only), then `AuthService.resolveSession` loads the session named by `sid` and the user **from the database on every request**. The request is rejected (401) unless the session exists, is unrevoked and unexpired, belongs to that user, and the user is not deactivated. `req.user` (id, email, **current** role) and `req.sessionId` come from that lookup, never from the token's role claim or from the request.

Consequences: logout, refresh rotation, a role change or a deactivation take effect on the next request. A `userId` in a body, query string or header never changes who the caller is.

### Roles and enforcement

Two roles, `ADMIN` and `USER` (Prisma enum; lower-case at the API boundary).

| | Regular user | Admin |
|---|---|---|
| CV documents, recommendations, decisions, batches, sentiment results, skills-gap analyses, agent runs, usage logs, external-log imports | Own only; another user's record by id → 403 | Everyone's |
| Analytics | Own data; `?userId=` is ignored | Global, or one user's with `?userId=` |
| Decide on a CV recommendation | Own recommendations | Any (the decision is attributed to the admin) |
| `GET /api/analytics/by-user`, all of `/api/users` | 403 | Allowed |
| `DELETE` CV document, sentiment result, skills-gap analysis | 403 (even for their own records) | Allowed |

Enforcement is on the server at two levels: route guards (`requireUser`, `requireAdmin`, `requireSelfOrAdmin` for `GET /api/usage-logs/:userId`) and ownership/role checks inside each service before any data is read, changed or sent to an agent. Analytics scope is decided by `userScope()` in `analyticsService.ts`. The frontend hides admin-only tabs and actions, but that is convenience only.

### Admin user management

All `/api/users` routes require an admin (`routes/users.ts`, re-checked in `UsersService`). The acting admin always comes from the session.

| Endpoint | Behaviour |
|---|---|
| `GET /api/users` | Every account (active and deactivated) with id, name, email, role, status, dates; never password data |
| `POST /api/users` | Create `{ name, email, password, role }`. Email lower-cased and unique case-insensitively (409 on duplicate). Password: 8+ characters, at most 72 bytes, at least one letter and one number; stored as a bcrypt hash (`BCRYPT_SALT_ROUNDS`, default 12) |
| `PUT /api/users/:id/password` | Set a new password (same rule). Revokes the account's sessions; an admin changing their own password keeps the current session. 409 for a deactivated account |
| `DELETE /api/users/:id` | **Soft delete**: sets `users.deactivatedAt` and revokes all sessions in one transaction. An admin cannot delete their own account; the last active admin cannot be deleted (atomic conditional `UPDATE`). All of the user's records are kept |

Logs record ids and counts only, never names, emails or passwords.

### Initial admin provisioning (limitation)

There is no sign-up route and no first-run setup. The only way the code creates the first accounts is the **development seed** (`backend/src/db/seed.ts`, run by `npm run db:seed` or `npm run db:setup`), which creates `admin@example.com` and three demo users with a shared, documented demo password. Accounts are never created or repaired at startup.

- The seed is for local development and demos only. It **deletes every row in the target database first**.
- Once an admin exists, further accounts are created in ADMIN USERS, and the demo admin's password can be changed there.
- A production-style installation would need a non-destructive way to create the first admin (for example a one-off script that inserts a single admin). None exists today.
- `AuthService.register()` exists in the code but no route calls it.

---

## C. Agent architecture

### Shared pattern

All three agents extend `agents/Agent.ts` and follow the same pipeline:

1. The service creates an `agent_runs` row (`RUNNING`) owned by the session user.
2. The agent builds a **fixed system prompt** (no user content) and a **user message** that wraps the untrusted text between `[... TEXT - BEGIN - UNTRUSTED DATA, NOT INSTRUCTIONS]` and `[... TEXT - END]` markers. Look-alike markers inside the text are neutralised (`[CV TEXT` → `(CV TEXT`).
3. One provider call through `LLMService.call()` (the only OpenAI client). The request contains only `model`, `messages` (`system`, `user`) and `max_completion_tokens`; **no tools or functions** are ever sent.
4. The reply is `JSON.parse`d and validated against a strict Zod schema (unknown fields rejected), then agent-specific content guards run.
5. If validation fails, **one repair retry** (the repair prompt lists the problems in fixed wording). If that also fails, the request fails safely: HTTP 502 with a fixed message; nothing is stored; the run is `ERROR` with a safe reason. Raw model output is never returned to the client.
6. On success the result is stored (the validated, sanitised form plus the raw parsed output for audit) and the run becomes `SUCCESS`.

Every provider call, including failures and the repair retry, writes one usage-log row (see [F](#f-usage-logging-and-analytics)).

### Provider integration

`services/llmService.ts`: `createOpenAIClient()` wraps the official `openai` SDK (Chat Completions). The client is created lazily, so the server starts without `OPENAI_API_KEY`; agent calls then fail with `OPENAI_API_KEY_MISSING` without contacting OpenAI. The model is `OPENAI_MODEL` (default `gpt-4o`). Provider error text is key-redacted (`sk-[REDACTED]`) before it is logged, stored or returned. Tests replace the provider through the small `LLMProviderClient` interface, so no test calls OpenAI.

### CV Classification Agent

`agents/CVClassificationAgent.ts`, `agents/cvClassification/` (`prompt.ts`, `schema.ts`, `cvClassificationResponse.schema.json`, `outputGuard.ts`, `feedback.ts`, `categoryDefinitions.ts`).

| | |
|---|---|
| Input | CV text, 10–50,000 characters (at least 10 after trimming, not binary), from `.txt` or extracted from a `.pdf`; optional file name |
| Output (strict JSON) | `primaryCategory`; `secondaryCategories[]` (no duplicates, not the primary); `confidence` with a 0–1 score for **each** of the 9 categories (primary must be highest or tied); `rationale[]` of `{ category, evidence }` including the primary; `feedback` (2–4 complete sentences, ≤ 1,200 characters) |
| Content guards | Primary evidence must share vocabulary with the CV (`isPrimaryRationaleGrounded`); feedback must share at least 2 significant words with the CV, ignoring instruction-like CV sentences (`isFeedbackGrounded`); no system-prompt fragments or key-shaped strings (`detectLeakage`); markup and control characters stripped from evidence and feedback |
| Stored | `cv_recommendations` (immutable original recommendation, incl. `feedback` and `rawResponse`) |

Categories: PSS (Passenger Service System), DCS (Departure Control System), Front-End Developer, Back-End Developer, Web Automation, Mobile Automation, AI Engineer, Chatbot Application Tester, Other.

### Sentiment Analysis Agent

`agents/SentimentAgent.ts`, `agents/sentiment/` (`prompt.ts`, `schema.ts`, `sentimentResponse.schema.json`, `outputGuard.ts`).

| | |
|---|---|
| Input | Feedback text, 1–5,000 characters |
| Output (strict JSON) | `sentiment` (`positive` / `neutral` / `negative`), `confidence` 0–1, `rationale` |
| Guards | Rationale grounded in the feedback text; leak check; sanitised |
| Stored | `sentiment_results` (label stored upper-case) |

### CV Skills Extraction & Gap Analysis Agent

`agents/SkillsGapAgent.ts`, `agents/skillsGap/` (`roles.ts`, `prompt.ts`, `schema.ts`, `skillsGapResponse.schema.json`, `outputGuard.ts`). Full contract: [docs/SKILLS_GAP_AGENT.md](docs/SKILLS_GAP_AGENT.md).

- **Input:** a target role (one of 8 fixed role ids in `roles.ts`, never free text) and a CV as text or a base64 PDF (same rules and extraction as classification).
- **Output:** demonstrated, partially demonstrated and not-demonstrated skills for that role (each configured skill exactly once), gap priorities matching the configured importance, a staged learning roadmap and an approximate preparation time. Output budget 4,096 tokens.
- **Guards:** evidence strings must come from the CV (at least half of their significant words occur in it); leak check; sanitised, then validated again.
- **Stored:** `skills_gap_analyses` (result and raw output; the CV text itself is not stored, only its file name and length). Independent of CV classification and decisions.
- The agent's `agents` row is created on first use (upsert); the seed does not create it.
- **Not verified against the real model:** no paid run has been made for this agent.

### Prompt-injection defences

Threat model, the 12 defence points and their tests: [docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md). Summary: role separation (fixed system prompt that takes no parameters), delimited untrusted data with neutralised markers, explicit security instructions, strict schemas, content grounding and leak checks, output sanitisation, no tool access, and a human decision step for CV results. The content checks are heuristics; their known limitations are documented there.

---

## D. CV processing and decisions

Details: [docs/BATCH_CV_PROCESSING.md](docs/BATCH_CV_PROCESSING.md).

### Upload formats and extraction

| Format | Handling |
|---|---|
| `.txt` (`text/plain`) | Sent as text. Rejected if under 10 characters after trimming, over 50,000, or more than 5% control characters (binary such as a renamed PDF/DOCX) |
| `.pdf` (`application/pdf`) | Sent base64-encoded. `utils/pdfText.ts` extracts text with PDF.js in a worker thread: ≤ 2 MB, PDF signature required, ≤ 50 pages, 15 s timeout, worker memory limits; encrypted, damaged and text-less (scanned) PDFs are refused with a specific reason. The extracted text then gets the `.txt` checks, and only the text is stored |
| Anything else (DOCX, images, …) | Refused. There is no OCR and no DOCX support |

The browser pre-checks files (type, size, signature, 9 MB per request) for faster feedback; the server re-validates everything.

### Single and batch processing

- `POST /api/cv/classify` uploads and classifies one CV (`cvContent` or `pdfBase64`). `POST /api/cv/documents` stores a CV without classifying it; `POST /api/cv/documents/:documentId/classify` classifies a stored CV.
- `POST /api/cv/batch` accepts 1–20 files and returns 202 with a `batchId` at once. Each file becomes its own document and `PENDING` run; at most 3 files per batch are processed concurrently. Per-file failures never fail the batch.
- `GET /api/cv/batch/:batchId/status` reads the run rows live: queued, processing, completed, failed, percentage, and per-file state and reason. The UI polls it every 1.5 s.
- Runs left unfinished by a backend restart are failed with a reason at the next startup; nothing is resumed or retried automatically.

### Decisions

`POST /api/cv/results/:id/decision` (`services/cvDecisionService.ts`):

| Decision | Reason | Final category |
|---|---|---|
| `ACCEPT` | Optional | The recommendation's, computed by the server |
| `MODIFY` | Required (≤ 2,000 characters) | The user's choice; must differ from the original |
| `REJECT` | Required | None |

Decisions are **append-only** rows in `recommendation_decisions`, linked to the recommendation, CV document and run, with the deciding user and a timestamp. The original recommendation is never changed; `GET /api/cv/results/:id/decisions` returns the history newest first, and the latest decision is the current one. The reason and final-category rules are enforced by Zod and by database CHECK constraints.

### Deletion

Admin only (`DELETE /api/cv/documents/:documentId`): permanently deletes the CV text, its recommendations and their decisions in one transaction; refused with 409 while the CV is still being processed. Its agent runs (unlinked) and usage logs are kept, so token, cost and run history stay exact.

---

## E. Database architecture

Details, SQLite specifics and migration notes: [docs/DATABASE.md](docs/DATABASE.md).

### Files and `DATABASE_URL`

| Use | File | Selected by |
|---|---|---|
| Development | `backend/data/dev.db` | `DATABASE_URL="file:../data/dev.db"` in `backend/.env.local` |
| Tests | `backend/data/test.db` | `backend/.env.test` (the test guard refuses any other file) |
| Demo rehearsal (optional) | `backend/data/demo.db` | `DATABASE_URL` set in the shell ([docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md)) |
| Verification scripts | `backend/data/ui-verify.db`, `e2e-real.db`, … | Each `verify:*`/`audit:*` script creates its own |

Relative `file:` paths resolve against `backend/prisma/`. `src/config/env.ts` loads `.env.test` when `NODE_ENV=test`, otherwise `.env.local`; variables already in the environment take precedence. `src/db/client.ts` passes the resolved absolute path to Prisma so the app and the Prisma CLI open the same file, and refuses to use `test.db` outside tests. All `*.db` files and `*.db.backup` files are git-ignored.

### Models

12 Prisma models (`backend/prisma/schema.prisma`):

| Table | Holds |
|---|---|
| `users` | Accounts: email (unique), bcrypt password hash, role, optional `name`, `deactivatedAt` |
| `refresh_tokens` | Sessions: SHA-256 token hash, expiry, `revokedAt` |
| `agents` | Registered agents (unique name) |
| `agent_runs` | One row per agent invocation (UUID id): user, agent, status `PENDING/RUNNING/SUCCESS/ERROR`, optional `batchId`, `cvDocumentId`, safe `errorMessage` |
| `llm_usage_logs` | One row per provider call (see [F](#f-usage-logging-and-analytics)) |
| `cv_documents` | Uploaded CV text (extracted text for PDFs), optional batch id |
| `cv_recommendations` | The original AI recommendation (written once) |
| `recommendation_decisions` | Append-only human decisions |
| `sentiment_results` | Sentiment outputs |
| `skills_gap_analyses` | Skills-gap outputs |
| `external_agent_logs`, `external_agent_log_records` | Imported external logs (one row per file, one per valid record) |

```
users 1─* refresh_tokens
users 1─* agent_runs 1─* llm_usage_logs
users 1─* cv_documents 1─* cv_recommendations 1─* recommendation_decisions
agent_runs 1─0..1 cv_recommendations | sentiment_results | skills_gap_analyses
agent_runs *─0..1 cv_documents            (cvDocumentId, SET NULL on delete)
users 1─* external_agent_logs 1─* external_agent_log_records
```

Every per-user table references `users` with `ON DELETE CASCADE`, which is why users are only ever deactivated. Runs are referenced with `SET NULL`, so deleting a result never deletes its usage history.

### Migrations and initialization

Six additive migrations in `backend/prisma/migrations/` (SQLite baseline 2026-10-07; CV-document link and run error message; provider response id; skills-gap table; CV feedback column; user name and deactivation). The hand-written CHECK constraints in the baseline must be preserved by any future migration (see docs/DATABASE.md). `backend/prisma/migrations_postgresql_archive/` holds the earlier PostgreSQL history for reference only; Prisma never reads it.

- **New database:** `npm run db:setup` = `db:migrate:deploy` (creates the file, applies migrations) + `db:seed`.
- **Existing database:** `npm run db:migrate:deploy` only, after a backup. It never deletes data.
- The server refuses to start while a migration is pending or the state cannot be verified, and never migrates by itself.

### Demo versus real data

`db:seed` deletes all rows, then creates the 2 original agent registrations, 4 demo users and a few demo runs, recommendations, decisions and a sentiment result. Their usage-log rows have `isSeedData = true`; analytics exclude those rows and the runs, recommendations and decisions they identify. No application code path sets `isSeedData`. Real provider records are therefore never mixed with seeded ones in any metric.

### Retention and deletion

| Action | Removed | Kept |
|---|---|---|
| Admin deletes a user | Nothing (soft delete); sessions revoked | Everything, including the email (stays reserved) |
| Admin deletes a CV document | CV text, its recommendations and decisions | Agent runs (unlinked), usage logs |
| Admin deletes a sentiment result / skills-gap analysis | That result | Its agent run and usage logs |
| `npm run db:seed` / `db:setup` | **Every row in the target database** | Nothing |

There is no automatic expiry of data. Regular users cannot delete anything.

---

## F. Usage logging and analytics

Details: [docs/USAGE_LOGGING.md](docs/USAGE_LOGGING.md) and [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md).

### What is logged

`LLMService.call()` measures latency around each provider call and hands the result to `UsageLogService.logCall()`, which writes one `llm_usage_logs` row:

| Field | Source |
|---|---|
| `timestamp`, `createdAt` | Call time |
| `userId` | The authenticated caller (from the service context, never the client) |
| `agentId`, `agentName` | The agent (name snapshotted at write time) |
| `runId` | The run the call belongs to |
| `model` | The model the provider reports |
| `inputTokens`, `outputTokens` | `usage.prompt_tokens`, `usage.completion_tokens` from the provider response, never estimated |
| `latencyMs` | Measured around the provider call |
| `status` | `SUCCESS` or `ERROR` (provider call outcome) |
| `estimatedCost` | Tokens × `config/modelPricing.ts` price (`gpt-4o`, `gpt-4o-mini`; dated snapshots priced at their base model); `null` for unpriced models |
| `errorCode`, `errorMessage` | e.g. `HTTP_401`, `OPENAI_API_KEY_MISSING`, `MISSING_USAGE_DATA` (key-redacted text) |
| `providerResponseId` | The provider's response id, for audit matching |
| `isSeedData` | `false` for every real call |

**Missing usage:** a successful response without a complete `usage` object is logged with 0/0 tokens and `errorCode = MISSING_USAGE_DATA`, never with an estimate. A failed call is logged as `ERROR` with 0 tokens. If the row itself cannot be written, the call's result is still returned (it was already billed), the failure is reported as a `USAGE_LOG_WRITE_FAILED` server-log event, and nothing is fabricated.

### Metrics

All metrics are computed in `services/analyticsService.ts` from the database, scoped by `userScope()` (own data for users; global or `?userId=` for admins), with seed data excluded:

| Metric | Endpoint | Definition |
|---|---|---|
| Input / output / total tokens, estimated cost | `/api/analytics/summary` (alias `/tokens`) | Sums over `llm_usage_logs` |
| By user (admin) / by agent | `/by-user`, `/by-agent` | Same sums grouped |
| Runs in 24 h / 7 d / 30 d; successful / failed runs | `/runs` | `agent_runs` counts; outcomes from final status |
| Error rate by agent | `/errors` | `ERROR` calls ÷ all calls (call level) |
| Average latency by agent | `/latency` | Mean `latencyMs` |
| CV acceptance rate per category | `/acceptance-rate` | ACCEPT ÷ all decisions, by **original** category |
| Original vs final category | `/final-categories` | Each decided CV counted once by its latest decision |
| Time saved (**estimate**) | `/time-saved` | `max(0, completed CVs × 5 min − completed CVs × measured average CV-agent latency)` in hours; the 5-minute manual baseline is an assumption and the response says `methodology: "ESTIMATED"` |
| Usage completeness | `/usage-completeness` | Counts calls with unknown usage or cost, successful runs without a usage row, interrupted runs |

`GET /api/analytics/evaluation` is a placeholder that returns only a message; evaluation metrics come from CLI scripts (see [Assignment requirements](#assignment-requirements-and-evaluation-metrics)).

**Limitations:** totals are recorded usage only (calls with missing usage or unknown cost lower them, and the dashboard says so); cached-input discounts are not modelled, so costs can be slightly overstated; the error rate is call-level, so a file rejected before any AI call is a failed run but not an error call.

---

## G. External logs

Details: [docs/EXTERNAL_LOG_FORMAT.md](docs/EXTERNAL_LOG_FORMAT.md).

- **Import:** `POST /api/import/logs` with `{ sourceAgentName, fileName, format: "json" | "jsonl", content, notes? }`, content up to 2 MB. `.json` is a top-level array of records; `.jsonl` is one object per line.
- **Record fields:** only `timestamp` (parseable date) and `agentName` are required; `userId` (the external system's own id), `model`, `inputTokens`, `outputTokens`, `latencyMs`, `status`, `estimatedCost` are optional; unknown fields are kept in `rawRecord`. `status` is normalised to `isError` by a documented heuristic, and the original string is kept.
- **Partial import:** each record is validated independently. Invalid records are skipped and reported with their index and reason (`parseErrors`); valid ones are stored.
- **Storage and separation:** `external_agent_logs` (one row per file, with counts and errors) and `external_agent_log_records`. `AnalyticsService` never reads these tables; the EXTERNAL LOGS tab has its own statistics endpoint (`GET /api/import/stats`). Users see their own imports, admins all.
- **Samples:** [`docs/samples/external-agent-logs-valid.json`](docs/samples/external-agent-logs-valid.json) (all valid) and [`docs/samples/external-agent-logs-mixed.jsonl`](docs/samples/external-agent-logs-mixed.jsonl) (valid and malformed records, to show partial import). In EXTERNAL LOGS, enter a source agent name, choose a sample file and import.

---

## H. Security and known limitations

Evidence: [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) (2026-10-08), [docs/PROMPT_INJECTION_SECURITY.md](docs/PROMPT_INJECTION_SECURITY.md), [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md).

| Control | Implementation |
|---|---|
| Password storage | bcrypt (`BCRYPT_SALT_ROUNDS`, default 12; the seed hashes its demo password with cost 10) |
| Session protection | HS256 JWT bound to a server-side, revocable session; refresh-token rotation with replay rejection; only token hashes stored; login throttling |
| Secret configuration | `JWT_SECRET` must be 32+ characters and not a published placeholder, or the backend refuses to start. `OPENAI_API_KEY` lives only in git-ignored `backend/.env.local`; never logged or returned; provider errors key-redacted |
| Authorization boundaries | Route guards plus service-level ownership checks; identity only from the session; admin-only user management and deletions |
| Cross-user isolation | Every list and record read scoped to the caller; other users' records → 403 with no data and no AI call |
| Prompt injection | Role separation, delimited untrusted data, neutralised markers, no tools, strict schemas, grounding and leak checks, sanitisation |
| Structured output | Strict Zod schemas (documented JSON Schemas kept in sync by tests for the CV and skills-gap agents), one repair retry, fail closed |
| File uploads | JSON-only uploads, never written to disk; type, size, signature, page, timeout and binary-content checks; file names stored as data, control characters refused |
| Errors and logs | Generic 500 messages; malformed JSON → 400 and oversized bodies → 413 without echoing the body; logs carry ids and counts, never passwords, tokens, keys or CV text |
| Database access | Prisma query builder; the few raw queries (case-insensitive email check, atomic deactivation, migration-history read) are parameterised tagged templates or fixed SQL |
| Abuse limits | Per-user AI rate limit (default 60 runs per 10 minutes, a batch counts per file) on the four CV/sentiment AI endpoints and skills-gap analysis |

**Known limitations:**

- Tokens are kept in `localStorage`; an XSS bug would expose them. No Content-Security-Policy header is set.
- Login throttling and the AI rate limit are in memory, per process, and reset on restart.
- The grounding and leak checks are heuristics (documented limitations, including a self-referential bypass). The real model followed none of the 13 recorded injection cases, so the guards' rejection path has been exercised only with simulated responses.
- No HTTPS, deployment hardening or production configuration exists or was evaluated.
- No non-destructive first-admin provisioning (see [B](#initial-admin-provisioning-limitation)); demo accounts use a weak shared password.
- SQLite allows one writer at a time; it suits local and academic use.
- Work interrupted by a restart is failed, not resumed; one backend process per database is assumed.
- `npm audit` reports 22 findings, all in development or CLI tooling (3 in the Prisma CLI chain with `--omit=dev`); none is loaded by the running server.
- UI tested only in headless Chrome at emulated widths.

---

## I. Development and deployment

Step-by-step: [SETUP.md](SETUP.md) (short version: [QUICK_START.md](QUICK_START.md)); test details: [backend/TESTING.md](backend/TESTING.md).

- **Prerequisites:** Node.js 18.18+ and npm; no database server. An OpenAI API key only to run the real agents and the paid verification scripts. Google Chrome only for the browser checks.
- **Configuration:** copy `backend/.env.example` → `backend/.env.local` (set your own `JWT_SECRET`; optionally `OPENAI_API_KEY`) and `backend/.env.test.example` → `backend/.env.test`. `frontend/.env.example` (only `VITE_API_URL`) is optional. The root `.env.example` is a reference only; nothing loads it. Never put secrets in a `frontend/.env*` file.
- **Install:** `npm install` at the repository root (also generates the Prisma Client).
- **Database:** new database: `cd backend && npm run db:setup`. Existing database: back it up, then `npm run db:migrate:deploy`. **Never run `db:setup` or `db:seed` against a database whose data you need:** both delete every row.
- **Run:** `cd backend && npm run dev` (API on :3001) and `cd frontend && npm run dev` (app on :5173). Production-style: `npm run build` then `cd backend && npm start` (`node dist/server.js`) and serve `frontend/dist`; `FRONTEND_URL` must match the frontend origin.
- **Demo accounts:** created by the seed only (`admin@example.com` and `user1`–`user3@example.com`, password in [README.md](README.md#demo-accounts-local-development-only)); local development only.
- **Quality checks:** `npm run typecheck`, `npm run lint`, `npm run build` (root, both workspaces). Backend tests: `cd backend && npm test` (all files; resets `test.db` first) or one file, e.g. `npm test -- adminUsers`. UI regression: `npm run verify:ui` (no OpenAI calls). Scripts marked "Real OpenAI" in the README cost money.
- **Deployment:** there is no Dockerfile, CI pipeline or deployment guide.

---

## J. Architecture decisions

"Original design" marks decisions recorded in the 2026-10-06 design proposal; "Implementation" marks decisions recorded later in the topic documents; "Added here" marks rationale written for this document from the code.

| Decision | Rejected alternative(s) | Why | Source |
|---|---|---|---|
| Node.js + Express + TypeScript for the API | Python / FastAPI | One language across frontend and backend, simple middleware model, official OpenAI SDK | Original design |
| React + Vite SPA | Vue, Svelte | Larger ecosystem for dashboards; fast builds | Original design |
| Recharts for charts | Chart.js, D3 | React components, responsive; enough for the doughnut, treemap and bar charts | Original design (charts were added late) |
| Prisma ORM | Raw SQL, Sequelize | Type-safe client, versioned migrations | Original design |
| **SQLite** (one file per environment) | PostgreSQL (the first implementation used it), MongoDB | Relational data with foreign keys, transactions and CHECK constraints, and no database server or credentials for a local/academic project. Trade-off: one writer at a time; a multi-user production deployment would move back to a server database | Original design, revised in implementation (docs/DATABASE.md) |
| **Bearer access token + server-side session** (opaque refresh token stored as a hash; session and role checked on every request) | Stateless JWT only; JWT in httpOnly cookies (the original design) | A stateless token cannot be revoked on logout, role change or deletion (security audit finding F1). Cookies were not implemented; the cost is the `localStorage` risk, and moving to cookies would also need CSRF protection | Implementation (docs/SECURITY_AUDIT.md) |
| Token counts from the provider's `usage` fields only | Estimating with a tokenizer or text length | Accurate cost and auditability; missing usage is flagged, not guessed | Original design |
| Strict JSON output validated by schemas, with one repair retry | Regex/free-text parsing; unlimited retries | Deterministic, auditable shape; bounded cost | Original design / implementation |
| Prompt-injection defence by role separation, delimiters and output validation | Stripping suspicious words from the CV (tried early and removed; lossy and gives no guarantee); a separate LLM call to sanitise input | No CV corruption, no extra latency or cost, and validation holds even if the model obeys an injection | Original design, revised in implementation (`agents/cvClassification/prompt.ts`) |
| One centralised `LLMService` for every provider call | Each agent calling the SDK | One place to get token extraction, cost, latency and error logging right; agents cannot bypass logging | Implementation (docs/USAGE_LOGGING.md) |
| JSON uploads (text or base64 PDF) | Multipart uploads | No multipart parser dependency; nothing written to disk | Implementation (docs/BATCH_CV_PROCESSING.md) |
| PDF text extraction in a worker thread with limits | Extraction on the main thread; OCR | Bounded time and memory per PDF; OCR is out of scope | Added here (from `utils/pdfText.ts`) |
| In-process batch queue, 3 files at a time per batch | Unbounded parallelism; an external job queue | Limits provider rate-limit failures and SQLite contention without new infrastructure | Implementation (security/compliance audit F-06) |
| Interrupted runs failed at startup, not resumed | Resuming at startup | A resumed file could repeat a billed call nobody requested, and a queued file's type is not stored | Implementation (docs/BATCH_CV_PROCESSING.md) |
| A failed usage-log write does not fail the request | Failing the request | The call was already billed; failing would discard the result and invite a duplicate charge. The failure is reported instead | Implementation (docs/FINAL_COMPLIANCE_AUDIT.md F-02) |
| Soft delete for users | Physical delete | Cascading foreign keys would erase the user's history and change historical analytics | Implementation (docs/DATABASE.md) |
| Separate tables for external logs | Merging into `llm_usage_logs` | Imported data must never change internal metrics | Implementation (docs/EXTERNAL_LOG_FORMAT.md) |

---

## Assignment requirements and evaluation metrics

The traceability of every assignment requirement to code and evidence, as audited on 2026-10-09/10, is in [docs/FINAL_COMPLIANCE_AUDIT.md](docs/FINAL_COMPLIANCE_AUDIT.md). It predates the PDF upload, Skills Gap agent, CV feedback, charts, deletions and user management.

The required evaluation metrics and how they are produced:

| Metric | Produced by | Latest evidence |
|---|---|---|
| CV classification precision and recall per category | `npm run eval:cv-classification` (real OpenAI, 27 labelled samples in `evaluation/datasets/cv-classification-eval-v1.json`) | [evaluation/cv-classification-report.md](evaluation/cv-classification-report.md), 2026-10-09: 1.00 for all 9 categories. The dataset is small, so this is weak evidence of real-world accuracy |
| Logging accuracy (raw provider usage = logged usage = dashboard totals) | `npm run audit:logging-accuracy` (real OpenAI) | [evaluation/logging-accuracy-report.md](evaluation/logging-accuracy-report.md), 2026-10-09: PASS, 6 calls |
| Time saved in person-hours | `GET /api/analytics/time-saved` (estimate) | Shown on the dashboard as "Estimated time saved" |

The real-OpenAI evidence (evaluation, logging accuracy, multi-user, prompt injection, E2E) dates from 2026-10-08/09. It was not re-run after the later changes (rate limiting, run listing, PDF upload, CV feedback, Skills Gap agent, user management), which were verified with stub providers and browser checks only.
