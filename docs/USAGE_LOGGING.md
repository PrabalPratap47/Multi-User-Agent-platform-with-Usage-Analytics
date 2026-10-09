# Usage Logging Design

This document describes how LLM calls are made, measured, and logged in this
platform. The short version: **every** call to the LLM provider goes through
one centralized service (`LLMService`), which is the only code in the
repository allowed to call the OpenAI SDK directly, and the only code
that writes to `llm_usage_logs`.

## Why centralize it

Scattering provider calls across each agent means every agent has to get
token extraction, cost calculation, latency measurement, and error logging
right independently - and inevitably one of them drifts (an agent that
forgets to log, or that estimates tokens from string length because that's
easier than reading the real field). Centralizing it means there is exactly
one place to audit for correctness, and agents can't bypass logging even by
accident, because the only way to reach the provider is through this service.

## Where it lives

| File | Responsibility |
|---|---|
| `backend/src/services/llmService.ts` | Calls the provider, extracts usage, measures latency, delegates persistence |
| `backend/src/services/usageLogService.ts` | Writes/queries `llm_usage_logs` rows |
| `backend/src/config/modelPricing.ts` | The only place per-token prices live |
| `backend/src/utils/costCalculator.ts` | Multiplies actual token counts by the configured price - nothing else |

## The contract: `LLMService.call()`

```ts
const result = await llmService.call({
  systemInstructions: 'You are a CV classifier...', // fixed agent instructions, never user input
  userContent: cvText,                               // the (already-escaped) user-provided content
  agentName: 'CV Classification Agent',
  context: { userId, userEmail, userRole },           // the AUTHENTICATED caller - never a client-supplied id
  runId,                                              // the AgentRun this call belongs to, if one exists yet
  model: 'gpt-4o',                                     // optional, defaults to config.OPENAI_MODEL
  maxTokens: 1024,                                    // optional
});

// result.responseText -> the model's text output, for the agent to parse/validate
// result.usage -> { inputTokens, outputTokens, model, latencyMs, status, runId, usageDataMissing?, usageLogPersisted }
```

Every one of those input fields maps directly to the requirement this
service exists to satisfy: system instructions and user content are kept
separate (the agent's instructions can never be overridden by content that
flows through `userContent` - see the prompt-injection notes in
`promptInjectionDefense.ts`); `context` is how the log row gets attributed
to the real authenticated user, not a value the agent could fake; `runId`
ties every LLM call back to the `agent_runs` row ("the request/run
identifier") so retries on the same run are traceable.

## Token extraction: the one rule that matters most

> Token counts come from `response.usage.prompt_tokens` /
> `response.usage.completion_tokens` - OpenAI's own Chat Completions usage
> field - and from nowhere else. There is no code path in this service
> that measures string length, counts words, or runs a tokenizer to
> approximate a count.

Concretely, in `llmService.ts`:

```ts
const rawInputTokens = response.usage?.prompt_tokens;
const rawOutputTokens = response.usage?.completion_tokens;
const hasCompleteUsage = typeof rawInputTokens === 'number' && typeof rawOutputTokens === 'number';
const usageDataMissing = !hasCompleteUsage;

// A partial usage object counts as missing: both counts are recorded as 0.
const inputTokens = hasCompleteUsage ? rawInputTokens : 0;
const outputTokens = hasCompleteUsage ? rawOutputTokens : 0;
```

If the provider's response doesn't include a usable `usage` object (missing
entirely, or missing one of the two fields), the service does **not** fall
back to an estimate. Instead:

- `inputTokens`/`outputTokens` are recorded as `0` (not a guess - a known
  absence of data, nothing more).
- The log row is still written as `status: SUCCESS` (the generation itself
  succeeded) but with `errorCode: MISSING_USAGE_DATA` and an explanatory
  `errorMessage`, so the row is auditable and visibly flagged rather than
  silently treated as "0 tokens used."
- The same flag is surfaced to the caller as `result.usage.usageDataMissing: true`,
  so an agent (or a future dashboard) can distinguish "this call really
  used 0 tokens" (impossible in practice) from "we don't actually know."

This is deliberately a data-integrity signal, not a failed-call signal -
`status` stays reserved for whether the provider call itself succeeded or
failed, which is a different question answered below.

## Error handling

If the provider call throws (network failure, rate limit, 4xx/5xx, etc.):

1. Latency is measured up to the point of failure.
2. A log row is written with `status: ERROR`, `inputTokens: 0`,
   `outputTokens: 0` (a failed call has no usage to report - again, never
   estimated), and `errorCode`/`errorMessage` derived from the thrown error
   (an HTTP status becomes `HTTP_<code>`; otherwise the error's `name`).
3. **Then**, and only then, the service throws `LLMServiceError` (which
   carries the same usage/error metadata) back to the caller.

Two specific cases:

- **No API key configured** (`OPENAI_API_KEY` empty): the OpenAI client is
  created lazily on the first call, so the server still starts. The call
  fails immediately with `errorCode: OPENAI_API_KEY_MISSING`, without
  sending any request to OpenAI.
- **Secrets in error text:** OpenAI's 401 message echoes a masked key
  (`sk-proj-****abcd`). `describeProviderError` replaces anything key-shaped
  with `sk-[REDACTED]` before the message reaches the logs, the database or
  the thrown error.

The log write is `await`-ed before the throw, specifically so a provider
failure can never result in a lost audit trail - "handle API errors
without losing the usage/error log where possible." The "where possible"
qualifier covers the one case this can't guarantee: if the database write
itself fails. See the next section.

## When the usage-log write fails

A row can fail to be written: a database error (e.g. a migration that
hasn't been applied, or a locked/broken database file), or an agent name
that isn't registered. By then the provider call has already happened,
and on success it has been billed. Throwing at that point would discard a
paid, valid result, mark the run as failed although the provider
succeeded, and invite the user to resubmit, which is a duplicate charge.
So `UsageLogService.logCall` still never throws, but the failure is no
longer silent:

- **Explicit result.** `logCall` returns `{ persisted: true, logId }` or
  `{ persisted: false, reason: 'DB_WRITE_FAILED' | 'AGENT_NOT_REGISTERED' }`.
  `LLMService` passes it on as `usage.usageLogPersisted` (on the success
  result and on a thrown `LLMServiceError`). The provider `status` is
  unaffected: it still says whether the provider call succeeded.
- **One structured error event per unwritten row**, message
  `LLM usage NOT logged - analytics will undercount this call`, with
  `event: "USAGE_LOG_WRITE_FAILED"`. Fields: `reason`, `dbErrorCode` (the
  Prisma code, if any), `dbError` (only the final cause line of the database
  error, at most 300 characters), `callStatus`, `runId`, `userId`, `agent`,
  `model`, `inputTokens`/`outputTokens` (the provider's own counts),
  `latencyMs`, `providerResponseId`, `callTimestamp`. It never contains the
  prompt, CV or feedback text, the provider's error text, or Prisma's echo
  of the insert arguments.
- **Nothing is fabricated.** No row, token count, cost or provider id is
  written or invented for the missing call, and the HTTP response is the
  same as for a logged call.

**Detecting it.** Alert or grep on `USAGE_LOG_WRITE_FAILED` in the server
log. In the database, a successful run always makes at least one provider
call, so a `SUCCESS` run with no usage rows is a call missing from the
analytics:

```sql
SELECT r.id, r.userId, r.agentName, r.completedAt
FROM agent_runs r
WHERE r.status = 'SUCCESS'
  AND NOT EXISTS (SELECT 1 FROM llm_usage_logs l WHERE l.runId = r.id);
```

This query does not catch a missing row for a run that also has another,
logged call (e.g. the repair retry), or for a failed run. The server log
event covers those.

The same check is part of `GET /api/analytics/usage-completeness`
(`successfulRunsWithoutUsageLog`). The Overview shows a "Totals are
incomplete" warning, and the AGENT RUNS tab shows the affected runs
(`NO_USAGE_LOGGED`). See ANALYTICS_API.md, "Usage completeness". The
log event itself is not shown on the dashboard.

## Cost calculation

`costCalculator.ts` is intentionally tiny:

```ts
export function calculateCost(usage: TokenUsage, model: string): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null; // logged as a warning
  return usage.input_tokens * pricing.inputPerToken + usage.output_tokens * pricing.outputPerToken;
}
```

All it does is multiply **actual** token counts by a price looked up from
`modelPricing.ts`. It has no knowledge of agents, prompts, or the provider
SDK - it would work identically given token counts from any source, which
is exactly why pricing changes or new models never require touching agent
code: update `MODEL_PRICING` in `modelPricing.ts`, and every call site
(`UsageLogService.logCall`, which computes `estimatedCost` on every insert)
picks up the new numbers automatically.

**Which model is priced.** The row stores the model OpenAI reports in the
response (`response.model`), which is usually a dated snapshot such as
`gpt-4o-mini-2024-07-18` even when `gpt-4o-mini` was requested.
`getModelPricing` strips a trailing `-YYYY-MM-DD` date and prices the
snapshot at its base model's rate. It never matches on a shorter prefix:
`gpt-4o-mini-audio-preview` is not treated as `gpt-4o-mini`.

**Unknown models.** A model that isn't in `MODEL_PRICING` gets
`estimatedCost = null` and a logged warning. The real token counts are
still stored; only the cost is left unknown, rather than borrowing another
model's price. The backend also warns at startup when `OPENAI_MODEL` has no
configured price. Analytics totals sum only known costs, and
`GET /api/analytics/usage-completeness` (`callsWithUnknownCost`) and the
dashboard say when a total is missing such costs.

**Known limitation.** OpenAI bills cached input tokens
(`usage.prompt_tokens_details.cached_tokens`) at a discount. The estimate
prices every input token at the full rate, so it can slightly overstate
cost when prompt caching applies. Reasoning tokens are already included
in `completion_tokens`.

## Persistence

`LLMService` never writes to the database itself - it delegates to
`UsageLogService.logCall()`, which:

1. Looks up the `Agent` row by name. If the agent isn't registered (only
   possible for a misspelled name, since the two real agents are seeded), it
   writes nothing and reports `AGENT_NOT_REGISTERED` (see above).
2. Computes `estimatedCost` via `calculateCost()`.
3. Inserts one `llm_usage_logs` row with: `timestamp`, `runId`, `userId`,
   `agentId` + a denormalized `agentName` snapshot (so the log stays
   accurate even if the `agents` row is later renamed), `model`,
   `inputTokens`, `outputTokens`, `latencyMs`, `status`, `estimatedCost`,
   `errorCode`, `errorMessage`, `providerResponseId`.
4. Returns `{ persisted: true, logId }`, or `{ persisted: false, reason }`
   if steps 1-3 failed.

`isSeedData` is never touched by this path - it defaults to `false` in the
schema, and only `backend/src/db/seed.ts` ever sets it `true`. This is what
lets dashboard and evaluation queries filter out fabricated demo token
counts and trust that every unflagged row reflects a real provider
response. See `backend/prisma/schema.prisma` for the full column list.

## What the dashboard will read

Nothing in this service is dashboard-specific - the dashboard (not yet
built) will query `llm_usage_logs` directly (via `UsageLogService`'s
existing `getUserStats` / `getUsageForPeriod` / `getAggregateStats`
helpers, or new queries alongside them) for totals, breakdowns by user/agent,
error rates, and latency percentiles. Because every number in that table
came from this one code path, "dashboard total vs. raw API usage" sanity
checks (part of the evaluation requirements) reduce to: query the same
table twice, with and without aggregation - there's no separate
estimation pipeline that could drift from it.

## Testing strategy

`LLMService` depends on a minimal `LLMProviderClient` interface (just
`messages.create()`), not the full OpenAI SDK type surface. The real
SDK is wired in by `createOpenAIClient()`, the only function in the
codebase that touches the `openai` package directly. Tests construct
`new LLMService(mockClient)` with a plain object implementing that
interface - no module mocking, no network calls, no real API key needed.

Because `LLMService.call()`'s whole job is "call provider, then write a
row," the tests (`backend/tests/llmService.test.ts`) run against the real
SQLite test database (backend/data/test.db) (same pattern as the auth/RBAC suite) and assert on
the actual persisted row, not just that a function was called with the
right arguments. Coverage:

- **Successful calls** - returned text + usage match the mocked provider
  response; the persisted row matches (user, agent, model, tokens, cost).
- **Failed calls** - `LLMServiceError` is thrown; an `ERROR` row with 0
  tokens and the error code/message is still persisted.
- **Usage-log write failures** (`backend/tests/usageLogWriteFailure.test.ts`)
  - real database failures, not mocked Prisma: a `runId` that violates the
  foreign key, an unregistered agent, and a test-only SQLite trigger that
  aborts the insert for one test user during `POST
  /api/cv/documents/:id/classify`. Asserts: `logCall` doesn't throw and
  reports `persisted: false`; no row is written; a successful provider call
  is made exactly once and its result is returned with
  `usageLogPersisted: false`; a provider error still throws `LLMServiceError`
  flagged the same way; exactly one `USAGE_LOG_WRITE_FAILED` event with the
  real token counts and no prompt/CV text; the HTTP response contract is
  unchanged; and the SQL check above finds the run. Normal success and
  error rows report `persisted: true`.
- **Missing usage fields** - entirely absent, and partially present (only
  one of the two fields) - both produce 0 tokens, `usageDataMissing: true`,
  and `errorCode: MISSING_USAGE_DATA`, using a deliberately long response
  text to prove the 0 isn't secretly a length-based estimate.
- **Token extraction** - a response with a 2-character text body but
  `usage: { input_tokens: 5000, output_tokens: 3000 }` must log exactly
  5000/3000, proving extraction is wired to the usage field and nothing
  else (not response length, not prompt length).
- **Cost calculation** (`backend/tests/costCalculator.test.ts`) - pure unit
  tests against `calculateCost`/`getModelPricing`, including an exact-value
  check against the documented $2.50/$10.00-per-million gpt-4o rate, linear
  scaling, zero-token cost, dated-snapshot pricing, and `null` cost for an
  unknown model.
- **Latency calculation** - the mock provider sleeps a known number of
  milliseconds before resolving (and before throwing, on the error path);
  the recorded `latencyMs` must reflect that real elapsed time, with a
  small tolerance for timer jitter rather than being hardcoded or zero.

Run with:

```bash
cd backend
npm test
```

(uses `backend/.env.test` and `backend/data/test.db` - see `backend/TESTING.md`.)

## Logging accuracy audit (real OpenAI calls)

Proves that the tokens stored in `llm_usage_logs`, and shown on the
dashboard, are exactly the values OpenAI returned.

```bash
cd backend
npm run audit:logging-accuracy
```

What it does (`src/evaluation/runLoggingAccuracyAudit.ts`):

1. Creates a fresh `backend/data/logging-audit.db` (git-ignored), so the
   dashboard totals contain only the audited calls. Your dev data is untouched.
2. Makes **real** OpenAI calls through the production services
   (`CvClassificationService`, `SentimentService`, 3 samples each) and the
   production adapter `createOpenAIClient()`. The only difference from normal
   operation is a recording `fetch` that saves each raw HTTP response body.
3. Matches each raw response to its `llm_usage_logs` row by
   `providerResponseId` (the OpenAI response `id`, stored on every successful
   row), then compares `usage.prompt_tokens` with `inputTokens`,
   `usage.completion_tokens` with `outputTokens`, the model and the status.
4. Compares the totals: raw sum, database sum, and `GET /api/analytics/summary`
   called over HTTP with the audit user's own login token.
5. Writes `evaluation/logging-accuracy-report.json` and `.md` and exits 0 only
   on PASS. A run with no successful OpenAI call (for example, an invalid key)
   writes no report.

Cost: about 6-8 short calls on `OPENAI_MODEL`. The key comes from
`OPENAI_API_KEY` in the process environment if set, otherwise from
`backend/.env.local`.

The same comparison logic (`src/evaluation/loggingAccuracy.ts`) is tested
without a key by `tests/loggingAccuracy.test.ts` (fails on any input/output,
model or status mismatch) and `tests/loggingAccuracy.integration.test.ts`
(OpenAI-format HTTP responses through the real SDK, `LLMService`, the database
and the dashboard endpoint, including a negative control that alters one
stored row by one token).
