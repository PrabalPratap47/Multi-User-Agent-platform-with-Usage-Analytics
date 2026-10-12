# Analytics API

All calculations live in exactly one place: `backend/src/services/analyticsService.ts`
(`AnalyticsService`). Controllers (`analyticsController.ts`) only call it and
serialize the result - there is no second implementation of any metric
anywhere else, and the frontend never computes a token/cost number itself.

**Verification status.** When this document was first written, the service had only been checked by manual trace. Since then it has been verified by execution:

- **Fixture tests:** `tests/analyticsService.test.ts` and `tests/finalCategoryAnalytics.test.ts`, part of `npm test`.
- **API vs. database for every scope:** `tests/multiUserConcurrency.test.ts` and the real-OpenAI E2E run, where the database matched the analytics API on every metric. See `evaluation/e2e-test-report.md` §12; that comparison found and fixed the seed-data exclusion described below.
- **Rendered dashboard:** compared in Chrome (`npm run verify:dashboard-run-outcomes`, and the Step 18/19 dashboard checks).

The real-OpenAI E2E runner was last run before the successful/failed run-count follow-up.

`GET /api/analytics/evaluation` is a placeholder that returns only a message. It is not one of the metrics below. Evaluation results come from `npm run eval:cv-classification` (see the main README).

**Charts.** The ANALYTICS tab's "Decision outcomes" doughnut plots the accepted / modified / rejected counts of metric 10b (the per-category original-vs-final counts are returned by the API but not shown on the dashboard); the Admin → Users bar chart plots metric 5. Two other charts summarise lists the API has already scoped, counted in the browser: the final-decisions treemap on CV PROCESSING (from `GET /api/cv/results`) and the sentiment breakdown doughnut on SENTIMENT (from `GET /api/sentiment/results`). No token or cost number is computed in the frontend.

## Access control

Every endpoint requires authentication. Scope is decided from `req.user`
(the authenticated caller, from the verified JWT) - **never** from a
query parameter alone:

- A regular **USER** always sees only their own data.
- An **ADMIN** sees all data by default, and may optionally pass
  `?userId=<id>` to drill into one specific user's numbers. For a
  non-admin, `?userId=` is parsed but has **no effect** - `userScope()`
  in `analyticsService.ts` only honors it when `user.role === 'admin'`.
  `tests/analyticsService.test.ts` has a dedicated test proving this.
- `GET /api/analytics/by-user` (metric 5) is admin-only at the route
  level (`requireAdmin` middleware) - a per-user breakdown of *all*
  users is inherently an admin-only view.

## Real data only

Every token/cost/latency/error number is read directly from the
`llm_usage_logs` table (via Prisma aggregates), never computed from
anything the frontend sends. Rows with `isSeedData: true` (demo data
inserted by `backend/src/db/seed.ts`) are excluded from **every** metric
below - including them would mean reporting numbers that were never
produced by a real LLM call, which contradicts the "no fabricated
metrics" requirement this whole feature exists to satisfy.

Only `llm_usage_logs` carries the `isSeedData` flag. The seed's demo
**runs** are identified through it (a run whose usage log has
`isSeedData: true`), and those runs, their recommendations and the
decisions on those recommendations are excluded from metrics 7, 10 and
11 as well (`seedRunIds()` in `analyticsService.ts`). Before Step 18
these three metrics counted the seed's demo runs, CVs and decisions;
the E2E run found it and `tests/analyticsService.test.ts` now guards it.

## Endpoints and their metrics

| # | Metric | Endpoint | Method |
|---|---|---|---|
| 1-4 | Overall input tokens, output tokens, total tokens, estimated cost | `GET /api/analytics/summary` (alias: `/tokens`) | `getTokenSummary` |
| 5 | Token consumption by user | `GET /api/analytics/by-user` (admin only) | `getTokensByUser` |
| 6 | Token consumption by agent | `GET /api/analytics/by-agent` | `getTokensByAgent` |
| 7 | Agent run counts (24h/7d/30d) and successful / failed runs | `GET /api/analytics/runs` | `getAgentRunCounts` |
| 8 | Error rate by agent | `GET /api/analytics/errors` | `getErrorRateByAgent` |
| 9 | Average latency by agent | `GET /api/analytics/latency` | `getAverageLatencyByAgent` |
| 10 | CV recommendation acceptance rate per category | `GET /api/analytics/acceptance-rate` | `getAcceptanceRateByCategory` |
| 10b | Original AI recommendation vs final category, per category | `GET /api/analytics/final-categories` | `getFinalCategoryBreakdown` |
| 11 | Time saved in person-hours | `GET /api/analytics/time-saved` | `getTimeSaved` |
| — | Whether the token/cost totals are complete (missing or unknown usage) | `GET /api/analytics/usage-completeness` | `getUsageCompleteness` |

### 1-4. Token summary (`getTokenSummary`)

```sql
SELECT SUM("inputTokens"), SUM("outputTokens"), SUM("estimatedCost"), COUNT(*)
FROM llm_usage_logs
WHERE "isSeedData" = false AND "userId" = :scopedUserId;  -- omitted entirely for an admin with no ?userId=
```

- `totalInputTokens` / `totalOutputTokens`: direct sums.
- `totalTokens` = `totalInputTokens + totalOutputTokens`.
- `estimatedCost`: direct sum of the `estimatedCost` column, which was
  itself computed per-row by `costCalculator.ts` from actual token
  counts and the centralized pricing table (`config/modelPricing.ts`) at
  the time each call was logged - this endpoint never recalculates cost,
  only sums what's already stored.
- `callCount`: total number of log rows in scope.

These are **recorded totals**: sums of what was logged. They are not
adjusted or estimated when usage is missing or a cost is unknown. Whether
they are complete is reported separately by
`GET /api/analytics/usage-completeness` (below), and the dashboard labels
the cards "Recorded usage only - incomplete" / "Known costs only -
incomplete" when they are not.

### 5. Token consumption by user (`getTokensByUser`, admin only)

Same sums as above, `GROUP BY "userId"`, joined to `users` for email. Each row also has `totalTokens` (= `totalInputTokens + totalOutputTokens`) and `callsWithUnknownUsage` (calls stored with `errorCode: MISSING_USAGE_DATA`, i.e. 0 tokens because the provider sent no usage - never estimated). Shown as the bar chart in Admin → Users, where active users with no usage appear at 0 and deleted (deactivated) users are left out of the chart. The API itself still returns their rows, and their usage stays in every global total.
Always unscoped by caller (it's the admin-only "all users" view by
definition) - there is no `userId` scoping parameter on this one.

### 6. Token consumption by agent (`getTokensByAgent`)

Same sums, `GROUP BY "agentId", "agentName"`, scoped by caller as above.

### 7. Agent run counts for 24h / 7d / 30d (`getAgentRunCounts`)

Three separate counts against the `agent_runs` table (not
`llm_usage_logs` - a run is the unit being counted, not a call):

```sql
SELECT COUNT(*) FROM agent_runs WHERE "userId" = :scopedUserId AND "createdAt" >= NOW() - INTERVAL '1 day';
SELECT COUNT(*) FROM agent_runs WHERE "userId" = :scopedUserId AND "createdAt" >= NOW() - INTERVAL '7 days';
SELECT COUNT(*) FROM agent_runs WHERE "userId" = :scopedUserId AND "createdAt" >= NOW() - INTERVAL '30 days';
```

The three windows overlap (a run from 2 hours ago counts toward all
three) - they are independent counts, not a breakdown that sums to a
total.

The same response also carries two **all-time** outcome counts, read
from `agent_runs.status` exactly as the run lifecycle writes it
(`cvClassificationService.ts`, `sentimentService.ts`,
`cvBatchService.ts`; a CHECK constraint limits it to
`PENDING | RUNNING | SUCCESS | ERROR`):

```sql
SELECT COUNT(*) FROM agent_runs WHERE "userId" = :scopedUserId AND status = 'SUCCESS';  -- successful
SELECT COUNT(*) FROM agent_runs WHERE "userId" = :scopedUserId AND status = 'ERROR';    -- failed
```

- `successful`: the run finished and its result was stored.
- `failed`: the run ended with an error (provider failure, a model
  response that failed validation after the repair retry, a batch
  file that was rejected, or a run interrupted by a backend restart and
  failed at the next startup); its safe reason is in `agent_runs.errorMessage`.
- `PENDING` (queued) and `RUNNING` (processing) runs count toward
  neither, so `successful + failed` can be lower than the total number
  of runs while a batch is in flight.

Scope and seed exclusion are the same as the window counts: admin sees
every user's runs (or one user's with `?userId=`), a regular user only
their own, and the seed's demo runs are excluded. Response:

```json
{ "last24h": 7, "last7d": 7, "last30d": 7, "successful": 7, "failed": 0 }
```

The dashboard shows both in the **Agent Usage** section ("Successful
Runs", "Failed Runs"; the failed card turns red when it is above 0).

### 8. Error rate by agent (`getErrorRateByAgent`)

For each agent: `errorRate = errorCalls / totalCalls`, where both counts
come from `llm_usage_logs.status` (`'ERROR'` vs all rows), scoped and
filtered the same way as the token summary. An agent with zero calls in
scope is simply absent from the result (never a divide-by-zero).

### 9. Average latency by agent (`getAverageLatencyByAgent`)

`AVG("latencyMs")` per agent from `llm_usage_logs`, rounded to the
nearest millisecond. This is the same `latencyMs` value `LLMService`
measured and persisted for every call (see `docs/USAGE_LOGGING.md`) -
never recomputed or estimated here.

### 10. CV recommendation acceptance rate per category (`getAcceptanceRateByCategory`)

Grouped by the recommendation's **original** `primaryCategory` (what the
agent proposed), not by whatever the user ultimately chose - grouping by
the final category would make a MODIFY decision ambiguous (which
category would it count toward: the one proposed, or the one chosen?).

For each original category:

```
acceptanceRate = count(decisionType = ACCEPT) / count(all decisions for that category)
```

MODIFY and REJECT both count against the rate (only ACCEPT counts for
it), but are reported as separate `modify`/`reject` fields alongside
`accept` and `totalDecisions`, so a reader who wants a different
definition (e.g. treating MODIFY as "partially accepted") can derive it
from the raw counts rather than being stuck with this one definition.

### 10b. Original AI recommendation vs final category (`getFinalCategoryBreakdown`)

Metric 10 counts every decision row, including ones later changed. This
one counts each decided CV **once, by its latest decision** (newest
`timestamp`, then highest `id`), so it shows where CVs ended up:

- `originalCount`: decided CVs whose original `primaryCategory` (what the
  agent proposed, never overwritten) is this category.
- `finalCount`: decided CVs whose latest decision's persisted
  `finalPrimaryCategory` is this category (the original for ACCEPT, the
  chosen one for MODIFY).
- `rejectedCount`: decided CVs whose latest decision is REJECT. A REJECT
  stores no final category (DB CHECK constraint), so it is never counted
  in any `finalCount`.

- `acceptedCount` / `modifiedCount`: decided CVs whose latest decision is
  ACCEPT / MODIFY (the Analytics doughnut chart shows these with
  `rejectedCount`).

So `sum(originalCount) = decidedCvCount = sum(finalCount) + rejectedCount = acceptedCount + modifiedCount + rejectedCount`.
CVs with no decision are not counted. Primary categories only. Scoped by
the CV's owner (a regular user sees their own CVs; an admin sees all, or
one user's with `?userId=`), with the seed's demo recommendations
excluded as for metric 10. Response:

```json
{ "decidedCvCount": 3, "acceptedCount": 1, "modifiedCount": 1, "rejectedCount": 1, "categories": [
  { "category": "AI Engineer", "originalCount": 0, "finalCount": 1 },
  { "category": "Back-End Developer", "originalCount": 1, "finalCount": 1 },
  { "category": "Front-End Developer", "originalCount": 1, "finalCount": 0 },
  { "category": "Web Automation", "originalCount": 1, "finalCount": 0 }
] }
```

### 11. Time saved in person-hours (`getTimeSaved`)

**This is an ESTIMATE, not a measurement, and the API response says so
explicitly** (`methodology: 'ESTIMATED'`) - it is never presented as
directly measured human-productivity data.

Methodology, exactly as implemented:

1. **Baseline manual review time** (an *assumed* input, not measured):
   `BASELINE_MANUAL_REVIEW_MINUTES_PER_CV = 5` minutes per CV. This is a
   documented assumption about how long a human reviewer takes to read
   and categorize one CV - change this one constant in
   `analyticsService.ts` if a different assumption is more appropriate,
   and it is the only place that needs to change.
2. **Automated processing time** (a *measured* input, not assumed): the
   actual average `latencyMs` of real (`isSeedData: false`) CV
   Classification Agent calls in scope, read from `llm_usage_logs` -
   exactly the same query as metric 9, filtered to that one agent.
3. **Completed CV count**: the number of `cv_recommendations` rows in
   scope. A row only exists there for a run that reached `SUCCESS` (see
   `cvClassificationService.ts`) - a CV that failed classification or is
   still processing contributes nothing, per "calculate saved time only
   using completed CV processing."
4. **Calculation**:
   ```
   manualMinutesTotal     = completedCvCount * baselineManualReviewMinutesPerCv
   automatedMinutesTotal  = (completedCvCount * measuredAverageAutomatedLatencyMs) / 60000
   estimatedTimeSavedHours = max(0, (manualMinutesTotal - automatedMinutesTotal) / 60)
   ```
   Clamped to 0 so a hypothetical scenario where automated processing
   somehow took longer than the manual baseline never reports negative
   "time saved."

The response includes an `assumptions` array stating all of the above in
plain language, specifically so a reader of the raw JSON (not just this
doc) sees the methodology without needing to find this file.

### Usage completeness (`getUsageCompleteness`)

`GET /api/analytics/usage-completeness` reports where the token and cost
totals are known to be lower than the real usage, or where the real usage
is unknown. It never changes or estimates a total. The definitions live in
one place, `services/usageCompleteness.ts`, which `GET /api/runs?usage=incomplete`
also uses, so the counts and the run list agree. One exception: the run list leaves out runs of deleted (deactivated) users, while these counts, like the token totals, still include them.

| Field | Level | Counted when | What it means for the totals |
|---|---|---|---|
| `callsWithUnknownUsage` | call | non-seed log row with `errorCode = 'MISSING_USAGE_DATA'` | The provider returned no usage. Recorded as 0 tokens and 0 cost; the real values are **unknown**, not zero. |
| `callsWithUnknownCost` | call | non-seed row with `estimatedCost IS NULL` and tokens > 0 | Real tokens, but the model has no price: the cost is missing from `estimatedCost`. |
| `successfulRunsWithoutUsageLog` | run | `SUCCESS` run with no usage row | Its usage row(s) could not be written (`USAGE_LOG_WRITE_FAILED`): its calls are missing from every total. |
| `interruptedRuns` | run | `ERROR` run whose reason is the startup-recovery "Interrupted: …" message | A provider call may have been cut off by a restart; any usage it had is unknown. |
| `affectedRuns` | run | distinct runs with at least one of the run- or call-level issues above | The number `GET /api/runs?usage=incomplete` returns. |
| `complete` | — | none of the above in scope | The totals are complete as far as the stored data can show. |
| `byUser` | — | admin, no `?userId=`, and not complete | The per-user counts (with email) for users with at least one issue. |

**Not counted as incomplete:** a failed provider call (`status = ERROR`, 0
tokens). The provider reported no usage for a request it rejected, and this
is a known zero (see USAGE_LOGGING.md, "Error handling").

**Scope:** as everywhere else. A regular user gets only their own counts, and
`?userId=` is ignored for them. An admin gets everyone's (with `byUser`), or
one user's with `?userId=`. The response contains counts and, for admins, user
ids and emails only: no CV/feedback text, prompts, failure text or database
errors.

**Runs:** `GET /api/runs` returns `usageIssues` on every run (`USAGE_UNKNOWN`,
`COST_UNKNOWN`, `NO_USAGE_LOGGED`, `INTERRUPTED`; empty when complete), and
`?usage=incomplete` lists only affected runs. The AGENT RUNS tab shows a
"Usage incomplete" badge and a **Usage data: Incomplete only** filter.

**What it cannot detect:**
- a missing usage row on a run that also has a logged call (e.g. a lost
  repair-retry row);
- a missing row on a failed run that was not interrupted.

Only the `USAGE_LOG_WRITE_FAILED` server log event shows those
(USAGE_LOGGING.md).

## Testing

`tests/analyticsService.test.ts` creates its own known fixture rows (not
`seed.ts`'s data) with hand-computed expected results documented in
comments next to each assertion - e.g. two `llm_usage_logs` rows with
latencies 1000ms and 2000ms are asserted to average to exactly 1500ms;
three `agent_runs` rows with known `createdAt` offsets (now, 10 days ago,
40 days ago) are asserted to produce exactly `{last24h: 1, last7d: 1,
last30d: 2}`. A deliberately huge `isSeedData: true` row is included in
the fixtures specifically to prove it's excluded from every sum. Two
tests specifically verify user-isolation: a user with no data gets all
zeros, and a non-admin cannot widen their own scope via `?userId=`.

Successful / failed runs: `tests/analyticsService.test.ts` ("successful
and failed runs": mixed, all-success, all-failure and zero-run users,
seed runs of both statuses, admin global and drill-down);
`tests/multiUserConcurrency.test.ts` (API equals the database for admin
and each user, with seed runs present); and
`npm run verify:dashboard-run-outcomes` (database -> API -> rendered
dashboard in Chrome, CONTROLLED provider, no OpenAI calls).

**Run with** `cd backend && npm test -- analyticsService finalCategoryAnalytics`
(requires `.env.test` - see `backend/TESTING.md`).
