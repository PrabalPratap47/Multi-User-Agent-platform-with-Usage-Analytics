# Testing

**Runner**: [Vitest](https://vitest.dev/) + [Supertest](https://github.com/ladjs/supertest), 37 test files in `tests/` (plus `setup.ts`, `helpers.ts` and `fixtures/`). Last full run: 539/539 on 2026-10-12.
**What the tests run against**: the real Express `app` (imported directly, never bound to a port) talking to a real SQLite database file (`backend/data/test.db`) through the real Prisma Client — no mocking of Prisma, JWT, or bcrypt. This is deliberate: authorization bugs are exactly the kind of thing that mocks paper over. The LLM provider is the only thing replaced (an injected stub client), so **no test calls OpenAI**.

The table of every verification command (what each proves, what it does not, and what it needs) is in the main [README](../README.md#tests-and-verification). This file covers the test suite, its database and the auth/RBAC proofs in detail.

## Test files

| File | Covers |
|---|---|
| `auth.test.ts` | Login, tokens, refresh rotation, logout revocation, RBAC requirements 1-4 (below) |
| `security.test.ts` | Security regression suite from the Step 17 audit: sessions, forged/expired/`alg:none` tokens, deleted/demoted users, login throttling, identity spoofing, isolation, admin-only routes, prompt injection and output validation (stubbed model), file upload, input validation, decision rules, secrets in responses and logs, CORS, error handling |
| `multiUserConcurrency.test.ts` | Three users and an admin with a scripted provider: concurrent runs and decisions, isolation, admin global analytics vs. the database |
| `cvClassification.integration.test.ts`, `cvClassificationAgent.test.ts`, `cvClassificationSchema.test.ts`, `cvClassificationPromptInjection.test.ts` | CV agent through the API, the validate → repair → fail flow, the strict schema, injection handling |
| `cvDecision.integration.test.ts`, `cvBatch.integration.test.ts` | Decision workflow; batch upload, per-file failures and progress |
| `migrationCheck.test.ts` | Startup migration check. Unit tests on real temporary SQLite files and migration folders: current, pending, rolled back, failed, re-applied, unknown, no history, missing file (no connection made), unreadable, missing or empty migrations folder; the file is unchanged after every check; the real repository and `test.db` are current. Real `src/server.ts` startups on isolated copies: a current DB starts in the order schema check, recovery, listen; pending, missing and unreadable DBs exit 1 without listening or recovering, with the command in the message and the file byte-identical |
| `runRecovery.test.ts` | Startup recovery: runs left `PENDING`/`RUNNING` by a previous process become `ERROR` with an accurate reason; finished and newer runs, usage logs and token analytics unchanged; idempotent; spawns the real `src/server.ts` against `test.db` (no OpenAI key, random port) |
| `cvBatchConcurrency.test.ts` | Batch concurrency cap (3 files = 3 provider calls in flight per batch) with a gated stub provider: queued counts while waiting, every file processed once, isolated failures and usage rows, two users' batches capped independently |
| `sentiment.integration.test.ts` | Sentiment agent through the API |
| `llmService.test.ts`, `costCalculator.test.ts`, `loggingAccuracy.test.ts`, `loggingAccuracy.integration.test.ts` | Usage logging, token extraction, missing-usage handling, cost, the logging-accuracy auditor |
| `usageLogWriteFailure.test.ts` | A usage-log row that cannot be written is reported (`persisted: false`, `USAGE_LOG_WRITE_FAILED` event), never faked, and never causes a second provider call |
| `aiRateLimit.test.ts` | Per-user AI rate limit: sliding window on a fake clock (limit, reset, `Retry-After`, weighted batch units, refunds), and over HTTP on all four AI endpoints. Checks 429 shape and header, nothing created and no provider call when refused, shared budget, read and upload endpoints unlimited, per-user and admin budgets, query/header/body/new-session spoofing, unauthenticated → 401, whole-batch refusal, 4xx refund, 502 keeps its charge, no overshoot under concurrency. Also the real defaults (60/600) and invalid values stopping startup |
| `jwtSecretConfig.test.ts` | Startup refuses a missing, blank, short or published placeholder `JWT_SECRET` (unit rules plus real `src/server.ts` startups in an empty directory); a generated secret is accepted; the public `.env.test.example` value only under `NODE_ENV=test` |
| `agentRuns.test.ts` | `GET /api/runs` and `/api/runs/:id`: admin sees every user, users only their own (`?userId=`, header and id spoofing), filters, validation (400s), pagination, CV/batch/sentiment run fields, seed flag, no CV/feedback text or tokens in responses |
| `usageCompleteness.test.ts` | Missing/incomplete usage made visible. Each case comes from the real path: provider without usage, unpriced model, usage-log insert blocked by a test-only trigger, startup-recovered interrupted run, plus a provider failure as a known zero. Covers exact counts per user, admin aggregate and `byUser`, `?userId=` scoping, `GET /api/runs?usage=incomplete` and `usageIssues`, recorded totals unchanged, and no row ever fabricated for a missing call |
| `analyticsService.test.ts` | Every metric against hand-computed fixtures, including seed-data exclusion and successful/failed runs |
| `externalAgentLogs.test.ts`, `evaluationMetrics.test.ts` | External log import; precision/recall/F1 math |
| `adminUsers.test.ts` | Admin user management: create (validation, case-insensitive duplicates, roles), soft delete (sessions revoked, login refused, data kept, no self-delete, last active admin protected under concurrency), change password (old one refused, sessions signed out, own session kept), 401/403/404 cases |
| `adminTokenUsage.test.ts` | Per-user token totals behind the Admin → Users chart |
| `cvPdfUpload.test.ts` | PDF text extraction limits and failures; single PDF and mixed PDF/TXT batches |
| `cvFeedback.test.ts` | CV feedback: 2-4 sentence schema rule, grounding in the CV (generic or injected feedback rejected), stored and returned for single and batch processing, JSON Schema sync |
| `cvDelete.test.ts`, `sentimentDelete.test.ts` | Admin-only deletion of CV documents and sentiment results; runs and usage logs kept; 403 for every regular user |
| `agentRunsDeletedUser.test.ts` | After a user is deleted, their runs leave `GET /api/runs` (list, total, every filter) and `GET /api/runs/:id` returns 404; the rows are kept and run-count analytics are unchanged; other users unaffected |
| `usageLogsPagination.test.ts` | `GET /api/usage-logs` paging: pages newest first without overlap, `meta.total` per scope (user, admin, admin `?userId=`), unchanged default without paging parameters, 400 for invalid values |
| `finalCategoryAnalytics.test.ts` | Original vs final category analytics (`/api/analytics/final-categories`) |
| `skillsGapAgent.test.ts`, `skillsGapSchema.test.ts`, `skillsGap.integration.test.ts` | Skills-gap agent: extraction against the selected role, role rules and non-fabrication (safe error after one repair), prompt injection, schema and JSON Schema sync, API isolation, admin-only delete, PSS/DCS roles |

Run one file or a group by name: `npm test -- security`, `npm test -- multiUserConcurrency`.

## The test database

| | Development | Testing |
|---|---|---|
| File | `backend/data/dev.db` | `backend/data/test.db` |
| Env file | `backend/.env.local` | `backend/.env.test` |
| `DATABASE_URL` | `"file:../data/dev.db"` | `"file:../data/test.db"` |

Paths in SQLite `file:` URLs are relative to `backend/prisma/`. Both `.db` files are git-ignored.

`npm test` runs the `pretest` script first, `npm run db:reset:test`, which deletes `data/test.db` and re-applies every migration in `prisma/migrations/`. Every run therefore starts from an empty database with the current schema.

## Safety guard

The test files delete and recreate their own rows (fixtures); `multiUserConcurrency.test.ts` and `security.test.ts` also run the real seed script against `test.db`. `src/db/testDatabaseGuard.ts` runs before every test file (from `tests/setup.ts`) and before `db:reset:test` deletes anything. It refuses unless all of these hold:

1. `NODE_ENV` is `test` (Vitest sets this), so `src/config/env.ts` loaded `backend/.env.test`, not `.env.local`.
2. `DATABASE_URL` is a valid SQLite `file:` URL.
3. It does not resolve to `backend/data/dev.db`.
4. It resolves to exactly `backend/data/test.db`. Any other file is refused, even one named like a test database.
5. `backend/.env.local` does not point development at `test.db`.

Separately, `src/db/client.ts` refuses to start the app outside `NODE_ENV=test` if it is configured to use `test.db`.

Error messages state only the reason. They never include the configured URL or resolved path. A failed connection prints only `Test database connection failed.`

## Running it

```bash
cd backend
cp .env.test.example .env.test   # one-time; no edits needed

npm test            # resets data/test.db, then runs all tests once
npm run test:watch  # watch mode (run `npm run db:reset:test` first)
```

**AI rate limit in tests.** `vitest.config.ts` sets `AI_RATE_LIMIT_MAX_RUNS=100000` for the test runner only, because suites such as `security.test.ts` start dozens of AI runs for one user in seconds and aren't about rate limiting. `.env.test` is unchanged. `aiRateLimit.test.ts` installs its own small limiter with a fake clock, and checks the real defaults (60 per 600 s) by loading the config in a child process. `verify:ui`, `verify:dashboard-run-outcomes` and the real-OpenAI scripts run with the normal defaults.

`npm test` never calls OpenAI (every agent test uses a provider stub). The
full end-to-end run against the **real** OpenAI API (about 23 short gpt-4o
calls, needs `OPENAI_API_KEY` in `.env.local`) is
`npm run verify:e2e-real-openai`. It uses its own fresh database
(`data/e2e-real.db`) and writes `../evaluation/e2e-real-openai-results.json`;
results are summarised in `../evaluation/e2e-test-report.md`.

`npm run verify:ui` is the UI regression check (Google Chrome, **no** OpenAI
calls, CONTROLLED provider, `data/ui-verify.db`). For admin and a regular user at
1440 / 820 / 390 / 320 px on every tab, it fails on horizontal page scrolling,
unnamed controls or text below WCAG AA contrast. It also covers login errors,
logout, keyboard focus and the CV, batch and sentiment flows. See
`../docs/UI_UX_REVIEW.md`.

`npm run verify:dashboard-run-outcomes` checks the successful / failed run
counts from the database through the API to the rendered dashboard. It
needs Google Chrome installed but makes **no** OpenAI calls: runs are
created through the real API with a CONTROLLED provider, on
`data/dashboard-verify.db`.

## Auth & RBAC suite (`tests/auth.test.ts`): what each requirement maps to

| Requirement | Test(s) |
|---|---|
| 1. Unauthenticated users cannot access protected APIs | `describe('Requirement 1: ...')` — no header, garbage token, wrong-secret token, expired token, all return `401` on `/api/usage-logs`, `/api/users`, `/api/auth/me` |
| 2. Normal users cannot access another user's records | `describe('Requirement 2: ...')` — user1 → user2's records by id returns `403` (and symmetrically user2 → user1); a `?userId=` query override is proven to have **no effect** for a non-admin |
| 3. Admin can access all users | `describe('Requirement 3: ...')` — admin's `GET /api/users` lists every account; admin's `GET /api/usage-logs` (no filter) returns records belonging to multiple different users; a non-admin is forbidden from the same listing endpoint |
| 4. Identity comes from the auth/session context, not the client | `describe('Requirement 4: ...')` — `GET /api/auth/me` returns exactly the token's identity; a `userId` smuggled into a request **body** (logout) cannot act on another user's session; a token whose payload is tampered with (id/role changed) but whose signature no longer matches is rejected; a redundant `?userId=` query string changes nothing about the response |

Two extra `describe` blocks cover the refresh-token lifecycle (rotation + replay rejection, and logout actually revoking the stored token) since "sessions/JWT must be securely implemented" was an explicit requirement — an unrevocable refresh token would fail that bar even though it's not one of the four numbered proofs.

## Design choices worth knowing about

- **Identity extraction happens in exactly one place**: `authenticateToken` (`src/middleware/authMiddleware.ts`). It verifies the JWT signature (HS256 only), then loads the session named by the token's `sid` claim and the user **with their current role from the database** (`AuthService.resolveSession`), and sets `req.user` from that - not from the token's own role claim. Logout, a role change or a deleted user therefore take effect on the next request (`security.test.ts` proves this). Every controller reads `req.user`, never `req.body.userId`, `req.query.userId`, or a route param, to decide *who is calling*.
- **URL params still appear in resource routes** (e.g. `GET /api/usage-logs/:userId`) — that's the resource being requested, not the caller's identity. `requireSelfOrAdmin('userId')` compares that param against `req.user.id` and rejects with `403` unless they match or the caller is an admin. The tests for Requirement 2 specifically prove this distinction: changing the URL doesn't change who you're authenticated as, it just gets you a `403` if you ask for someone else's resource.
- **Refresh tokens are opaque, random values**, stored server-side only as a SHA-256 hash (never the raw value), with a real revocation path. A stateless-JWT-only refresh token can't actually be invalidated on logout; this can.
- **Passwords are hashed with bcrypt** (`BCRYPT_SALT_ROUNDS`, 12 in dev, 4 in the test env purely for speed — lower rounds in tests is a common, safe trade since the test DB never holds real credentials).
