# Batch CV Processing

Several CVs are classified in one upload. Each file becomes its own CV document and agent run, is processed independently, and succeeds or fails on its own. One bad file never fails the whole batch.

Code: `backend/src/services/cvBatchService.ts`, `backend/src/utils/validators.ts` (`BatchUploadSchema`), `frontend/src/components/cv/` (`CvUploadPanel`, `CvProcessingTab`, `ProcessingJobView`).

## Why the upload is JSON, not multipart

The backend has no multipart-parsing dependency. The browser reads each selected file and sends it as JSON: a `.txt` file as its text (`File.text()`), a `.pdf` file as its bytes base64-encoded with `mimeType: "application/pdf"`. A PDF's text is extracted on the server (`backend/src/utils/pdfText.ts`, PDF.js in a worker thread) and then gets exactly the same checks and classification as a `.txt` file. Only text-based PDFs are supported: there is no OCR. Word files are not supported. A PDF or Word file renamed to `.txt` is detected as binary and rejected.

## Request

`POST /api/cv/batch` (authenticated):

```json
{ "files": [ { "fileName": "jane.txt", "mimeType": "text/plain", "content": "..." } ] }
```

The request itself is rejected with **400** when:

- `files` is missing or empty, or has more than **20** entries (`MAX_BATCH_FILES`);
- a field has the wrong type;
- a `fileName` is empty, longer than 255 characters, or contains control characters.

Otherwise the response is **202** at once, before any file is processed:

```json
{ "batchId": "<uuid>", "totalCount": 3, "createdAt": "..." }
```

For every file, a `cv_documents` row and a `PENDING` `agent_runs` row are created first. Both are owned by the authenticated user and stamped with the `batchId`. Ownership always comes from the session, never from the request body.

## Per-file processing

Files of a batch are processed in the backend process, **at most 3 at a time** (`MAX_CONCURRENT_BATCH_FILES` in `cvBatchService.ts`). A file makes its AI calls one after another (the classification, then at most one repair retry), so a batch never has more than 3 provider calls in flight. Files are picked up in submission order. The others stay `PENDING`, shown as **Queued** in the status and the UI, until a slot frees up. Nothing is dropped: every file is processed exactly once, and a failing file frees its slot for the next one.

The cap applies **per batch**. Two batches running at the same time (from different users, or the same user) each get 3 slots, so one batch never waits behind another; together they can have 6 calls in flight. Separately, every submission counts toward the submitter's **per-user AI rate limit** (default 60 AI runs per 10 minutes; one run per file). A batch that would go over the limit is refused **as a whole** with 429 and a `Retry-After` header before anything is created. It is never partly accepted. See README "Rules".

Each file moves to `RUNNING` when its slot starts. Before any AI call, it is rejected as `ERROR` with a safe, user-facing reason when:

| Check | Reason stored on the run |
|---|---|
| `mimeType` is not `text/plain` or `application/pdf` | `Unsupported file type "<type>" - only text/plain, application/pdf is supported` |
| PDF only: empty, over 2 MB, no PDF signature, damaged, password-protected or encrypted, over 50 pages, no extractable text (scanned), or reading took over 15 s or too much memory | A specific message for each, e.g. `The PDF is password-protected. ...` or `No readable text was found in this PDF. ... text recognition (OCR) is not supported. ...` |
| Fewer than 10 characters after trimming | `File content is too short to be a CV` |
| More than 50,000 characters | `File content exceeds the 50000 character limit` |
| More than 5% control characters (binary, e.g. a renamed PDF/DOCX) | `File content does not appear to be valid decoded text` |

For a PDF, the character checks apply to its extracted text, and that text (never the upload) is stored as the document's content.

Files that pass go to the CV Classification Agent. The agent uses the same strict schema, one repair retry, and grounding and leak checks as single-CV classification.

| Outcome | `agent_runs.status` | What is stored |
|---|---|---|
| Classified | `SUCCESS` | A `cv_recommendations` row linked to the run and document, plus one usage log per AI call |
| AI provider failure (missing key, 401, rate limit, outage) | `ERROR` | `errorMessage` "The AI provider request failed: …" (key-redacted), plus an `ERROR` usage log with 0 tokens |
| Model output failed validation after the retry | `ERROR` | `errorMessage` "The AI response did not pass validation, even after one automatic retry." The usage logs of both calls are kept |
| Rejected before the AI call (table above) | `ERROR` | `errorMessage` only; no AI call and no usage log |

Stored error messages are capped at 300 characters and never contain raw model output or keys.

## Progress

`GET /api/cv/batch/:batchId/status` reads the batch's run rows live; nothing is estimated.

- **Totals:** `total`, `queued` (PENDING), `processing` (RUNNING), `completed` (SUCCESS), `failed` (ERROR), and `percentage` = `(completed + failed) / total`, rounded.
- **Items:** `items[]` has one entry per file, with `runId`, `documentId`, `fileName`, `state` (`queued` / `processing` / `completed` / `failed`), `recommendationId` (when completed) and `error` (when failed).
- **Access:** 403 for another user's batch (admins may view any batch); 404 for an unknown batch id.

## In the UI (CV PROCESSING tab)

- **Before upload:**
  - Files are checked in the browser: `.txt` or `.pdf` (both can be mixed); not empty; a `.txt` has at least 10 and at most 50,000 characters and is not binary; a `.pdf` is at most 2 MB and starts with a PDF signature; all files together are at most 9 MB (the server accepts 10 MB per request).
  - Rejected files are listed as "Will not be uploaded" with the reason and are never sent.
  - One valid file uses the single-CV endpoint; two or more use the batch endpoint.
- **While processing:**
  - The status is polled every 1.5 s. After 3 consecutive failed polls, it shows "Lost contact with the server…" with a **Retry** button.
  - The batch id is kept in `sessionStorage`, so tracking resumes after switching tabs within the same browser tab.
- **At the end:**
  - It shows "All N CVs were classified.", or "Partially completed: X of N CVs classified, Y failed.", or "None of the N CVs could be classified".
  - Each file has a Completed or Failed badge and its reason. Failures are never shown as successes.

## Restart recovery

Processing lives inside the backend process. When the backend starts (`src/server.ts`), **before it accepts requests**, it runs `recoverInterruptedRuns` (`src/services/runRecoveryService.ts`). Every run a previous process left unfinished, meaning created before this start and still `PENDING` or `RUNNING`, is set to `ERROR` with `completedAt` = the recovery time and one of two reasons:

| State left behind | Which runs | Reason stored (shown in the batch status, the AGENT RUNS tab and `GET /api/runs`) |
|---|---|---|
| `PENDING` | Queued batch files. They never started, so they made no AI call. | `Not processed: the backend restarted before this file was started, so no AI call was made. Please upload it again.` |
| `RUNNING` | A batch file, a single CV classification or a sentiment analysis that was in progress | `Interrupted: the backend restarted while this run was in progress. It was stopped and not retried; please submit it again.` |

The batch then reports 100% with those files as failed.

**What doesn't change:**
- `SUCCESS` and `ERROR` runs;
- owners, batch ids and documents;
- usage logs: none are added or removed. AI calls that finished before the restart keep their rows; a call cut off mid-flight has no usage data to record;
- runs created by the new process.

The updates only match rows still `PENDING`/`RUNNING`, so running recovery again changes nothing. The backend logs `INTERRUPTED_RUNS_RECOVERED` with the counts and up to 20 run ids. Recovery runs after the startup migration check (docs/DATABASE.md, "Startup migration check"), so it only ever runs against a database whose schema matches the code. A database that is missing, not set up or behind is refused before recovery. If recovery itself fails on a current schema, the error is logged and the server still starts.

Recovered runs count as **failed runs** in `GET /api/analytics/runs`. Token, cost, latency and call-level error-rate metrics are unaffected, because they come from usage logs.

**Assumption:** one backend process per database. A second backend started against the same database (for example `npm run dev` twice) would fail the first one's in-progress runs.

## Analytics

Every batch file is a real run, so it counts in the run counts and in the successful (`SUCCESS`) or failed (`ERROR`) run counts (`GET /api/analytics/runs`). Usage logs count toward tokens, cost, error rate and latency. Files rejected before the AI call have no usage log, so they appear in the failed **run** count but not in the call-level error rate. See [ANALYTICS_API.md](ANALYTICS_API.md).

## Verification

| Evidence | What it shows |
|---|---|
| `backend/tests/cvBatch.integration.test.ts` (part of `npm test`, provider stub) | Validation, per-file isolation, progress, ownership |
| `backend/tests/runRecovery.test.ts` (part of `npm test`, no provider) | Restart recovery: interrupted queued/running batch files, single CVs and sentiment runs of two users are failed with the right reason; finished runs, newer runs, usage logs and token analytics are untouched; idempotent; batch status, run listing and ownership afterwards; the real `src/server.ts` recovers before it starts listening |
| `backend/tests/cvBatchConcurrency.test.ts` (part of `npm test`, gated provider stub that holds each call open until released) | Never more than 3 calls in flight per batch; queued/processing/completed counts while files wait; every file processed exactly once; mixed failures (rejected files, provider errors, repair retry) isolated with the right reasons and usage rows; two users' batches capped independently and never mixed |
| `npm run verify:e2e-real-openai` (real OpenAI; last run 2026-10-09, see [evaluation/e2e-test-report.md](../evaluation/e2e-test-report.md) §16) | Real parallel processing (peak 3 concurrent calls); partial failure with invalid files and one CONTROLLED provider failure |
| `npm run verify:ui` (CONTROLLED provider, Chrome) | A UI batch with one failing file reports "Partially completed", the Failed badge and the reason |

## Limitations

- **Plain text and text-based PDF only.** No OCR for scanned PDFs, no DOCX. The per-batch cap of 3 files in progress also bounds PDF extraction workers per batch.
- **In-process processing, no resumption.** If the backend stops mid-batch, the unfinished files cannot finish. They are **not resumed**: a queued file's MIME type is not stored (so its type check cannot be repeated), a running file may already have made a billed AI call, and resuming at startup would make AI calls nobody asked for. Instead, the next backend start fails them before accepting requests (see "Restart recovery" above). Failed files are never retried automatically: upload them again.
- **Concurrency is capped per batch, not globally.** Each batch has at most 3 AI calls in flight, but several simultaneous batches add up (3 each), and single-CV and sentiment requests have no concurrency cap. Total volume per user is bounded by the per-user AI rate limit (in memory, per process). A provider rate limit can still fail a file with the provider's reason. SQLite serializes the writes (see [DATABASE.md](DATABASE.md)).
- **Tracking is per browser tab.** Progress tracking in the UI lasts only for the browser tab that submitted the batch; results are always available afterwards from the results list.
