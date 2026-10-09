# External Agent Log Format

How to import a log file from another, unrelated AI agent into this
platform's "External Agent Logs" dashboard tab.

## Core principle

**This platform does not assume an external agent's log format matches
its own.** Only two fields are required: `timestamp` and `agentName`.
Everything else is optional, because a genuinely foreign system may
simply not report it (no token counts, no cost tracking, no concept of
"status" in our vocabulary). Extra fields the schema doesn't recognize
are allowed and preserved, never rejected - we don't control a foreign
system's schema.

The runtime validator for this is `backend/src/externalLogs/format.ts`
(`ExternalLogRecordSchema`); the same contract as a machine-readable JSON
Schema is `backend/src/externalLogs/externalLogRecord.schema.json`.

## Supported file types

| Extension | Shape |
|---|---|
| `.json` | A single top-level JSON **array** of record objects: `[{...}, {...}]` |
| `.jsonl` | One JSON **object** per line, newline-delimited: `{...}\n{...}\n` (blank lines are skipped, not counted as records) |

A `.json` file whose top level is an object (not an array) is rejected
with a clear, file-level error - see "Error reporting" below.

## Record fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `timestamp` | string | **Yes** | Anything JavaScript's `Date` constructor can parse. ISO 8601 (`2026-01-15T10:30:00Z`) is recommended but not enforced. |
| `agentName` | string | **Yes** | Name of the external agent that produced this record. |
| `userId` | string \| number | No | The external system's **own** user identifier, if it has one. Never assumed to correspond to this platform's internal user IDs - stored separately as `externalUserId`, with no foreign key to our `users` table. |
| `model` | string | No | The model the external agent used, if reported. |
| `inputTokens` | integer ≥ 0 | No | |
| `outputTokens` | integer ≥ 0 | No | |
| `latencyMs` | integer ≥ 0 | No | |
| `status` | string | No | The external system's own status vocabulary (`"ok"`, `"success"`, `"200"`, `"failed"`, `"ERROR"`, anything) - normalized into a boolean, see below. |
| `estimatedCost` | number ≥ 0 | No | |

Any other fields present on a record are kept (in `rawRecord`, stored
verbatim) but not otherwise interpreted.

## Status normalization

Because external systems use their own vocabulary for success/failure,
`status` is normalized into an internal `isError` boolean by
`classifyStatus()` in `format.ts`:

1. Exact match (case-insensitive) against a known **error** set:
   `error`, `failed`, `failure`, `fail`, `timeout`, `timed_out`,
   `exception`, `400`, `401`, `403`, `404`, `429`, `500`, `502`, `503`, `504`
   → `isError = true`.
2. Exact match against a known **success** set: `success`, `succeeded`,
   `ok`, `200`, `201`, `202`, `completed`, `complete`, `done`
   → `isError = false`.
3. Otherwise, a substring heuristic: contains `"err"`, `"fail"`, or
   `"exception"` → `isError = true`.
4. Otherwise (including when `status` is absent entirely) → `isError = false`.

**This is a documented heuristic, not a guarantee.** The original string
is always preserved verbatim as `rawStatus`, specifically so this
normalization can be audited or reinterpreted later without having lost
the source data.

## Error reporting for malformed records

Every record in a file is validated **independently**. A malformed
record (missing `timestamp`/`agentName`, wrong field type, an
unparseable timestamp, or invalid JSON on one `.jsonl` line) is recorded
as an error and **skipped** - it never blocks the other, valid records
in the same file from being imported. This mirrors the same principle
used for batch CV processing: one bad input item doesn't fail the whole
batch.

The import response and the stored `ExternalAgentLog` row both report:
- `totalRecords` - records attempted (valid + invalid)
- `validRecords` - records that passed validation and were stored
- `invalidRecords` - records rejected
- `parseErrors` - `Array<{ index, reason }>` - which record failed and why (`index` is the array index for `.json`, or the 0-based line number for `.jsonl`; `-1` means the error is file-level, e.g. invalid JSON entirely)

## Storage and isolation from internal metrics

Imported data lives in two tables, completely separate from this
platform's own usage data:

- `external_agent_logs` - one row per **import** (the file-level batch): who imported it, source agent name, file name/format, the three counts above, `parseErrors`, timestamp.
- `external_agent_log_records` - one row per **validated record**: the normalized fields from the table above, plus `rawRecord` (the complete original JSON, for audit) and the computed `isError`.

**Neither table is ever queried by `AnalyticsService`**, which computes
every internal metric exclusively from `llm_usage_logs` /
`agent_runs` (see `docs/ANALYTICS_API.md`). There is no code path,
view, or join anywhere in this codebase that combines the two - the
"External Agent Logs" tab has its own, separate stats endpoint
(`GET /api/import/stats`, `ExternalAgentLogService.getStats()`), which
only ever reads `external_agent_log_records`. Imported data cannot
contaminate the internal dashboard because there is currently no
mechanism that would let it - "unless explicitly selected" describes a
safeguard that would only matter if a future combined view were built;
today, selection isn't possible because merging isn't implemented at all.

## Access control

Same pattern as everywhere else in this platform: a regular user sees
only imports **they** uploaded; an admin sees all imports, from any
user. Enforced server-side in `ExternalAgentLogService`, never by a
client-supplied ID.

## Example: valid `.json` file

```json
[
  {
    "timestamp": "2026-01-15T10:30:00Z",
    "userId": "legacy-user-882",
    "agentName": "Legacy Screening Bot",
    "model": "gpt-4o-mini",
    "inputTokens": 512,
    "outputTokens": 128,
    "latencyMs": 940,
    "status": "ok",
    "estimatedCost": 0.0031
  },
  {
    "timestamp": "2026-01-15T10:31:12Z",
    "agentName": "Legacy Screening Bot",
    "status": "failed",
    "latencyMs": 2200
  }
]
```

Note the second record: no `userId`, `model`, `inputTokens`,
`outputTokens`, or `estimatedCost` - all optional, all valid.

## Example: valid `.jsonl` file

```
{"timestamp":"2026-01-15T09:00:00Z","agentName":"Vendor Resume Parser","status":"200","inputTokens":300,"outputTokens":80,"latencyMs":610,"estimatedCost":0.0018}
{"timestamp":"2026-01-15T09:05:00Z","agentName":"Vendor Resume Parser","status":"500","latencyMs":15000}
```

## Example: a record that would be rejected (and why)

```json
{ "agentName": "Some Agent", "status": "ok" }
```
→ rejected: `timestamp: timestamp is required`.

```json
{ "timestamp": "not-a-real-date", "agentName": "Some Agent" }
```
→ rejected: `timestamp "not-a-real-date" could not be parsed as a date`.

Both would be reported in `parseErrors`, and both would be skipped while
any other valid records in the same file are still imported.

## Sample files for demonstration

`docs/samples/external-agent-logs-valid.json` and
`docs/samples/external-agent-logs-mixed.jsonl` - the latter deliberately
contains both valid and malformed records, to demonstrate the partial-
import/error-reporting behavior described above.
