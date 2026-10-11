# Final Requirements & Compliance Audit (Step 21)

| | |
|---|---|
| Date | 2026-10-09 |
| Scope | The whole repository against the original assignment and the requirements added during implementation |
| Type | Audit only. No application code, tests, dependencies, configuration or data were changed. No paid OpenAI calls were made. `backend/data/dev.db` was not modified (fingerprint below). |
| Overall status | **PARTIALLY VERIFIED.** Every assignment feature is implemented, and almost all are verified with evidence that applies to the current code. Two assignment clauses are only partly met (AUTH-06 "admin sees all agent runs", LOG-02 "every LLM call must log"). One operational issue (F-01: the developer's `dev.db` is one migration behind) would break usage logging in a demo run on that database. |
| Step 22 updates | **F-01 RESOLVED** (migration applied to `dev.db`, 2026-10-09). **F-02 RESOLVED with residual risks** (usage-log write failures are now explicit and detectable; verified with stub providers only - the changed logging path has not been re-run against real OpenAI). **F-03 RESOLVED** (`GET /api/runs`, `GET /api/runs/:id` and the AGENT RUNS tab; CONTROLLED tests and browser checks). **F-05 RESOLVED** (the backend refuses to start with a missing, blank, short or published placeholder `JWT_SECRET`). **F-06 RESOLVED** (at most 3 provider calls in flight per batch). **F-07 RESOLVED** (runs left queued/running by a previous process are failed with an accurate reason at startup, before requests are accepted; not resumed). **F-10 RESOLVED** (per-user AI rate limit on the four AI-triggering endpoints; in memory, per process). **F-14 RESOLVED** (missing/unknown usage is counted by `GET /api/analytics/usage-completeness`, labelled on the dashboard totals and findable in AGENT RUNS; API and browser checks). **F-23 RESOLVED** (startup refuses a database whose schema is behind the checked-in migrations, or whose state can't be verified; read-only, before recovery and listening). Details in §8. The rest of this document is the Step 21 audit as written, except where a row is marked "Step 22". |

> **Scope note (added 2026-10-11).** This audit and its Step 22 record trace the code up to 2026-10-10.
>
> Added later and **not traced here**:
> - PDF CV upload (CV-06's "plain text only" note is superseded: text-based PDFs are now supported);
> - generated CV feedback;
> - the CV Skills Extraction & Gap Analysis Agent;
> - charts (F-12: `recharts` is now used; `lucide-react` is still declared but unused);
> - admin user management;
> - admin-only deletions.
>
> F-11 was resolved on 2026-10-11: the unreachable second `/health` route was removed. The evidence dates and counts below are as of the audit. The current implementation is described in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 1. Sources and method

### Requirement sources

1. **The original assignment** (primary). This is the first instruction of the project (2026-10-06), read from the project transcript because no copy exists in the repository. It defines:
   - 11 numbered features;
   - the 9 CV categories, the CV output contract and the JSON-schema rule;
   - 9 per-call log fields, and the rule that token counts come from provider usage fields;
   - 11 dashboard metrics;
   - 3 evaluation metrics;
   - 4 security rules.
2. **Requirements added in later implementation instructions** (derived, same transcript):
   - authentication/RBAC (incl. tests 1-4 and demo users);
   - schema, incl. that a decision reason is mandatory for MODIFY/REJECT and the original recommendation is stored separately;
   - the centralised LLM service, cost and pricing documentation;
   - prompt-injection defences (12 points);
   - the sentiment contract;
   - dashboard sections, responsiveness and empty/loading/error states;
   - external-log tab contents;
   - the evaluation framework;
   - multi-user/concurrency (Step 16, requirements 1-12);
   - "strict engineering rules" (no fabricated metrics, an ESTIMATED vs MEASURED time-saved methodology, never trust client user ids, never expose secrets);
   - successful/failed run counts (Step 18 follow-up);
   - UI/UX (Step 19) and documentation (Step 20).
3. **A note on concurrency.** "Two users working at the same time" is quoted as an assignment requirement in the Step 16 instruction but is not in the pasted original. It is audited as a user-stated requirement.

No other specification was found. Where the original wording is ambiguous (e.g. "Admin can see … all agent runs"), the literal reading is audited and the ambiguity is stated.

### Evidence classes

- **CURRENT:** executed in this step against the current code.
- **CURRENT-EQUIVALENT:** executed earlier, but no file that affects the result has changed since. This was established by comparing source-file modification times with each report's timestamp.
- **HISTORICAL:** executed before a relevant change, and superseded or complemented by later evidence.

Evidence currency, from the source mtimes vs. report timestamps:

| Evidence | Produced | Backend runtime files changed since | Class for current code |
|---|---|---|---|
| Real-model prompt injection (`evaluation/real-model-prompt-injection-report.json`, 13 cases) | 2026-10-08 10:29Z | `analyticsService.ts`, `utils/validators.ts` (the whitespace-CV rule only) | CURRENT-EQUIVALENT for injection handling (prompt builder, agent and guards unchanged) |
| Real-OpenAI E2E (`evaluation/e2e-real-openai-results.json`, 367/368) | 2026-10-09 04:39Z | `analyticsService.ts` only (successful/failed run counts) | CURRENT-EQUIVALENT for auth, agents, LLM service, usage logging, batch, decisions and isolation. HISTORICAL for the run-count analytics, which is re-covered by the rows below. |
| CV evaluation, real (`evaluation/cv-classification-results.json`) | 2026-10-09 04:40Z | `analyticsService.ts` only | CURRENT-EQUIVALENT |
| Real multi-user (72/72), logging accuracy (PASS) | 2026-10-09 04:46-04:47Z | `analyticsService.ts` only | CURRENT-EQUIVALENT |
| `verify:dashboard-run-outcomes` (44/44) | 2026-10-09 07:17Z | none (only the separate `verifyUi.ts` script changed) | CURRENT-EQUIVALENT |
| `verify:ui` (64/64) | 2026-10-09 07:21Z | none | CURRENT-EQUIVALENT |
| Fresh-copy setup (Step 20, `docs/DOCUMENTATION_REVIEW.md`) | 2026-10-09 | none (Step 20 changed documentation only) | CURRENT-EQUIVALENT |

### Commands executed in this step

All were read-only with respect to application code and `dev.db`.

| Command / check | Result |
|---|---|
| Extract the original assignment and later requirement instructions from the project transcript | Found (assignment of 2026-10-06; 10 requirement-defining instructions) |
| Source-mtime vs report-timestamp comparison (scratch script) | Table above |
| `cd backend && npm test` | **313/313 passed, 17 files** (CURRENT) |
| `npx vitest run tests/cvClassificationPromptInjection.test.ts tests/externalAgentLogs.test.ts` (to confirm counts cited below) | 42 + 22 = 64 passed |
| Cross-check of every figure cited here against `evaluation/*` reports, `docs/DEPENDENCY_AUDIT.md`, `docs/DOCUMENTATION_REVIEW.md`, migrations folder | Consistent; two unsupported remarks removed before publication |
| Code inspection: `grep` / reads of auth, middleware, services, agents, routes, frontend store and components, env schema, package manifests | Results cited per row |
| G9 impact check on a **copy** of `dev.db` (`cp` to a scratch folder; Prisma pointed at the copy; real `UsageLogService.logCall`) | `providerResponseId` column absent. `llmUsageLog.findMany` fails ("The column `main.llm_usage_logs.providerResponseId` does not exist"). `logCall` **did not throw**, and the row count stayed 4 → 4. |
| `dev.db` fingerprint before and after | Identical: SHA-256 `127e2cf5fcae0857…`, 208,896 bytes, mtime 2026-10-08T07:01:57.512Z |

**Not run in this step:**

- real-OpenAI scripts (`verify:e2e-real-openai`, `verify:*-real-openai`, `audit:logging-accuracy`, `eval:cv-classification`);
- browser checks (`verify:ui`, `verify:dashboard-run-outcomes`): their CURRENT-EQUIVALENT results are used;
- typecheck, lint and build: last run in Step 19 after the final code change, plus the root typecheck in Step 20;
- migrations.

## 2. Status counts

| Status | Requirements |
|---|---|
| VERIFIED | 64 (**Step 22: 65**, AUTH-06 added) |
| PARTIALLY VERIFIED | 4 (AUTH-06, LOG-02, DOC-03, QA-03) (**Step 22: 3**, AUTH-06 removed) |
| NOT VERIFIED | 2 (UI-02, DOC-02) |
| NOT IMPLEMENTED | 1 (AN-15, `/api/analytics/evaluation`; **not an assignment requirement**, see §4) |
| **Total** | **71** |

## 3. Requirements traceability matrix

Legend:

- **Severity** is that of the gap, if any.
- **Blocks** means the gap blocks assignment completion or the final demo.
- **Source:** A-n = original assignment item n; P-x = a later implementation instruction; S16/S17/S18/S19/S20 = step instructions.
- Test file names are under `backend/tests/` unless a path is given.

### A. Authentication and access control

| ID | Requirement (source) | Implementation | Tests / reports | Evidence | Status | Gap / limitation | Sev. / Blocks |
|---|---|---|---|---|---|---|---|
| AUTH-01 | Authentication with real user credentials; passwords hashed (A-1, P-auth) | `services/authService.ts` (bcrypt), `routes/auth.ts`, `components/LoginForm.tsx` | `auth.test.ts`; `security.test.ts` §1; E2E §13 | CURRENT (313/313); E2E CURRENT-EQUIVALENT | VERIFIED | — | — |
| AUTH-02 | Identity from the server-side session; never from a body, query, URL or hardcoded frontend value (A-sec, P-auth, rule 11) | `middleware/authMiddleware.ts` → `AuthService.resolveSession(sid)`; controllers read `req.user` | `auth.test.ts` Req 4; `security.test.ts` §2; E2E spoof check | CURRENT; grep: no hardcoded ids in `frontend/src`, and `usageLogsService.getByUserId` has 0 callers | VERIFIED | — | — |
| AUTH-03 | Roles checked against the current authoritative user record (S21-A) | `resolveSession` loads user and role from the DB on every request | `security.test.ts` §1 "role changes and deleted users take effect immediately"; E2E tampered `role=admin` → 403 | CURRENT | VERIFIED | — | — |
| AUTH-04 | User sees only their own runs, usage, results, decisions, analytics (A-2, rule 12) | Ownership checks in services (403); `analyticsService.userScope` | `auth.test.ts` Req 2; `security.test.ts` §3; `multiUserConcurrency.test.ts` Req 4/6; E2E §14/15 (6 pairs × 8 routes, no leak, no provider call) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | ~~"Own runs" are visible only indirectly (see AUTH-06)~~ **Step 22:** own runs are listed by `GET /api/runs` and the AGENT RUNS tab (`agentRuns.test.ts`) | — |
| AUTH-05 | Admin sees all users, all usage analytics and dashboard data; user drill-down (A-2, P-dash) | `requireAdmin`; admin scope in services; `/api/users`; `?userId=` drill-down | `auth.test.ts` Req 3; `security.test.ts` §4; `multiUserConcurrency.test.ts` Req 5; E2E §12; dashboard check 54/54 on real data | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| AUTH-06 | Admin can see **all agent runs** (A-2, literal) | ~~No endpoint or view lists `agent_runs`.~~ **Step 22:** `GET /api/runs` (all users for admin, `?userId=`/`agent`/`status` filters, bounded pagination), `GET /api/runs/:id`, AGENT RUNS tab (`components/AgentRunsPanel.tsx`) | **Step 22:** `agentRuns.test.ts` (18); scratch browser check 29/29; `verify:ui` 72/72 | CURRENT (339/339; CONTROLLED) | **VERIFIED** (Step 22; was PARTIALLY VERIFIED) | ~~Failed runs with no AI call ... are not listable.~~ All runs, including failed runs with no AI call, are now listable. See **F-03** / §8.3. | — |
| AUTH-07 | Logout, session revocation, deleted accounts, role changes, invalid/expired sessions (S17, S21-A) | Session-bound JWT (`sid`), refresh rotation, revocation | `security.test.ts` §1 (logout, rotation, forged/expired/`alg:none`, non-login-issued token, deleted/demoted users); E2E Sessions (9 checks) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| AUTH-08 | Login throttling and failure behaviour match the docs (S17, S21-A) | `authService.ts`: `LOGIN_MAX_FAILURES = 10`, window 15 min, per IP + email, in-memory `Map`; 400 with the same message for wrong password and unknown email | `security.test.ts` §1 throttling; `auth.test.ts`; E2E auth | CURRENT | VERIFIED | In memory: resets on restart, per process (F-09); documented in README | Low / no |
| AUTH-09 | Backend-enforced authorization; frontend route protection (P-auth) | `ProtectedRoute.tsx`; role-specific tabs; 401/403 on the server | `security.test.ts` §4; `verify:ui` role tabs | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| AUTH-10 | At least 3 demo users (admin, user1-3) with documented local-only credentials (A-3, P-auth) | `db/seed.ts`; README/SETUP (dev-only; login page shows them only in dev builds) | Fresh-copy `db:setup` (Step 20); E2E; `verify:ui` | CURRENT-EQUIVALENT | VERIFIED | — | — |

### B. Multi-user operation and concurrency

| ID | Requirement (source) | Implementation | Tests / reports | Evidence | Status | Gap / limitation | Sev. / Blocks |
|---|---|---|---|---|---|---|---|
| MU-01 | Three users each use both agents through the real app (S16 R1) | CV and sentiment APIs | `evaluation/multi-user-real-openai-report.md` (72/72, real); E2E §6; `multiUserConcurrency.test.ts` Req 1 | CURRENT-EQUIVALENT (real) + CURRENT (stubbed) | VERIFIED | — | — |
| MU-02 | Two users working at the same time, with measured overlap (user-stated assignment quote, S16 R2/R10) | Concurrent HTTP requests; no shared mutable state per request | Multi-user report (peak 3 concurrent calls); E2E §17 (HTTP, provider and DB-run intervals overlap; peak 2 and 3); `multiUserConcurrency.test.ts` Req 2/3/7/10 | CURRENT-EQUIVALENT + CURRENT | VERIFIED | — | — |
| MU-03 | Correct attribution: user, run, model, usage, latency, cost, status, provider response id (S16 R7, S18) | `LLMService` → `UsageLogService.logCall` | E2E Usage logging (23/23 rows exact vs raw OpenAI); multi-user report | CURRENT-EQUIVALENT | VERIFIED | Holds when the usage row is written; see LOG-02 | — |
| MU-04 | Cross-user attempts denied without leaking data or causing provider calls (S16 R4, S18) | Ownership checks before agent calls | E2E §14; `security.test.ts` §3 | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| MU-05 | Concurrent decisions stored against the right user/CV/run (S16 R8) | `cvDecisionService` (append-only) | `multiUserConcurrency.test.ts` Req 8; E2E §18 (overlapping MODIFY + REJECT) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| MU-06 | Batch behaviour with several files at once (S18) | `cvBatchService` (~~`Promise.allSettled`~~ **Step 22:** `runWithConcurrencyLimit`, 3 per batch) | `cvBatch.integration.test.ts`; E2E §16 (peak 3 parallel calls, per-file ownership); **Step 22:** `cvBatchConcurrency.test.ts` (8) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | ~~Concurrency is unbounded up to 20 calls (F-06)~~ **Step 22:** capped at 3 in-flight calls per batch (F-06 resolved); no global cap | — |

### C. CV Classification Agent

| ID | Requirement (source) | Implementation | Tests / reports | Evidence | Status | Gap / limitation | Sev. / Blocks |
|---|---|---|---|---|---|---|---|
| CV-01 | Exactly the 9 categories (A-cat) | `utils/validators.ts` `CV_CATEGORIES`; strict `ConfidenceMapSchema` | `cvClassificationSchema.test.ts` | CURRENT | VERIFIED | — | — |
| CV-02 | Primary category, optional secondaries, confidence 0-1 per category, rationale (A-out, rule 15) | `agents/cvClassification/schema.ts` (strict, with refinements) | Schema and agent tests; E2E §10/§19; `verify:ui` CV check | CURRENT | VERIFIED | — | — |
| CV-03 | Valid JSON conforming to a documented schema (A-json) | `cvClassificationResponse.schema.json` + Zod | `cvClassificationSchema.test.ts` (keeps the two in sync) | CURRENT | VERIFIED | — | — |
| CV-04 | Rationale cites evidence from the CV (A-out) | `outputGuard.isPrimaryRationaleGrounded`; evidence sanitised | Unit tests; E2E grounding checks on real output; evaluation (27 real outputs) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | The grounding check is heuristic (shared vocabulary); its known limitation is documented in `docs/PROMPT_INJECTION_SECURITY.md` (F-18) | Low / no |
| CV-05 | Invalid model output: validate → one repair → fail closed, nothing persisted (P-PI, rule 15) | `CVClassificationAgent.execute`; controller maps to 502 | `cvClassificationAgent.test.ts`; integration; `security.test.ts` §6; E2E CONTROLLED C3-C6 | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| CV-06 | Empty/whitespace, oversized, binary (renamed PDF/DOCX), unsupported inputs rejected (S17, S18) | `validators.ts` (trim ≥ 10, ≤ 50,000, binary detection); batch per-file checks; UI pre-checks | `cvClassification.integration.test.ts` (whitespace regression); `security.test.ts` §7; E2E §21; `verify:ui` | CURRENT + CURRENT-EQUIVALENT | VERIFIED | Plain text only; no PDF/DOCX extraction (by design, documented in README and `docs/BATCH_CV_PROCESSING.md`) | Info / no |
| CV-07 | ACCEPT/MODIFY/REJECT persisted with user, CV/run reference, original recommendation separate, final decision and categories, reason, timestamp (A-8, P-schema) | `RecommendationDecision` model + DB CHECKs; `cvDecisionService` (append-only) | `cvDecision.integration.test.ts`; `security.test.ts` §9; E2E §18 | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| CV-08 | MODIFY and REJECT require a reason (P-schema) | Zod + DB CHECK + UI rule text | `security.test.ts` §8/§9; E2E §18; `verify:ui` REJECT check | CURRENT | VERIFIED | — | — |
| CV-09 | Batch processing with progress, partial failures, per-file results (A-7) | `cvBatchService`, `GET /api/cv/batch/:id/status`, `ProcessingJobView` | `cvBatch.integration.test.ts`; E2E §16 (real); `verify:ui` partial-failure check; `docs/BATCH_CV_PROCESSING.md` | CURRENT + CURRENT-EQUIVALENT | VERIFIED | ~~No recovery after restart (F-07)~~ **Step 22:** interrupted runs are failed with an accurate reason at the next startup, not resumed (F-07 resolved, `runRecovery.test.ts`) | — |
| CV-10 | Prompt injection cannot override the classification instructions; 12-point defence in depth (A-9, A-sec, P-PI) | `agents/cvClassification/prompt.ts` (untrusted block, neutralised delimiters), strict schema, `outputGuard` (leak/grounding) | `cvClassificationPromptInjection.test.ts` (42); `security.test.ts` §5; real-model report (13/13); E2E §19 (7/7 real) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | The real model never complied, so guard rejection was exercised only by CONTROLLED cases (F-18) | Info / no |

### D. Sentiment Agent

| ID | Requirement (source) | Implementation | Tests / reports | Evidence | Status | Gap / limitation | Sev. / Blocks |
|---|---|---|---|---|---|---|---|
| SE-01 | Input validation; output `{sentiment, confidence, rationale}` with a documented schema (A-4, P-sent) | `agents/sentiment/schema.ts`, `sentimentResponse.schema.json`; `SentimentRequestSchema` (1-5,000) | `sentiment.integration.test.ts`; `security.test.ts` §6 | CURRENT | VERIFIED | No test keeps the sentiment JSON schema file in sync with Zod (CV has one) (F-15) | Low / no |
| SE-02 | Failure handling: malformed output, provider failure (P-sent) | `SentimentAgent` repair → `SentimentValidationError` → 502 | Tests; E2E CONTROLLED C2 (401) and C7 (invalid label) | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| SE-03 | Authenticated, attributed to the user, creates a run, logs usage, latency, status; users see own results, admin all (P-sent) | `sentimentService` | Tests; multi-user report; E2E | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| SE-04 | Both agents use the centralised, configured OpenAI integration (P-LLM) | `services/llmService.ts` (`createOpenAIClient`, `OPENAI_MODEL`) | `llmService.test.ts`; real reports | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| SE-05 | Results shown in the UI match backend responses and stored records (S21-D) | `SentimentTab.tsx` | `verify:ui` (shown result = API, by id and confidence) | CURRENT-EQUIVALENT | VERIFIED | — | — |

### E. LLM usage and logging accuracy

| ID | Requirement (source) | Implementation | Tests / reports | Evidence | Status | Gap / limitation | Sev. / Blocks |
|---|---|---|---|---|---|---|---|
| LOG-01 | Accurate usage logging; tokens from the provider's usage fields only (A-5, A-tok, rules 6-7) | `LLMService` reads `usage.prompt_tokens` / `completion_tokens`; never estimated | `llmService.test.ts`, `loggingAccuracy*.test.ts`; logging-accuracy report (raw = logged = dashboard, 4,971 / 583); E2E 23/23 rows exact | CURRENT + CURRENT-EQUIVALENT | VERIFIED | The OpenAI client keeps the SDK's default retry policy (`llmService.ts:95`, no `maxRetries` override); a retried attempt is not logged as its own row, and the logged latency includes it | Info / no |
| LOG-02 | **Every** LLM call logs timestamp, user, agent, model, input/output tokens, latency, status, cost (A-log, P-LLM "without losing the usage/error log where possible") | `UsageLogService.logCall` writes the row, but **catches and swallows any write error** ("logging failure shouldn't break the application"). **Step 22:** a failed write is now returned as `persisted: false`, surfaced as `usage.usageLogPersisted: false` and logged as one `USAGE_LOG_WRITE_FAILED` event (§8). | Same as LOG-01; G9 copy check. **Step 22:** `usageLogWriteFailure.test.ts` (8, CONTROLLED) | CURRENT: on a copy of `dev.db`, `logCall` returned normally and wrote nothing. **Step 22:** 321/321 incl. the 8 new tests | **PARTIALLY VERIFIED** | When the row cannot be written (schema drift, DB error), the AI call still runs, is billed and its result stored, but no usage row exists. ~~Only a server log line records it.~~ **Step 22:** the failure is now explicit and detectable (event + SQL check), but the call is still missing from the dashboards with no on-screen indicator, and the real-OpenAI pipeline was not re-run after the change. See **F-02**. **Step 22 (F-14):** a successful run with no usage row is now counted and shown ("Totals are incomplete", AGENT RUNS "Usage incomplete"). A lost row on a run that also has a logged call, or on a failed run, is still only in the server log. The status stays PARTIALLY VERIFIED: those cases remain, and the real pipeline was not re-run. | Low (after Step 22) / no |
| LOG-03 | Failed provider calls logged (ERROR, 0 tokens, reason) (P-LLM) | `LLMService` error path | Tests; E2E CONTROLLED C1/C2 | CURRENT + CURRENT-EQUIVALENT | VERIFIED | — | — |
| LOG-04 | Missing usage recorded as unavailable, never invented (rule 7) | 0/0 + `errorCode: MISSING_USAGE_DATA` | `llmService.test.ts`; E2E CONTROLLED rows | CURRENT | VERIFIED | ~~Dashboards do not show how many rows lack usage (F-14)~~ **Step 22:** counted as unknown (`callsWithUnknownUsage`) and shown on the Overview (F-14 resolved) | — |
| LOG-05 | Cost from actual tokens and centralised, documented pricing with a last-verified date (P-LLM, rule 8) | `config/modelPricing.ts` ("Last verified: 2026-10-07"), `costCalculator.ts` | `costCalculator.test.ts`; E2E cost exact to 1e-12 | CURRENT | VERIFIED | Unpriced models get `null` cost, ~~silently~~ excluded from totals; **Step 22:** the exclusion is now reported (`callsWithUnknownCost`, "Known costs only - incomplete") (F-14 resolved) | — |
| LOG-06 | Provider response id stored where available (S15) | `llm_usage_logs.providerResponseId` (migration `20261008120000`) | Logging audit; E2E | CURRENT-EQUIVALENT | VERIFIED | ~~The developer's `dev.db` lacks this column (F-01)~~ **Step 22:** column and index now present in `dev.db` (F-01 resolved) | — |
| LOG-07 | Dashboard totals reconcile with raw API usage and the database (A-eval-3) | Analytics from `llm_usage_logs` only | Logging-accuracy report; E2E Part 12; dashboard 54/54 (real data) | CURRENT-EQUIVALENT | VERIFIED | — | — |

### F. Analytics and dashboard

All metrics are computed server-side in `services/analyticsService.ts` and shown by `components/analytics/*`. The common evidence is:

- `analyticsService.test.ts` (fixtures incl. seed exclusion);
- `multiUserConcurrency.test.ts` Req 5/6 (API = DB, per scope);
- E2E §12 (DB = API on every metric, all scopes);
- the real-data dashboard comparison (54/54: DB = API = rendered);
- `verify:dashboard-run-outcomes` (44/44).

| ID | Requirement (source) | Status | Notes |
|---|---|---|---|
| AN-01 | Overall input and output tokens, plus total (A-dash) | VERIFIED | — |
| AN-02 | Estimated cost (A-dash) | VERIFIED | ~~Excludes unpriced models silently (F-14)~~ **Step 22:** still excludes unknown costs, but says so (F-14 resolved) |
| AN-03 | Token consumption by user, admin only (A-dash) | VERIFIED | — |
| AN-04 | Token consumption by agent (A-dash) | VERIFIED | — |
| AN-05 | Agent runs 24h / 7d / 30d (A-dash) | VERIFIED | Seed demo runs excluded (defect fixed in Step 18) |
| AN-06 | Successful and failed run counts (S18 follow-up) | VERIFIED | CURRENT: 4 unit tests + API tests in 313/313; CURRENT-EQUIVALENT: 44/44 and the 54/54 real-data check, both run after the change |
| AN-07 | Error rate by agent (A-dash) | VERIFIED | Call-level by definition (documented) |
| AN-08 | Average latency by agent (A-dash) | VERIFIED | — |
| AN-09 | CV acceptance rate per category (A-dash) | VERIFIED | Grouped by the original category; seed decisions excluded |
| AN-10 | Time saved in person-hours, with documented ESTIMATED methodology (A-dash, rule 10) | VERIFIED | `methodology: "ESTIMATED"`; a 5-minute baseline × measured latency; documented |
| AN-11 | External agent logs in a separate tab with records, tokens, cost, runs, errors, latency, per-agent breakdown, never mixed into internal metrics (A-11, P-ext) | VERIFIED | `externalAgentLogs.test.ts` (22); E2E §20; dashboard checks |
| AN-12 | Admin/global vs user scope, `?userId=` drill-down, seed exclusion, empty/loading/error states, server-side computation, no cross-user leakage (P-dash) | VERIFIED | `verify:ui` (all tabs, both roles); security §2 (`?userId=` ignored for users) |
| AN-13 | CV precision per category (A-eval-1) | VERIFIED | Real run 2026-10-09 (27 samples): 1.00 for all 9 categories. CURRENT-EQUIVALENT. Small dataset (F-19). |
| AN-14 | CV recall per category (A-eval-2) | VERIFIED | As AN-13; secondary labels micro P 0.667 / R 1.0 |
| AN-15 | `GET /api/analytics/evaluation` returns evaluation metrics (planned in the design, not in the assignment) | **NOT IMPLEMENTED** (optional) | Returns only a placeholder message. See §4 and F-13. |

### G. Security and reliability (requirement rows)

| ID | Requirement (source) | Evidence | Status | Notes |
|---|---|---|---|---|
| SEC-01 | Users cannot access other users' data (A-sec) | AUTH-04, MU-04 | VERIFIED | — |
| SEC-02 | Admin can access all data (A-sec) | AUTH-05 | VERIFIED | ~~Except the run listing (AUTH-06)~~ **Step 22:** run listing added (AUTH-06) |
| SEC-03 | CV prompt injection must not override the instructions (A-sec) | CV-10 | VERIFIED | — |
| SEC-04 | User ids never from URL parameters or hardcoded frontend values (A-sec) | AUTH-02; `docs/SECURITY_AUDIT.md` 2.4; grep in this step | VERIFIED | `GET /api/usage-logs/:userId` treats the id as the requested **resource** (self or admin), never as identity; the frontend never calls it |
| SEC-05 | Never expose secrets; none in the frontend (rule 14) | Key scans (Steps 18-20: the key only in `backend/.env.local`); `security.test.ts` §10/11; key redaction (E2E C2); production bundle scan (Step 19) | VERIFIED | — |
| SEC-06 | Request validation and safe error responses (S17) | `security.test.ts` §7/§8/§14; E2E §21 (31 edge cases) | VERIFIED | — |
| SEC-07 | Logging hygiene: no passwords, tokens, keys or CV text in logs (S17) | `security.test.ts` §10/11; E2E log capture | VERIFIED | — |

### H. UI, accessibility and documentation

| ID | Requirement (source) | Evidence | Status | Notes |
|---|---|---|---|---|
| UI-01 | Responsive, accessible dashboard with clear states (P-dash, S19) | `docs/UI_UX_REVIEW.md`; `verify:ui` 64/64 (no page overflow, all controls named, WCAG AA contrast, focus visible, at 1440/820/390/320 px) | VERIFIED (emulated Chrome) | No arrow-key navigation for the decision radio group or tabs (Tab works); wide tables scroll inside cards on phones |
| UI-02 | Behaviour in Firefox, Safari, physical devices, screen readers | None | **NOT VERIFIED** | Outside the tested scope (`docs/UI_UX_REVIEW.md`) |
| DOC-01 | Documentation accurate; setup reproducible (S20) | `docs/DOCUMENTATION_REVIEW.md`: fresh-copy install, `db:setup`, 313/313, startup, browser login, preview, Studio, PowerShell variants | VERIFIED (Windows 10 / Node 24 / npm 12) | — |
| DOC-02 | A literal `git clone` reproduces the project | None | **NOT VERIFIED** | Not possible: no commits. Step 20 used the commit-equivalent file set. |
| DOC-03 | Multi-user demo script (`docs/MULTI_USER_DEMO.md`) usable by an evaluator (S16 R11) | Exists; its commands, links and paths were checked in Step 20 | **PARTIALLY VERIFIED** | Its PowerShell API walkthrough was not executed in Steps 20-21 |

### I. Setup and reproducibility; quality gates

| ID | Requirement (source) | Evidence | Status | Notes |
|---|---|---|---|---|
| SET-01 | Documented commands exist and match the package scripts | Step 20 doc check (17 docs, every `npm run` name and path) | VERIFIED | — |
| SET-02 | Environment requirements accurate (Node ≥ 18.18, Chrome only for browser checks, key only for real scripts) | Step 20 fresh copy | VERIFIED | — |
| SET-03 | Migration and setup instructions consistent with the code | Fresh-copy `db:setup` (3 migrations); `prisma migrate status` (Step 20) | VERIFIED | — |
| QA-01 | Full test suite passes on the current code | `npm test` **in this step**: 313/313 | VERIFIED | — |
| QA-02 | Typecheck, lint (0 errors) and build pass | Step 19 final run after the last code change; root typecheck in Step 20 | VERIFIED (CURRENT-EQUIVALENT) | — |
| QA-03 | Real-OpenAI E2E reflects the current code (S18) | Last run 2026-10-09 04:39Z | **PARTIALLY VERIFIED** | Not re-run after the run-count follow-up and the Step 19 UI changes. The only backend runtime change since is `analyticsService.ts`, which is covered by AN-06's checks. |

## 4. Determination: `GET /api/analytics/evaluation`

- **The code:** `backend/src/controllers/analyticsController.ts` `getEvaluation` returns only `{ success: true, message: 'Evaluation metrics endpoint - to be implemented (needs a labeled dataset)' }` to any authenticated user. The frontend never calls it.
- **The assignment** requires evaluation *metrics*: precision and recall per category, and logging accuracy. They exist and were produced by real runs (`npm run eval:cv-classification`, `npm run audit:logging-accuracy`, reports in `evaluation/`). Its dashboard list (11 items) does **not** include an evaluation view.
- **The design** (the original design proposal, then in `ARCHITECTURE.md`; replaced on 2026-10-11 by the implementation architecture and kept in git history) planned an "Evaluation tab"; it was never built.

**Classification: an incomplete, optional endpoint, not an assignment requirement** (F-13, Low). Its message is stale: the labelled dataset now exists. It is non-blocking. Step 22 options are a product decision: return the latest `evaluation/cv-classification-results.json` summary, or remove the route and its README mention.

## 5. Findings (prioritised)

### 5.1 Assignment / demo blocking

**F-01 (High): the developer's `backend/data/dev.db` is one migration behind.** **Status: RESOLVED in Step 22 (§8.1).**

- **Evidence:** `prisma migrate status` (Step 20) lists `20261008120000_usage_log_provider_response_id` as unapplied. On a copy (this step), the column is absent, `findMany` on usage logs fails, and `UsageLogService.logCall` silently writes nothing.
- **Affects:** LOG-02, LOG-06, AN-01..AN-10, the My Records tab.
- **Impact:** a demo on this database would:
  - make real, billed AI calls that leave **no usage rows**;
  - show dashboards that omit them;
  - show My Records failing with an error.
- **Fix:** with the owner's approval, run `cd backend && npm run db:migrate:deploy`; or recreate the dev database with `db:setup` (this deletes its data).
- **Tests after the fix:** `npx dotenv -e .env.local -- prisma migrate status` reports up to date; start the backend; one CV classification creates a usage row; My Records loads.
- **Blocks the final demo:** yes, if the demo uses this database. The fix is one command.

### 5.2 Important correctness / security

**F-02 (Medium; high impact, low likelihood): usage-log write failures are swallowed.** **Status: RESOLVED with residual risks in Step 22 (§8.2).** The fix chosen differs from option 1 below: failing the request was rejected because it would discard a billed result and invite a duplicate charge.

- **Evidence:** `services/usageLogService.ts` `logCall` has `catch { logger.error(...) }` "Don't throw". The copy check showed no error and no row.
- **Affects:** LOG-02 (A-log), and indirectly every analytics metric.
- **Impact:** any database failure on the log insert loses the usage record of a call that was already billed. There is no run status, API signal or dashboard indicator, so totals can be silently wrong. This contradicts "every LLM call must log" and "missing usage cannot silently produce misleading totals".
- **Fix (focused):**
  1. Make a failed usage-log write fail the request (502/500 with a safe message), or mark the run `ERROR` with a "usage not logged" reason so it is counted and visible.
  2. Add a startup check that refuses to start, or warns loudly, when migrations are pending.
- **Tests after the fix:**
  - a unit test with `prisma.llmUsageLog.create` throwing → the call is reported as failed or flagged;
  - an integration test through `/api/cv/classify`;
  - the startup check on a database missing a migration;
  - the full suite.
- **Blocks the demo:** no (after F-01).

**F-03 (Medium): no listing of agent runs.** **Status: RESOLVED in Step 22 (§8.3).**

- **Evidence:** no API route or UI lists `agent_runs`, apart from per-batch status.
- **Affects:** AUTH-06 (A-2, "Admin: … all agent runs"); the "own runs" part of AUTH-04.
- **Impact:** an evaluator who reads A-2 literally cannot browse runs, including failed runs that made no AI call, or see run ids, status and timing per run.
- **Fix (focused):** `GET /api/runs`, paginated and scoped like the other lists (own for a user, all for an admin, optional `?userId=` for an admin), plus a table in the MY RECORDS tab.
- **Tests after the fix:** isolation (user sees only their own, admin all, `?userId=` ignored for users), 401 without a token, the `verify:ui` audit on the new table, the full suite.
- **Blocks the demo:** not necessarily. It is the most likely literal-requirement objection, so do it before the demo.

### 5.3 Reliability and production hardening (non-blocking for a local academic demo)

| ID | Sev. | Confirmed evidence (this step) | Impact | Recommended Step 22 fix | Tests after |
|---|---|---|---|---|---|
| F-04 (G1) | Medium | `frontend/src/store/authStore.ts` persists access and refresh tokens to `localStorage('auth')`. Mitigations: no `dangerouslySetInnerHTML` (0 uses), React escaping, short-lived and revocable tokens. | XSS would expose both tokens | Optional: refresh token in an httpOnly SameSite cookie, access token in memory. Or at least add a CSP (F-08). | Auth, security and `verify:ui` login/logout flows |
| F-05 (G3) — **RESOLVED in Step 22 (§8.4)** | Medium | `env.ts` `JWT_SECRET: z.string().min(32)`. Both template values (37 and 73 characters) pass. | A forgotten placeholder means a publicly known signing secret, so tokens can be forged | Reject the known template values and require a minimum entropy | An env-validation unit test; the full suite |
| F-06 (G6) — **RESOLVED in Step 22 (§8.5)** | Medium | `cvBatchService.submitBatch` starts every file at once (`Promise.allSettled`), with `MAX_BATCH_FILES = 20` | Up to 20 simultaneous provider calls: rate-limit failures, cost spikes, SQLite write contention | A small concurrency limit (e.g. 3) inside the batch service | A batch test asserting peak in-flight ≤ the limit; existing batch tests |
| F-07 (G5) — **RESOLVED in Step 22 (§8.6)** | Low-Med | No startup code handles `PENDING`/`RUNNING` runs | After a restart mid-batch, runs stay "processing" forever and count as neither successful nor failed | On startup, mark stale `PENDING`/`RUNNING` runs `ERROR` ("interrupted by server restart") | A unit test of the recovery; batch-status test |
| F-08 (G2) | Low | No CSP or security-header middleware in `backend/src`; none in `frontend/index.html` | No browser-enforced restriction on script sources (defence in depth for F-04) | A CSP and basic security headers on whatever serves the built frontend, and on the API | Header assertions; `verify:ui` still passes |
| F-09 (G4) | Low | `authService.ts`: `const failedLogins = new Map(...)` | Throttling resets on restart and is per process | Acceptable locally; persist it if ever deployed with several instances | Existing throttle test |
| F-10 — **RESOLVED in Step 22 (§8.7)** | Low | Only login is throttled; `/api/cv/classify`, `/api/cv/batch` and `/api/sentiment/analyze` have no rate limit | An authenticated user can generate unbounded AI cost | A per-user rate limit on the AI endpoints | New 429 tests |
| F-14 — **RESOLVED in Step 22 (§8.8)** | Low | `MISSING_USAGE_DATA` rows and unpriced-model calls (`estimatedCost = null`) are stored correctly but not surfaced; summary totals simply exclude them | Totals can understate without any indication | Return and display counts of flagged rows and of unpriced calls in the summary | Analytics unit test; dashboard check |

### 5.4 Cosmetic, cleanup and optional

| ID | Sev. | Evidence | Recommended action |
|---|---|---|---|
| F-11 (G7) | Low | `app.ts` registers `/health` at lines 22 and 39; the second is unreachable | Remove one; keep the documented response |
| F-12 (G8) | Low | `recharts` and `lucide-react` are declared in `frontend/package.json` and imported nowhere | Remove both (a dependency change), or use them |
| F-13 | Low | `GET /api/analytics/evaluation` is a placeholder (§4) | A product decision: implement as a read-only summary, or remove |
| F-15 | Low | Only the CV JSON schema has a sync test | Add the equivalent test for `sentimentResponse.schema.json` |
| F-16 | Info | The real-OpenAI E2E runner was not re-run after the follow-ups (QA-03) | Re-run once (≈ $0.09) after the Step 22 fixes, for fresh end-to-end evidence |
| F-17 | Info | `npm audit`: 22 findings, all dev/CLI tooling (3 in the Prisma CLI chain with `--omit=dev`); `docs/DEPENDENCY_AUDIT.md` | Only major upgrades fix them; plan separately |
| F-18 | Info | The grounding check is heuristic. The real model never followed an injection, so guard rejection was exercised only by CONTROLLED tests. | Keep documented; optionally add semantic checks |
| F-19 | Info | The evaluation dataset is 27 samples (3 per category); 100% is not representative | Enlarge the dataset if accuracy claims matter |
| F-20 | Info | UI-02 limitations (browsers, devices, screen readers, arrow keys) | Optional manual testing |
| F-21 | Info | DOC-02: no commit, so no literal clone | Re-verify the setup from a clone after the first commit |
| F-22 | Low | DOC-03: the PowerShell walkthrough in `MULTI_USER_DEMO.md` was not executed | Execute it during demo preparation |

## 6. Known limitations and evidence gaps

- **Not freshly re-run in this step:**
  - real-OpenAI behaviour (cost avoided);
  - the browser checks;
  - typecheck, lint and build.

  The evidence for these is CURRENT-EQUIVALENT (§1).
- **One environment only:** Windows 10, Node 24.21.0, npm 12.0.2, headless Chrome.
- **Not tested at all:** Firefox, Safari, physical devices, screen readers.
- **No arrow-key navigation:** for the decision radio group and the tab bar.
- **Tables on phones:** wide tables scroll horizontally on small screens.
- **Fresh setup:** verified with an isolated, commit-equivalent copy, not a literal `git clone`.
- **Missing-information rows:** the dashboard does not surface rows with missing usage or unknown cost (F-14).
- **Source of the concurrency requirement:** the Step 16 instruction, not the pasted assignment text.

## 7. Recommended Step 22 order

1. **F-01:** apply the pending migration to `dev.db`, with the owner's approval, and confirm logging works on it. This unblocks the demo. **Done (§8.1).**
2. **F-02:** make usage-log write failures visible (fail or flag the run), and add a pending-migration startup check. Add tests. **Done, except the startup check, which is now F-23 (§8.2). F-23 done (§8.9).**
3. **F-03:** a scoped `GET /api/runs` and a runs table. This closes the literal A-2 clause. Add isolation tests. **Done (§8.3).**
4. **F-05:** reject placeholder JWT secrets. **Done (§8.4).**
5. **F-06 and F-07:** bound batch concurrency; recover interrupted runs. **F-06 done (§8.5); F-07 done (§8.6).**
6. **F-14:** surface rows with missing usage or unknown cost. **Done (§8.8).**
7. **Cleanup:** F-11, F-12, F-15; decide F-13.
8. **Optional hardening:** F-04, F-08, F-09, F-10. **F-10 done (§8.7).**
9. **Re-verify:**
   - `npm test`;
   - typecheck, lint and build;
   - `npm run verify:ui`;
   - `npm run verify:dashboard-run-outcomes`;
   - one real-OpenAI E2E run (F-16), to refresh QA-03 and LOG-02 evidence.

## 8. Step 22 remediation record

### 8.1 F-01: RESOLVED (2026-10-09)

The pending migration `20261008120000_usage_log_provider_response_id` was applied to `backend/data/dev.db` with the documented command, after the following checks passed:

| Check | Evidence | Result |
|---|---|---|
| Effective target | `db:migrate:deploy` = `dotenv -e .env.local -- prisma migrate deploy`. One `DATABASE_URL` in `.env.local`, a `file:` URL without credentials, resolving (relative to `prisma/`) to `backend/data/dev.db`. No process or persistent `DATABASE_URL`, no `backend/.env`, no `prisma.config.ts`. Prisma reported the datasource as `file:../data/dev.db`. | PASS |
| Backup | `backend/data/dev.db.backup` (made by the owner): 208,896 bytes, SHA-256 identical to `dev.db` (`127e2cf5fcae0857…`, also the Step 21 fingerprint); read-only `integrity_check` = ok; same row counts. Unchanged afterwards. | PASS |
| Pending migrations | `prisma migrate status`: exactly this one pending, as the audit found. SQL is additive only: `ADD COLUMN "providerResponseId" TEXT` plus one index. | PASS |
| Migration | `npm run db:migrate:deploy`: "All migrations have been successfully applied." (exit 0) | PASS |
| After | `prisma migrate status`: "Database schema is up to date!"; `integrity_check` = ok; column and index present; hand-written `llm_usage_logs_status_check` kept; every data-table count unchanged (users 4, agent_runs 4, recommendation_decisions 4, llm_usage_logs 4, cv_documents 2, cv_recommendations 2, sentiment_results 1, refresh_tokens 9, agents 2); `_prisma_migrations` 2 → 3 | PASS |
| Reads on `dev.db` | Read-only script through the app's own Prisma client: the usage-log query that failed in Step 21 returns all 4 rows; `UsageLogService.getUserStats` works; file hash unchanged by the read | PASS |
| Writes | Real `UsageLogService.logCall` on a **copy** of the migrated `dev.db` (no probe rows in the real file): row written with `providerResponseId`, correct cost; error row has `providerResponseId` null | PASS |
| Full real-OpenAI pipeline on `dev.db` (agent → OpenAI → usage row → My Records page) | Not run: needs paid calls | NOT VERIFIED |

### 8.2 F-02: RESOLVED with residual risks (2026-10-09)

**Design.** `UsageLogService.logCall` still never throws. The provider call has already happened (and, on success, been billed) when it runs, so throwing would discard a paid result, mark the run ERROR although the provider succeeded, and invite a resubmission, i.e. a duplicate charge. Instead the failure is made explicit:

- `logCall` returns `{ persisted: true, logId }` or `{ persisted: false, reason: 'DB_WRITE_FAILED' | 'AGENT_NOT_REGISTERED' }`.
- `LLMService` passes it on as `usage.usageLogPersisted` on the success result and on a thrown `LLMServiceError`. The provider `status` is unchanged.
- One structured error event per unwritten row: `event: "USAGE_LOG_WRITE_FAILED"`, with ids, model, the provider's own token counts, latency, provider response id and the database error's final cause line (at most 300 characters). It contains no prompt, CV or feedback text, provider error text, or Prisma argument dump. (The old message logged the whole Prisma error message, which can include that dump.)
- Nothing is fabricated or written for the missing call; HTTP responses are unchanged.
- Operator check, documented in `docs/USAGE_LOGGING.md`: `SUCCESS` runs with no usage rows.

**Files changed:** `backend/src/services/usageLogService.ts`, `backend/src/services/llmService.ts`, new `backend/tests/usageLogWriteFailure.test.ts`, `docs/USAGE_LOGGING.md`, this file. No schema, dependency, configuration, route or frontend change.

**Tests (CONTROLLED: stub providers, `backend/data/test.db`, no OpenAI calls).** The failures are real database failures, not mocked Prisma calls: a `runId` violating the foreign key, an unregistered agent, and a test-only SQLite trigger aborting the insert for one test user (dropped afterwards).

| Command | Result |
|---|---|
| `npx vitest run tests/usageLogWriteFailure.test.ts tests/llmService.test.ts` | 8 + 15 = 23 passed |
| `npm test` (backend) | **18 files, 321/321 passed** (313 existing + 8 new) |
| `npm run typecheck` / `npm run lint` / `npm run build` (backend) | exit 0 / 0 errors (31 warnings; none in the changed files) / exit 0 |
| `tsc` on the new test file with `src/` types (tests aren't in the backend `tsconfig`) | 0 errors in the new file |

The new tests assert:

- normal success and error rows report `persisted: true`, and `logId` is the written row;
- a failed write does not throw, returns `persisted: false`, and writes nothing;
- a successful provider call whose write fails is made exactly once and its result returned with the real tokens and `usageLogPersisted: false`;
- a failed provider call whose write fails still throws `LLMServiceError`, flagged the same way;
- exactly one event, with the expected fields and no content sentinel, key pattern or Prisma dump;
- through `POST /api/cv/documents/:id/classify`: still 201 with the same body, one provider call, no usage row, and the documented SQL check finds the run.

Prisma reports the trigger abort as `P2003` "Foreign key constraint violated", so `dbError` can mislabel the cause of an unusual failure. The event is still emitted.

**Residual risks and limitations:**

- A call whose row can't be written is still **missing from the dashboards**, with no on-screen indicator. That needs a persisted marker (a schema change) or an API/dashboard change, both out of scope here; it belongs with F-14. LOG-02 therefore stays PARTIALLY VERIFIED.
- The SQL check misses an unlogged call on a run that also has a logged call (e.g. the repair retry), and on failed runs; only the log event covers those.
- **F-23 (new, Low): no pending-migration startup check.** That was the cause of the F-01 failure mode. It was part of the original F-02 recommendation but not done here. **RESOLVED in Step 22 (§8.9).**
- **Evidence currency:** `llmService.ts` and `usageLogService.ts` changed after the real-OpenAI runs, so that evidence is now HISTORICAL for these two files. The insert data is unchanged; the change adds a return value and replaces the failure log line. Covered by 321/321 CONTROLLED tests; the real pipeline was **not** re-run (F-16).

### 8.3 F-03: RESOLVED (2026-10-09)

**Design.** It reuses the existing `agent_runs` table and relations, so there is no schema change and no migration. Authorization follows the existing usage-logs pattern: identity and role come only from `authenticateToken` (server-side session plus a database lookup).

**API** (documented in `README.md` and `docs/MULTI_USER_DEMO.md`):

- **`GET /api/runs`.**
  - Admin: every user's runs. User: always and only their own, because the server pins the query to `req.user.id`.
  - Filters: `userId` (narrows an admin's view; validated but never applied for a user), `agent`, `status` (PENDING/RUNNING/SUCCESS/ERROR).
  - Pagination: `limit` 1–100 (default 25), `offset` 0–1,000,000.
  - Strict digit and enum validation: anything else, including a repeated parameter, is a 400 `VALIDATION_ERROR`.
  - Ordered newest first. Returns `{ runs, total, limit, offset, agents }`.
- **`GET /api/runs/:id`:** the owner or an admin. Another user's run gets 403, an unknown id 404, a malformed id 400.
- **Fields per run:**
  - id, status, agent, owner `{id, email}`, timestamps (`createdAt`, `startedAt`, `completedAt`; the table has no `updatedAt`);
  - `batchId`, `cvDocumentId`, `cvFileName`;
  - a result reference (recommendation id + primary category, or sentiment id + label);
  - the number of usage-log rows (`llmCallsLogged`);
  - `isSeedData`, using the same definition as analytics (run has an `isSeedData` usage log). Seed runs are flagged, not hidden or changed.
  - For ERROR runs only, the stored safe reason.
- **Withheld:**
  - CV and feedback text, prompts, raw model output, token counts, cost.
  - The provider's own failure text: stored provider failures are shown as "The AI provider request failed.", because OpenAI's text can name the organization. The stored record is untouched.

**UI:** a new AGENT RUNS tab (`frontend/src/components/AgentRunsPanel.tsx`), shown to both roles.

- Admins see a User column and User / Agent / Status filters. Users see their own runs, with Agent / Status filters only.
- Status badges carry text labels, not only colour; seed runs carry a "Demo data" badge.
- Single vs batch source, and a result or failure-reason column.
- Per-row Details buttons (`aria-expanded` / `aria-controls`) showing the full run id, batch id, document, result id, logged AI calls and failure reason.
- Previous/Next pagination (25 per page).
- Uses the existing loading / error-with-Retry / empty components and `ScrollableTable`.

**Files:**

| Side | Files |
|---|---|
| Backend (new) | `services/agentRunService.ts`, `controllers/agentRunController.ts`, `routes/runs.ts`, `tests/agentRuns.test.ts` |
| Backend (edited) | `app.ts` (route), `utils/validators.ts` (query schema) |
| Frontend (new) | `components/AgentRunsPanel.tsx`, `services/agentRunsService.ts` |
| Frontend (edited) | `components/Dashboard.tsx` (tab), `types/index.ts` |
| Docs | `README.md`, `docs/MULTI_USER_DEMO.md`, `backend/TESTING.md`, this file |
| Evidence | `evaluation/ui-verification-results.json`, regenerated by `verify:ui` |

**Tests and checks (CONTROLLED: stub providers, no OpenAI calls):**

| Command | Result |
|---|---|
| `npx vitest run tests/agentRuns.test.ts` | **18/18** |
| `npm test` (backend) | **19 files, 339/339** (321 + 18 new; includes `auth`, `security`, `multiUserConcurrency`, analytics and usage-logging suites unchanged) |
| Backend `typecheck` / `lint` / `build` | exit 0 / 0 errors (31 warnings, unchanged; none in new files) / exit 0 |
| Frontend `typecheck` / `lint` / `build` | exit 0 / 0 problems / exit 0 |
| `npm run verify:ui` (Chrome, CONTROLLED) | **72/72** (was 64/64; the 8 new checks are the AGENT RUNS tab for admin and user at 1440/820/390/320 px: no page overflow, every control named, AA contrast, active tab announced) |
| Scratch browser check of the tab (real frontend + backend, fake provider, throwaway `e2e.db`; not committed) | **29/29**: admin sees several users, pager total = API total, page 2 and back, user/status filters, filtered empty state, failure reason, Tab reaches Details with a visible focus outline, Enter expands/collapses, seed badges match the API, simulated 500 → alert → Retry recovers, user sees only own runs (no User column/filter, `?userId=` from the browser ignored), 390 px no page overflow, no console errors |

`agentRuns.test.ts` covers:

- admin listing across users;
- `?userId=` narrowing equal to the database;
- agent/status filters and an unknown agent;
- user scope equal to the database;
- `?userId=`, filter, offset, header and body spoofing ignored for users;
- another user's run by id → 403 without leaking the email;
- empty pages;
- 18 invalid query forms → 400 for both roles;
- malformed/unknown ids;
- disjoint, ordered, bounded pages and the default limit;
- CV, batch (incl. a file rejected before any AI call) and sentiment runs (success and provider failure) against the stored rows;
- the seed flag;
- no CV/feedback/provider text, prompts or token fields in any response.

**Defect found and fixed during verification:** at 390 px the first browser run showed 505 px of page overflow. The visually hidden ("sr-only") text in the Details column is absolutely positioned and escaped the table's scroll container. Giving its header cell and buttons `position: relative` fixed it (re-run: 0 px, 29/29).

**Limitations:**

- No real-OpenAI run was made. These runs come from the same services, whose real-OpenAI evidence (§1) predates this change.
- `total` is a separate count query, so a run created between the two queries can make a page's count momentarily inconsistent. Offset paging can likewise shift by a row while runs are being created.
- `agent` matches the stored `agentName` snapshot exactly.
- The UI limitations of §6 apply: Chrome only, no arrow-key navigation, wide tables scroll inside their card on phones.
- F-14 (missing usage/pricing not surfaced on dashboards) and F-23 (no pending-migration startup check) remain **open**. The listing's `llmCallsLogged` makes a run with no logged call visible per run, but it is not a dashboard indicator and does not close F-14.

### 8.4 F-05: RESOLVED (2026-10-09)

**Before.** `JWT_SECRET: z.string().min(32)` accepted every value published in the repository:

| Published value | Where | Length |
|---|---|---|
| `your_jwt_secret_here_minimum_32_chars` | `backend/.env.example` | 37 |
| the root template value | `.env.example` | 73 |
| `your_super_secret_key_minimum_32_characters_long` | `SETUP.md` | 48 |
| `test_jwt_secret_minimum_32_characters_long_xx` | `backend/.env.test.example` | 45 |

It also accepted 32 or more whitespace characters, because length was counted before trimming.

**Change** (`backend/src/config/env.ts` only; the authentication code, token format and storage are unchanged).

`jwtSecretProblem(secret, NODE_ENV)` is applied through the existing env schema, so startup fails through the existing path (`Invalid environment variables:` then `JWT_SECRET: <reason>`, exit 1). It rejects:

- a missing value;
- a blank value;
- fewer than 32 characters after trimming surrounding whitespace;
- the three template/doc placeholders (exact, after trimming), or any value starting with `your_` or `your-`;
- the public `.env.test.example` value, unless `NODE_ENV=test`. It is allowed there because the documented test setup copies it, and it only signs tokens for the throwaway `test.db`.

The reason printed never contains the value. The secret itself is not modified (no trimming of the stored value).

**Pre-check of the real env files** (values not printed; only lengths and booleans were computed):

- `backend/.env.local`: hex-only, at least 32 characters, not a template value, so accepted. Loading the config with it gives exit 0.
- `backend/.env.test`: the published test value, so accepted under `NODE_ENV=test` only.
- Neither file was modified.

**Tests** (`backend/tests/jwtSecretConfig.test.ts`, 14):

- unit checks for every rule in development, production and test, including whitespace-padded placeholders, fill-in-the-blank variants, the test-only value per environment, and messages never containing the value;
- real-startup checks: `src/server.ts` spawned in an empty temporary directory with a minimal environment (no env file, no real secret). For missing, blank, two template placeholders, and the test-only value in development, the server exits 1 with `JWT_SECRET:` in the message, never logs "Server running", and never echoes the value;
- config loads (exit 0) with a randomly generated secret, and with the test-only value under `NODE_ENV=test`.

Secrets used are the published placeholders or random values generated per run; none is printed.

| Command | Result |
|---|---|
| `npx vitest run tests/jwtSecretConfig.test.ts` | **14/14** |
| Config load with the real `backend/.env.local` (`tsx src/config/env.ts`, output discarded) | exit 0, no `Invalid environment variables` |
| `npm test` (backend) | **20 files, 353/353** (339 + 14; includes `auth.test.ts` and `security.test.ts`, which sign and verify tokens with the configured secret) |
| Backend `typecheck` / `lint` / `build` | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0 |
| Frontend checks | Not re-run: no frontend file changed |

**Docs:**

- `backend/.env.example` and `.env.example`: a REQUIRED comment with the generate command, and a note that the placeholder is refused.
- `backend/.env.test.example`: marked test-only, refused outside `NODE_ENV=test`.
- `README.md` (setup and troubleshooting) and `SETUP.md` (quick setup, the example block, the notes): the old "long enough to pass validation, so the server starts with it" wording is replaced.

No production secret is supplied anywhere.

**Limitations:**

- This is a denylist plus a length rule, not an entropy measurement. A weak but unpublished value such as a long English phrase still passes.
- A server started with `NODE_ENV=test` accepts the public test value. That mode reads `.env.test` and is meant for the test runner.
- A future template or doc placeholder must be added to `KNOWN_PLACEHOLDER_JWT_SECRETS` (or start with `your_`).
- Already-issued tokens are unaffected for any secret that was valid before, because the stored value is not changed.

### 8.5 F-06: RESOLVED (2026-10-09)

**Before.** `submitBatch` started every file at once with `Promise.allSettled`. Each file makes its provider calls sequentially (the classification, then at most one repair retry), so a batch had up to as many calls in flight as it had files: at most 20 (`MAX_BATCH_FILES`).

**Change** (`backend/src/services/cvBatchService.ts` only; no new dependency, no schema or API change).

- **`MAX_CONCURRENT_BATCH_FILES = 3`.** Chosen as the audit's suggested value; it keeps the parallelism the real E2E run measured (peak 3), and the real E2E runner checks only `peak >= 2`.
- **`runWithConcurrencyLimit(items, limit, worker)`, a small worker pool:**
  - files are picked up in submission order, each exactly once;
  - a worker that throws is logged, and its lane continues with the next file, so nothing behind it is stranded;
  - a non-finite or < 1 limit falls back to 1 (sequential), never to "process nothing".
- **Waiting files stay `PENDING`.** The status endpoint and UI show them as Queued. Previously every file flipped to `RUNNING` at once even though it was not being worked on.
- **The cap is per batch.** Concurrent batches each get 3 slots, so one user's batch never waits behind another's.
- **Unchanged:** API contracts, ownership, per-file validation, failure reasons, usage logging and status ordering (by document id).

**Tests** (`backend/tests/cvBatchConcurrency.test.ts`, 8; CONTROLLED gated stub provider that holds every call open until the test releases it, no OpenAI calls):

1. **Pool unit tests:**
   - peak equals the limit, with items started in order;
   - a throwing worker doesn't strand queued items;
   - 0 / -2 / NaN / Infinity mean sequential;
   - an empty list completes.
2. **The cap constant is 3.**
3. **A 10-file batch:**
   - exactly 3 calls start and no more while they're held;
   - status shows processing 3, queued 7, completed 0;
   - releasing one call starts exactly FILE-04, and status shows completed 1, processing 3, queued 6;
   - draining one call at a time keeps active ≤ 3 throughout (peak 3);
   - every file starts exactly once;
   - final status is 10/10 completed, items in file order, 10 recommendations;
   - 10 usage rows with distinct provider ids and the stub's token counts.
4. **Mixed batch of 9:**
   - the files: unsupported type, too short, binary, two provider 503s, one invalid output that triggers the repair retry, three valid;
   - peak ≤ 3 and ≥ 2;
   - rejected files make no provider call;
   - the repair file is called twice;
   - each file gets its own correct reason;
   - usage rows: 0 for rejected files, 1 SUCCESS for valid files, 1 ERROR `HTTP_503` for provider failures, 2 for the repair file;
   - 3 recommendations.
5. **Two users' batches at once:**
   - both reach their own cap (6 calls held, each batch processing 3 / queued 2);
   - neither ever exceeds 3 running;
   - all runs, recommendations and usage rows belong to the right user.

**Mutation check:** with the limit temporarily replaced by `entries.length` (the old unbounded behaviour), tests 3–5 fail (3 failed, 5 passed). The file was restored byte-for-byte (`cmp`).

| Command | Result |
|---|---|
| `npx vitest run tests/cvBatchConcurrency.test.ts` (×3, for flakiness) | 8/8 each time |
| `npx vitest run` on the batch, concurrency, multi-user, LLM service, usage-log failure, logging-accuracy and agent-runs suites | 7 files, **93/93** |
| `npm test` (backend) | **21 files, 361/361** (353 + 8) |
| Backend `typecheck` / `lint` / `build` | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0 |
| Frontend | No file changed; the batch view already renders Queued badges and counts, so it was not re-run |

**Docs:** `docs/BATCH_CV_PROCESSING.md` (per-file processing, verification table, limitations), `docs/DATABASE.md`, `backend/TESTING.md`, `README.md` (batch summary, test counts).

**Limitations:**

- **Per batch, not process-wide.** N simultaneous batches can have 3·N calls in flight, and single-CV and sentiment requests are not limited. A per-user or global AI limit is F-10, still open.
- **No real-OpenAI run.** A provider rate limit can still fail a file, with the provider's reason.
- **Order is guaranteed for pickup only.** Files started in the same moment may reach the provider in a different order, because each first marks its run `RUNNING`.
- **A 20-file batch now takes longer:** about 7 rounds of provider latency instead of 1.
- **F-07 still applied at the time:** a restart mid-batch left queued and running files `PENDING`/`RUNNING`. Resolved in §8.6.

### 8.6 F-07: RESOLVED (2026-10-09)

**Inspection: which persisted states can be stranded.** All agent work runs inside the backend process; a stopped process leaves:

| State | Written by | Provider call possible? | Input persisted? |
|---|---|---|---|
| `PENDING` | Queued batch files (`cvBatchService`) | No: the run is set `RUNNING` before any call | CV text and file name, yes; **MIME type no** (the per-file type check needs it) |
| `RUNNING` | Batch file in progress, single CV classification, sentiment analysis (created inside the request) | Yes: a billed call may have completed or be cut off | Sentiment feedback text **no** (saved only on success) |

`SUCCESS`/`ERROR` are terminal. No other non-terminal state exists (`RunStatus` has these four values).

**Design: fail closed at startup, no resumption, no migration.**

Resumption isn't safe:
- the inputs aren't fully persisted;
- a `RUNNING` run may already have been billed (risk of a duplicate call);
- it would make AI calls nobody requested at that time.

`recoverInterruptedRuns(createdBefore)` (new `backend/src/services/runRecoveryService.ts`) runs in `src/server.ts` **before `app.listen`**, with `createdBefore` set to the process start time. In one transaction it applies two conditional `updateMany` calls:

- `PENDING` and `createdAt < start` becomes `ERROR`, "Not processed: the backend restarted before this file was started, so no AI call was made. Please upload it again."
- `RUNNING` and `createdAt < start` becomes `ERROR`, "Interrupted: the backend restarted while this run was in progress. It was stopped and not retried; please submit it again."

In both cases `completedAt` is set to the recovery time. The existing columns suffice, so no schema change was needed.

- Logs `INTERRUPTED_RUNS_RECOVERED` (counts plus up to 20 run ids).
- If the check fails, the error is logged and startup continues. Startup migration checks remain F-23. *(Since §8.9, a missing, unmigrated or unreadable database is refused before recovery runs; a recovery failure on a current schema still only logs.)*
- Never touches terminal runs, owners, batch ids, documents or usage logs.
- Never creates usage rows or calls a provider.
- Covers all agents (batch, single CV, sentiment), since all can be stranded.
- `server.ts` gained an async `start()` (the `ES2020` module setting disallows top-level `await`).

**Tests** (`backend/tests/runRecovery.test.ts`, 7; no provider, with a counting stub installed to prove it):

- **Fixtures:** for two users, the states a killed process leaves (2 queued batch files, a running batch file with an already-logged call, a running single CV, a running sentiment) next to `SUCCESS`/`ERROR` runs with usage rows and a recommendation, plus `PENDING`/`RUNNING` runs created **after** the cutoff.
- **Every interrupted run** of both users gets the right status and reason, with a `completedAt`. Owners and batch ids are unchanged, and there are 0 provider calls.
- **Terminal runs** stay deep-equal. Runs after the cutoff are untouched. Usage logs stay deep-equal (none added, removed or changed). Recommendations are unchanged.
- **Idempotent:** a second call returns `{queued: 0, running: 0}`, and every row is deep-equal to after the first call (`completedAt` not overwritten).
- **Analytics:** `/api/analytics/summary` is deep-equal before and after. `/api/analytics/runs` `successful` is unchanged and `failed` grows by exactly the recovered runs.
- **API views:** batch status shows 100%, queued 0, processing 0, with each file's reason. `GET /api/runs/:id` shows the reason. The other user still gets 403 on both.
- **Real startup:** `node --import tsx src/server.ts` against `test.db` (no OpenAI key, random port). The `INTERRUPTED_RUNS_RECOVERED` log appears **before** "Server running", the fixtures are recovered, and terminal runs and usage rows are unchanged.
- **Real startup with a failing check:** an empty temporary directory, a minimal environment and an empty SQLite file (no `agent_runs` table). The failure is logged before "Server running", and the server still starts.

**Mutation checks** (each file restored byte-for-byte with `cmp`):

| Mutation | Result |
|---|---|
| Recovery call removed from `server.ts` | The startup test fails |
| Conditions removed from the updates | All 5 in-process tests fail |

The second mutation briefly marked every run in the throwaway `test.db` as `ERROR`. Test files create their own fixtures, and every later full-suite run passed. `dev.db` was not involved.

**Test robustness fix found during verification.** One full-suite run (1 of 7) failed `cvBatchConcurrency.test.ts` › "mixed failures"; the failure detail wasn't captured, and the next 6 runs passed. That F-06 test had two timing-dependent parts: `peak >= 2`, which relied on two calls arriving within a 15 ms window under load, and the default 5 s test timeout. It now waits deterministically for the 3 calls that reach the provider without any release (files 1 and 4 are rejected without a call) and asserts `peak === 3`, which is stronger. The three HTTP-level batch tests have an explicit 30 s timeout. No assertion was weakened.

| Command | Result |
|---|---|
| `npx vitest run tests/runRecovery.test.ts` (×2 after the final edit) | **7/7** each |
| `npx vitest run tests/cvBatchConcurrency.test.ts` (×3 after the robustness fix) | 8/8 each |
| Batch, concurrency, multi-user, LLM service, usage-log failure, agent-runs, analytics and JWT-config suites | 8 files, **119/119** (before the final recovery-test addition) |
| `npm test` (backend) | **22 files, 368/368**, twice after the final edit (and 367/367 three times before the startup-failure test was added) |
| Backend `typecheck` / `lint` / `build`; `tsc` on the new/changed test files with `src/` types | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0; 0 errors in the test files |
| Frontend | No file changed; it already shows the stored reasons, so it was not re-run |

**Docs:** `docs/BATCH_CV_PROCESSING.md` (a new "Restart recovery" section, limitations, verification table), `docs/ANALYTICS_API.md` (failed-run definition), `README.md` (limitations, test counts), `backend/TESTING.md`.

**Limitations:**

- **Interrupted work is not resumed.** Users must resubmit, and the reason tells them to.
- **A call cut off mid-flight has no usage row.** OpenAI may still have billed it, but no usage data was ever received, and none is invented.
- **One backend process per database is assumed.** A second backend started against the same database would fail the first one's in-progress runs. Fixing this needs a process/lease identifier, which means a schema change, and was not done.
- **No interval sweep.** A run stranded while the process keeps running (for example, if its final `ERROR` update itself failed) is recovered only at the next restart.
- **`completedAt` of a recovered run is the recovery time,** not the moment the work stopped (that moment is unknown).
- **Analytics count recovered runs as failed runs.** No dashboard shows how many were interrupted (related to F-14, still open).
- **Only `src/server.ts` runs recovery.** Verification scripts that import `app.ts` directly do not, and they use their own throwaway databases.
- **No real-OpenAI run was made.**

### 8.7 F-10: RESOLVED (2026-10-09)

**Inspection.**

- **Before:** the only throttle was the in-memory login counter (`authService.ts`). There was no rate-limit dependency (`express-rate-limit` is not installed). `Errors.tooManyRequests` already produced the 429 shape `{success, error, code: "TOO_MANY_REQUESTS"}`.
- **Endpoints that start AI work:**
  - `POST /api/cv/documents/:documentId/classify` (1 run);
  - `POST /api/cv/classify` (upload + classify, 1 run);
  - `POST /api/cv/batch` (1 run per file, at most 20);
  - `POST /api/sentiment/analyze` (1 run).
- **Endpoints that make no AI calls:** upload-only `POST /api/cv/documents`, decisions, imports, results, batch status, runs, usage logs and analytics.

**Design** (new `backend/src/middleware/aiRateLimit.ts`; no new dependency, no new service).

- **Placement and keying.** `aiRateLimit()` is mounted on exactly those four routes, after the routers' `authenticateToken`/`requireUser`. It is keyed **only** by `req.user.id`, which comes from the server-side session lookup. Query, header and body values (including `userId`, `X-User-Id`, `X-Forwarded-For`) and new sessions for the same user share or don't affect the budget.
- **Counting.** It counts **AI runs, not requests**: a batch costs one unit per file, so batches cannot get around the limit. Units are capped at `MAX_BATCH_FILES` (20) so an over-size batch keeps its existing 400. All four endpoints share one budget, and admins are limited like everyone else.
- **Sliding window.** A unit frees up exactly one window after use. The reservation is synchronous, so concurrent requests cannot overshoot.
- **Over the limit:** 429 with header `Retry-After: N`, error `Too many AI requests: the limit is M AI runs per <window>. Try again in N seconds.`, `code: "TOO_MANY_REQUESTS"` and `details.retryAfterSeconds`. No document, run, usage row or provider call is created.
- **A request larger than the whole limit** gets a 429 explaining why, without `Retry-After`.
- **Refunds.** A 4xx response (validation, not found, not owner) gives its units back when the response finishes, since no AI work started. A 5xx keeps them: a 502 means the provider was called.
- **Defaults:** `AI_RATE_LIMIT_MAX_RUNS=60` per `AI_RATE_LIMIT_WINDOW_SECONDS=600`, both optional in `env.ts`. Invalid values (0, negative, non-integer, text) stop startup through the existing env validation.
- **Why these defaults:** about one full 20-file batch plus normal single use every 3–4 minutes. It bounds a single user to roughly 60–120 provider calls (≈ $0.25–0.50 at the gpt-4o prices in use) per 10 minutes. The real E2E runner's busiest user starts about 14 runs.
- **In memory, per process:** it resets on restart and is not shared between processes. Distributed enforcement would need a shared store such as Redis, which this single-process SQLite architecture does not have. It is not claimed.

**Test configuration.** `security.test.ts` starts dozens of AI runs for one user within seconds (it is not about rate limits), and with the real default it failed 6 tests with 429. `vitest.config.ts` therefore sets `AI_RATE_LIMIT_MAX_RUNS=100000` for the **test runner only**. `.env.test` and production are unchanged, and no existing assertion was changed. The new tests install their own limiter and check the real defaults in a child process. The CONTROLLED browser checks were re-run with the normal defaults (below).

**Tests** (`backend/tests/aiRateLimit.test.ts`, 19; CONTROLLED stub providers; fake clock, so window tests don't wait on wall-clock time; a fresh limiter per test):

- **Limiter unit tests:**
  - the limit, and `Retry-After` = time until the oldest unit expires;
  - sliding-window boundaries at 59.999 s and 60 s;
  - weighted units waiting for enough units to expire (50 s vs 60 s);
  - a request larger than the limit is never allowed;
  - users are independent;
  - a release is applied exactly once.
- **HTTP (limit 3 per minute):**
  - below the limit, 201; above it, the exact 429 body plus `Retry-After`, with document, run, usage-row and provider-call counts unchanged;
  - all four endpoints share the budget, and upload, results, runs, usage logs and analytics are unaffected;
  - users and the admin each have their own budget;
  - `?userId=` / body `userId` / `X-User-Id` / `X-Forwarded-For` / a new login don't bypass it, and another user's budget isn't charged;
  - the window resets (`Retry-After` 40 s, then 1 s, then allowed, then 20 s);
  - unauthenticated requests get 401, never 429, and use no budget;
  - batch weighting (3 of 5, then a refused 3-file batch creating nothing, then an exactly-fitting 2);
  - an over-limit batch gets a 429 without `Retry-After`; a 25-file batch keeps its 400;
  - 400/404/403 rejections are refunded;
  - three 502s keep their charge;
  - 6 concurrent requests give exactly 3 × 201 and 3 × 429, with +3 runs, +3 usage rows and +3 provider calls.
- **Configuration (child process, minimal env):** defaults 60/600 and overrides apply. `0`, `lots`, `-5` and `1.5` stop startup (exit 1, the variable named).

**Mutation checks** (each restored byte-for-byte with `cmp`):

| Mutation | Result |
|---|---|
| Limiter removed from `POST /api/cv/classify` | 9 tests fail |
| Keyed on the client's `X-User-Id` header | The spoofing test fails |

| Command | Result |
|---|---|
| `npx vitest run tests/aiRateLimit.test.ts` (×3) | **19/19** each |
| Auth, security, multi-user, batch, batch-concurrency, CV, sentiment, LLM service, usage-log failure, agent-runs and recovery suites | 11 files, **204/204** |
| `npm test` (backend, ×2) | **23 files, 387/387** (368 + 19) |
| Backend `typecheck` / `lint` / `build`; `tsc` on the new test file with `src/` types | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0; 0 errors |
| `npm run verify:ui` (CONTROLLED, Chrome, **default** limit) | **72/72** |
| `npm run verify:dashboard-run-outcomes` (CONTROLLED, **default** limit) | **44/44** |
| Real-OpenAI scripts | Not run (paid). Statically, the E2E runner's busiest user starts about 14 AI runs, and its 4xx edge cases are refunded. |
| Frontend | No file changed. The UI already shows the server's `error` text for any failed request, so a 429 shows the "Try again in N seconds" message. |

**Docs:**

- `README.md`: env table, an "AI rate limit" rule, the 429 row, test counts.
- `backend/.env.example` and `SETUP.md`: optional variables, commented out.
- `docs/BATCH_CV_PROCESSING.md`: whole-batch refusal, limitations.
- `backend/TESTING.md`: the test row, and why `vitest.config.ts` raises the limit for tests.

**Limitations:**

- **Not distributed.** The limit is in memory and per process: it resets on restart, and several processes would each allow the full budget.
- **Counts AI runs, not provider calls.** A run that needs the repair retry makes 2 calls for 1 unit.
- **Rejected batch files still count.** Per-file rejections inside an accepted batch (wrong type, too short) cost their unit, though they make no AI call.
- **Checked before body validation.** A user who is over the limit gets 429, not 400, for an invalid request.
- **Global spend is not capped.** There is no global (all-users) limit, and no per-IP limit for AI endpoints (they require authentication).
- **Existing tests run with a raised limit.** Only `aiRateLimit.test.ts` and the browser checks exercise realistic budgets.
- **No real-OpenAI run was made.**

### 8.8 F-14: RESOLVED (2026-10-09)

**Inspection: how incomplete data was represented.** Token and cost totals were plain sums (`getTokenSummary`, by-agent, by-user) with nothing saying when they were incomplete:

| Case | Stored as | Effect on totals before F-14 |
|---|---|---|
| Provider returned no usage | `SUCCESS` row, 0/0 tokens, `errorCode = MISSING_USAGE_DATA` | Added as **zero**: silently undercounted |
| Model without a price | real tokens, `estimatedCost = NULL` | Cost **skipped** by `SUM`: silently undercounted |
| Usage-log write failed (F-02) | no row; `SUCCESS` run | Missing from every total; only a server log event |
| Interrupted by a restart (F-07) | `ERROR` run with the "Interrupted…" reason; maybe no row | Any cut-off call is unknown |
| Provider error | `ERROR` row, 0 tokens | A **known** zero (documented); correct as is |

**Design** (smallest change; existing response shapes unchanged; additions only):

- **One shared definition** of each signal (`backend/src/services/usageCompleteness.ts`): `USAGE_UNKNOWN`, `COST_UNKNOWN`, `NO_USAGE_LOGGED`, `INTERRUPTED`. These are Prisma conditions on the existing run/log relationships, with no schema change. Seed rows are excluded, and provider errors are not flagged.
- **New `GET /api/analytics/usage-completeness`.** It returns `callsWithUnknownUsage`, `callsWithUnknownCost`, `successfulRunsWithoutUsageLog`, `interruptedRuns`, `affectedRuns` and `complete`.
  - Scoped like every other metric: a user sees their own counts, and `?userId=` is ignored for them; an admin sees everyone, or one user with `?userId=`.
  - An admin's all-users response adds `byUser` (counts, user id and email; only users with an issue).
  - Counts only: no text, errors or content.
- **`GET /api/runs`** adds `usageIssues` to every run (derived server-side; no token or cost values returned) and a validated `?usage=incomplete` filter using the same conditions, so its `total` equals `affectedRuns`.
- **Totals stay recorded sums.** They are never adjusted, and nothing is written or estimated for missing calls.
- **UI:**
  - **Overview:** the token and cost cards are labelled "Recorded usage only - incomplete" / "Known costs only - incomplete". An amber `role="status"` panel lists each non-zero gap in plain words, gives the affected-run count with how to find them (AGENT RUNS, Usage data: Incomplete only), and, for admins, adds a per-user table. When nothing is missing, a one-line "Usage data complete" note is shown.
  - **AGENT RUNS:** a "Usage data" filter, a "Usage incomplete" badge, and the issue explanation in each run's details.

**Files:**

| Side | Files |
|---|---|
| Backend (new) | `services/usageCompleteness.ts`, `tests/usageCompleteness.test.ts` |
| Backend (edited) | `services/analyticsService.ts`, `controllers/analyticsController.ts`, `routes/analytics.ts`, `services/agentRunService.ts`, `utils/validators.ts` |
| Frontend (new) | `components/analytics/UsageCompletenessNotice.tsx`, `utils/usageIssues.ts` |
| Frontend (edited) | `components/analytics/OverviewSection.tsx`, `components/AgentRunsPanel.tsx`, `services/analyticsService.ts`, `types/index.ts` |
| Docs | `docs/ANALYTICS_API.md`, `docs/USAGE_LOGGING.md`, `README.md`, `backend/TESTING.md`, this file |

**API tests** (`backend/tests/usageCompleteness.test.ts`, 13; CONTROLLED stub providers). Every case is produced through the real path:

- a provider without usage, which gives the real `MISSING_USAGE_DATA` row;
- an unpriced model;
- a usage-log insert blocked by a test-only SQLite trigger during a real classify;
- a `RUNNING` run failed by the real `recoverInterruptedRuns`;
- a provider 503.

They assert:

- **Nothing fabricated:** the unlogged and interrupted runs have **no** usage row (not a 0-token or 0-cost one), before and after reading analytics and runs. The missing-usage row is stored flagged, not as a plain zero.
- **Totals unchanged:** they are exactly the recorded sums (1000/160 tokens, 4 calls, the cost of the priced call only).
- **Counts:** exact per user (A: 1/1/1/1, 4 affected; B: 1 unknown-usage, 1 affected; C: complete). The provider failure counts as a known zero.
- **Scoping:** `?userId=` is ignored for users. The admin aggregate and `byUser` are exact for both users and omit C, the global totals equal the sum of `byUser`, and an admin drill-down equals the user's own view.
- **Safety:** 401 without a token; no CV text or failure text in the responses.
- **Runs listing:** `?usage=incomplete` returns exactly the 4 affected runs with the right `usageIssues`, and complete or failed runs show `[]`. It is scoped per user and admin-filterable, an invalid `usage` value is a 400, and no token, cost or CV fields appear.

**UI tests** (scratch browser check, `usage-completeness-screen.test.cjs`; not committed). It uses the real frontend and backend with a fake provider (priced `gpt-4o`, plus markers for no usage and unpriced), a blocked-insert trigger and one startup-recovered run, on a throwaway seeded `e2e.db`. **21/21:**

- the seeded users start complete;
- the API counts are as expected;
- **user2 (complete):** a "Usage data complete" note, with no warning and no "incomplete" labels;
- **user1:** the warning is a status region listing each gap with the API counts and "3 runs are affected", with no per-user table. The cards are labelled recorded-only and known-costs-only, and the displayed totals equal the API's recorded totals;
- **AGENT RUNS:** badges on exactly the 3 affected runs; "Incomplete only" shows exactly the API's 3 runs, each badged, and the details explain each issue; no CV text on the page;
- **admin:** the per-user table lists user1 (1 1 1 0 3) and user3 (0 0 0 1 1) and not user2, and the global warning includes the interrupted run;
- **390 px:** no horizontal page scroll (screenshot checked);
- no console errors.

**Mutation checks** (each restored byte-for-byte with `cmp`):

| Mutation | Result |
|---|---|
| "Successful run without usage log" condition removed | 4 tests fail |
| Missing-usage rows treated as known | 6 tests fail |

| Command | Result |
|---|---|
| `npx vitest run tests/usageCompleteness.test.ts` | **13/13** |
| Completeness, analytics, agent-runs, LLM service, usage-log failure, logging-accuracy, recovery, multi-user, security and auth suites | 10 files, **199/199** |
| `npm test` (backend, ×2) | **24 files, 400/400** (387 + 13) |
| Backend `typecheck` / `lint` / `build`; `tsc` on the new test file | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0; 0 errors |
| Frontend `typecheck` / `lint` / `build` | exit 0 / 0 problems / exit 0 |
| `npm run verify:ui` (CONTROLLED, Chrome) | **72/72** (it audits the changed Overview and the new filter for contrast, names and overflow at 4 widths) |
| `npm run verify:dashboard-run-outcomes` (CONTROLLED) | **44/44** |
| Browser check above | **21/21** |

**Limitations:**

- **Some losses are undetectable from stored data:** a lost usage row on a run that also has a logged call (e.g. a repair-retry row), or on a failed run that wasn't interrupted. Only the `USAGE_LOG_WRITE_FAILED` log event shows these. LOG-02 therefore stays PARTIALLY VERIFIED.
- **The size of the gap is unknown:** the counts say how many calls/runs are affected, not how many tokens or dollars are missing (that is unknown by definition).
- **`INTERRUPTED` may over-report:** it flags every recovered in-progress run, including ones cut off before any provider call. Which is which can't be known.
- **Only the Overview is labelled:** the by-agent and by-user token tables are not labelled individually, but the Overview warning and the admin per-user table cover the same scope.
- **The UI check is a scratch harness,** not a committed script. `verify:ui`'s data set has no incomplete usage, so it only audits the "complete" state of the Overview.
- **No real-OpenAI run was made.**

### 8.9 F-23: RESOLVED (2026-10-10)

**Inspection.**

- **Startup path:** env validation (module load), then F-07 run recovery, then `app.listen`. Nothing compared the database with the code; F-01's missing column surfaced only as failing queries and silently lost usage rows.
- **Prisma:** `prisma` (the CLI) is a **devDependency** and `@prisma/client` the only runtime one. A startup check that shells out to `prisma migrate status` would therefore break `npm start` on a production install without dev dependencies, and would add CLI start-up time. `BACKEND_ROOT` resolves to `backend/` from both `src/` and `dist/`, so `prisma/migrations/` is found in development and in the built app.
- **History table:** `_prisma_migrations` (Prisma's own history: `migration_name`, `finished_at`, `rolled_back_at`, …) was inspected read-only on `test.db`.

**Detection method** (new `backend/src/db/migrationCheck.ts`; read-only; no new dependency, no schema change).

`checkMigrations` lists the checked-in migrations (every folder in `prisma/migrations/` with a `migration.sql`) and reads `_prisma_migrations` through the runtime client (`prisma.$queryRawUnsafe`). It mirrors Prisma's rules: a row with `finished_at` set and `rolled_back_at` empty means applied; a row with neither means failed or unfinished. It returns OK, or one of:

| Reason | When | The message tells the operator |
|---|---|---|
| `PENDING` | a checked-in migration is not applied (including a rolled-back one) | the migration names, to back up, and to run `cd backend && npm run db:migrate:deploy` (`db:migrate:test` under `NODE_ENV=test`) |
| `NOT_INITIALIZED` | the DB file doesn't exist (detected **without connecting**, so no empty file is created), or it has no history table | `cd backend && npm run db:setup` (`db:reset:test` for tests) |
| `FAILED` | a failed or unfinished history row | fix it with Prisma `migrate resolve` |
| `UNKNOWN_APPLIED` | an applied migration with no local folder (the database is newer than the code) | use code that matches the database |
| `UNVERIFIABLE` | the migrations folder is missing or empty, or the history can't be queried | **fails closed**; check `DATABASE_URL`. Only a Prisma error code is shown, never the raw error. |

The database is named by its path under `backend/` (`data/dev.db`) or its file name, **never by the connection string**.

**Startup** (`backend/src/server.ts`): the order is now **schema check → run recovery → `app.listen`**.

- **On failure:** it prints `Refusing to start: <message>`, logs `DATABASE_SCHEMA_CHECK_FAILED` (reason and migration names), disconnects Prisma and exits 1. It never listens, never runs recovery, and never modifies the database.
- **On success:** it logs `Database schema is up to date (N migrations applied)`.
- **Unexpected errors:** if the check throws, the result is treated as `UNVERIFIABLE`. There is no bypass switch: a fail-closed default with no override was the requested behaviour, and no architectural reason against it was found.
- **New export:** `src/db/client.ts` now exports `DATABASE_FILE_PATH` (the resolved file the client opens), so the check inspects exactly that file.

**Tests:** `backend/tests/migrationCheck.test.ts`, 15. There are no real-provider calls; real temporary SQLite files are used, never `dev.db`.

- **Unit tests** (temporary SQLite files via `node:sqlite` and temporary migration folders; each check asserts the file's SHA-256 is unchanged):
  - current passes;
  - pending names the migrations, plus the deploy command and backup advice (and the test command under `NODE_ENV=test`);
  - a rolled-back migration counts as pending, and one re-applied after a rollback counts as applied;
  - failed blocks;
  - unknown applied blocks;
  - no history table points to `db:setup`;
  - a missing file triggers 0 queries and is not created;
  - a throwing query or a garbage file is `UNVERIFIABLE`, and the message shows the code but not the raw error text (no `hunter2`/`file:`);
  - a missing or empty migrations folder is `UNVERIFIABLE`;
  - the database naming is checked;
  - the real repository's 3 migrations are listed, and `test.db` is current through the app's Prisma client.
- **Real `src/server.ts` startups** (minimal environment, empty cwd, random port; databases are `VACUUM INTO` copies of the migrated `test.db`, or temp files):
  - **current:** listens, and the log order is schema OK, then recovery, then "Server running";
  - **pending** (latest history row deleted in the copy): exit 1, never listens, no recovery log, the message names `20261008120000_usage_log_provider_response_id` and `npm run db:migrate:deploy`, it emits `DATABASE_SCHEMA_CHECK_FAILED`, it shows no connection string, and the file is **byte-identical** afterwards;
  - **missing DB:** exit 1, the `db:setup` message, and the file is not created;
  - **unreadable DB:** exit 1, "Could not read the migration history", and the file is unchanged.

**Existing test adapted (reported, not weakened).** The F-07 test "a failing recovery check is logged and does not block startup" used a nonexistent, empty database to make recovery fail. Since F-23 that database is correctly refused **before** recovery, so the test failed (`Refusing to start: The database empty.db does not exist`). The property it protects is unchanged. It now uses a `VACUUM INTO` copy of the migrated `test.db` whose `agent_runs` table is renamed: the schema check passes and the recovery query fails. All original assertions are kept, and it additionally asserts that the schema check passed first. `docs/BATCH_CV_PROCESSING.md` was updated to match.

**Mutation checks** (each restored byte-for-byte with `cmp`):

| Mutation | Result |
|---|---|
| `server.ts` ignores the check result | 3 startup tests fail |
| The check ignores pending migrations | 3 tests fail |

**Real `dev.db`, read-only.** `checkMigrations` was run through a **read-only** `node:sqlite` handle (no Prisma client): `{"ok":true,"applied":3}`. The SHA-256 and size were identical before and after (`c7829dac58052aef…`, 212,992 bytes). `npm run dev` therefore still starts on it. No migration was applied.

| Command | Result |
|---|---|
| `npx vitest run tests/migrationCheck.test.ts` | **15/15** |
| `npx vitest run tests/runRecovery.test.ts` (×2, after adapting) | 7/7 each |
| Migration-check, recovery, JWT-config (spawns `src/server.ts`), AI rate-limit, auth, security and multi-user suites | 7 files, **173/173** |
| `npm test` (backend) | **25 files, 415/415**, three times (twice before and once after the test-typing fix) |
| Backend `typecheck` / `lint` / `build` | exit 0 / 0 errors (31 warnings, unchanged; none in the changed files) / exit 0 |
| `tsc` on the new and changed test files with `src/` types | 0 errors (after replacing a `node:sqlite` type import, which the installed `@types/node` predates, with a local interface) |
| Frontend; `verify:ui`; `verify:dashboard-run-outcomes` | Not re-run: no frontend file changed, and the verify scripts import `app.ts` directly and migrate their own databases, so they don't pass through `server.ts` |

**Docs:**

- `README.md`: a startup-check note, three troubleshooting rows, test counts.
- `SETUP.md`: "after pulling new migrations".
- `docs/DATABASE.md`: a new "Startup migration check" section.
- `docs/BATCH_CV_PROCESSING.md`: recovery now runs after the check.
- `backend/TESTING.md`: the test row.

**Limitations:**

- **No checksum check.** A `migration.sql` edited after being applied is not detected. Prisma's checksum compares file bytes, and Windows line-ending conversion would cause false refusals.
- **History, not structure.** Like `migrate status`, the check compares migration history only. A schema changed by hand (e.g. a manual `ALTER TABLE`, or the renamed table in the adapted F-07 test) passes it.
- **Only `src/server.ts` (dev, start and the built `dist/server.js`) is checked.** Verification and evaluation scripts import `app.ts` and manage their own throwaway databases.
- **Applying migrations stays manual by design.** The check only reports; the operator runs the documented command.
- **No bypass.** A deliberately outdated database cannot be served without migrating it.
- **No real-OpenAI run was made** (none is needed for this change).
