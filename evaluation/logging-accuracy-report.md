# Usage Logging Accuracy Report

**Overall: PASS**

- **Generated at:** 2026-10-09T04:47:22.706Z
- **Provider:** OpenAI Chat Completions (real API calls)
- **Configured model (OPENAI_MODEL):** gpt-4o
- **Real successful OpenAI calls audited:** 6
- **HTTP responses captured (incl. non-2xx):** 6
- **Usage log rows in scope:** 6
- **Dashboard call count:** 6
- **Audit database:** backend/data/logging-audit.db (fresh for this run)

## Method

- Real OpenAI Chat Completions calls were made through the production services (`CvClassificationService`, `SentimentService`) and the production OpenAI adapter (`createOpenAIClient`).
- **Raw** values were read from each HTTP response body (`usage.prompt_tokens`, `usage.completion_tokens`, `model`) by a recording `fetch`, independently of `LLMService`.
- **Logged** values were read from `llm_usage_logs`, matched to each raw response by `providerResponseId` (the OpenAI response `id`).
- **Dashboard** totals came from `GET /api/analytics/summary`, called over HTTP with the audit user's own login token.
- No token value in this report was estimated, counted from text, or computed by a tokenizer.

## Per-call comparison

| Run ID | Agent | Model | Raw in | Logged in | Δ in | Raw out | Logged out | Δ out | Status | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 60a5e5f5-af8b-47ac-aeb2-520aba51a543 | CV Classification Agent | gpt-4o-2024-08-06 | 1065 | 1065 | 0 | 142 | 142 | 0 | SUCCESS | PASS |
| 6efa5e54-d4ad-484d-b4aa-b345a74ff7e3 | CV Classification Agent | gpt-4o-2024-08-06 | 1060 | 1060 | 0 | 145 | 145 | 0 | SUCCESS | PASS |
| 7936ab61-6248-4fde-b29e-6aaae9fce2aa | CV Classification Agent | gpt-4o-2024-08-06 | 1063 | 1063 | 0 | 141 | 141 | 0 | SUCCESS | PASS |
| 4caccbff-711c-4217-aa8d-6fd36892ade5 | Sentiment Analysis Agent | gpt-4o-2024-08-06 | 595 | 595 | 0 | 51 | 51 | 0 | SUCCESS | PASS |
| b1bce3d3-b293-449e-afdd-3e0ff25ec4e6 | Sentiment Analysis Agent | gpt-4o-2024-08-06 | 594 | 594 | 0 | 55 | 55 | 0 | SUCCESS | PASS |
| a9c6737a-800d-448c-a7bd-2135f9a3f55f | Sentiment Analysis Agent | gpt-4o-2024-08-06 | 594 | 594 | 0 | 49 | 49 | 0 | SUCCESS | PASS |

## Totals

| | Raw (OpenAI) | Logged (DB) | Dashboard | Δ logged-raw | Δ dashboard-raw |
|---|---:|---:|---:|---:|---:|
| Input tokens | 4971 | 4971 | 4971 | 0 | 0 |
| Output tokens | 583 | 583 | 583 | 0 | 0 |

Totals: **PASS**. Logged rows without a matching raw response: **0**.

## Samples

| Agent | # | Outcome |
|---|---:|---|
| CV Classification Agent | 1 | completed (run 60a5e5f5-af8b-47ac-aeb2-520aba51a543) |
| CV Classification Agent | 2 | completed (run 6efa5e54-d4ad-484d-b4aa-b345a74ff7e3) |
| CV Classification Agent | 3 | completed (run 7936ab61-6248-4fde-b29e-6aaae9fce2aa) |
| Sentiment Analysis Agent | 1 | completed (run 4caccbff-711c-4217-aa8d-6fd36892ade5) |
| Sentiment Analysis Agent | 2 | completed (run b1bce3d3-b293-449e-afdd-3e0ff25ec4e6) |
| Sentiment Analysis Agent | 3 | completed (run a9c6737a-800d-448c-a7bd-2135f9a3f55f) |

A failed sample (e.g. the model response failed validation) still produces real, logged provider calls; those calls are audited above like any other.
