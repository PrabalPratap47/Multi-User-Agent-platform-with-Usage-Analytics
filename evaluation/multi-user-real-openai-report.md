# Multi-User Real OpenAI Verification (Step 16)

**Overall: PASS** · 72/72 checks passed · generated 2026-10-09T04:46:56.974Z

## REAL OPENAI

Everything in this section used the **real OpenAI API**. It ran on the real application: a fresh database seeded by the real seed script, real logins (`POST /api/auth/login`) as user1, user2, user3 and admin, and the real HTTP endpoints. Calls went through the production OpenAI adapter, wrapped only by a recording `fetch` that reads each raw response (id, model, usage) and counts calls in flight. Token values come directly from OpenAI's `usage.prompt_tokens` / `usage.completion_tokens`.

- **API key source:** backend/.env.local (the value is never printed)
- **Configured model:** gpt-4o
- **Real OpenAI calls:** 11 (11 HTTP 200)
- **Raw OpenAI tokens:** 9520 input / 1265 output
- **Estimated cost of this run:** $0.0364
- **Peak concurrent OpenAI calls:** 3

| Area | Result |
|---|---|
| user1: both agents (real OpenAI) | PASS |
| user2: both agents (real OpenAI) | PASS |
| user3: both agents (real OpenAI) | PASS |
| CV Classification Agent (real OpenAI) | PASS |
| Sentiment Agent (real OpenAI) | PASS |
| Real concurrency | PASS |
| User isolation | PASS |
| Admin access | PASS |
| Usage logging | PASS |
| Concurrent decisions | PASS |

### Concurrency evidence (user1 and user2 classifying CVs at the same time)

| | user1 | user2 |
|---|---|---|
| HTTP request | 04:46:51.633 → 04:46:53.077 | 04:46:51.634 → 04:46:53.875 |
| OpenAI call | 04:46:51.682 → 04:46:52.971 | 04:46:51.722 → 04:46:53.800 |
| Stored run (start → complete) | 04:46:51.675 → 04:46:53.056 | 04:46:51.711 → 04:46:53.859 |

Peak concurrent OpenAI calls: **2** (concurrency A), **3** (concurrency B: user1 sentiment, user2 CV and user3 sentiment at once). Times are UTC.

### Agent runs

| User | Phase | Agent | Run ID | Model output | Expected (informational) | HTTP time |
|---|---|---|---|---|---|---:|
| user1 | Test 1 - user1 | CV Classification | 34982d26-3f6d-4ddb-8526-6c538aa364f2 | Back-End Developer | Back-End Developer | 2199 ms |
| user2 | Test 2 - user2 | CV Classification | ee0ed32c-3adb-4472-8dc5-5c7adf78fd3c | Front-End Developer | Front-End Developer | 1741 ms |
| user3 | Test 3 - user3 | CV Classification | f7664d8f-6818-4ab5-ae81-ac9a1ddcabb4 | Web Automation | Web Automation | 1920 ms |
| user1 | Concurrency A | CV Classification | 65f5c4fe-ca8d-43a3-aaf7-36105bcc7fe4 | AI Engineer | AI Engineer | 1444 ms |
| user2 | Concurrency A | CV Classification | 5844ecb8-cbe6-4072-8a49-143c1e05e4ab | Mobile Automation | Mobile Automation | 2241 ms |
| user2 | Concurrency B | CV Classification | 84ba574f-a70f-4432-b100-b2ef524001ea | Chatbot Application Tester | Chatbot Application Tester | 1866 ms |
| user1 | Test 1 - user1 | Sentiment | e9c209a6-6151-4e43-9b72-49e321409d7e | POSITIVE | positive | 1233 ms |
| user2 | Test 2 - user2 | Sentiment | 597b0e24-95a3-4294-955f-7c011b6b10a4 | NEGATIVE | negative | 1297 ms |
| user3 | Test 3 - user3 | Sentiment | bb12e1e0-7553-4110-b40f-b2b10c7d26d7 | NEUTRAL | neutral | 1085 ms |
| user1 | Concurrency B | Sentiment | a2437ffe-c1a7-48be-b985-a4f4a8d8ca5b | POSITIVE | positive | 1716 ms |
| user3 | Concurrency B | Sentiment | 0903d346-84c1-4c62-9f7e-8d49b60f11c9 | NEGATIVE | negative | 1955 ms |

"Expected" is what a reader would anticipate; the real model's answer is reported as returned and is not a pass/fail criterion. Grounding of CV evidence in that user's own CV is a pass/fail check.

### Usage logs vs. raw OpenAI responses (every real call)

| User | Agent | Run ID | Model | Raw in | Logged in | Raw out | Logged out | Total | Latency | Status | Cost (USD) | Response id stored | Result |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|
| user1 | CV Classification Agent | 34982d26-3f6d-4ddb-8526-6c538aa364f2 | gpt-4o-2024-08-06 | 1092 | 1092 | 202 | 202 | 1294 | 2059 ms | SUCCESS | 0.004750 | yes | PASS |
| user1 | Sentiment Analysis Agent | e9c209a6-6151-4e43-9b72-49e321409d7e | gpt-4o-2024-08-06 | 604 | 604 | 54 | 54 | 658 | 1149 ms | SUCCESS | 0.002050 | yes | PASS |
| user2 | CV Classification Agent | ee0ed32c-3adb-4472-8dc5-5c7adf78fd3c | gpt-4o-2024-08-06 | 1087 | 1087 | 157 | 157 | 1244 | 1638 ms | SUCCESS | 0.004288 | yes | PASS |
| user2 | Sentiment Analysis Agent | 597b0e24-95a3-4294-955f-7c011b6b10a4 | gpt-4o-2024-08-06 | 602 | 602 | 62 | 62 | 664 | 1236 ms | SUCCESS | 0.002125 | yes | PASS |
| user3 | CV Classification Agent | f7664d8f-6818-4ab5-ae81-ac9a1ddcabb4 | gpt-4o-2024-08-06 | 1085 | 1085 | 154 | 154 | 1239 | 1775 ms | SUCCESS | 0.004253 | yes | PASS |
| user3 | Sentiment Analysis Agent | bb12e1e0-7553-4110-b40f-b2b10c7d26d7 | gpt-4o-2024-08-06 | 606 | 606 | 52 | 52 | 658 | 1007 ms | SUCCESS | 0.002035 | yes | PASS |
| user1 | CV Classification Agent | 65f5c4fe-ca8d-43a3-aaf7-36105bcc7fe4 | gpt-4o-2024-08-06 | 1081 | 1081 | 153 | 153 | 1234 | 1310 ms | SUCCESS | 0.004233 | yes | PASS |
| user2 | CV Classification Agent | 5844ecb8-cbe6-4072-8a49-143c1e05e4ab | gpt-4o-2024-08-06 | 1083 | 1083 | 140 | 140 | 1223 | 2080 ms | SUCCESS | 0.004108 | yes | PASS |
| user1 | Sentiment Analysis Agent | a2437ffe-c1a7-48be-b985-a4f4a8d8ca5b | gpt-4o-2024-08-06 | 601 | 601 | 50 | 50 | 651 | 1211 ms | SUCCESS | 0.002002 | yes | PASS |
| user2 | CV Classification Agent | 84ba574f-a70f-4432-b100-b2ef524001ea | gpt-4o-2024-08-06 | 1078 | 1078 | 182 | 182 | 1260 | 1637 ms | SUCCESS | 0.004515 | yes | PASS |
| user3 | Sentiment Analysis Agent | 0903d346-84c1-4c62-9f7e-8d49b60f11c9 | gpt-4o-2024-08-06 | 601 | 601 | 59 | 59 | 660 | 1594 ms | SUCCESS | 0.002093 | yes | PASS |

### Per-user totals (admin view vs. raw OpenAI usage)

| User | Raw OpenAI input | Admin dashboard input | Raw OpenAI output | Admin dashboard output | Calls |
|---|---:|---:|---:|---:|---:|
| user1 | 3378 | 3378 | 459 | 459 | 4 |
| user2 | 3850 | 3850 | 541 | 541 | 4 |
| user3 | 2292 | 2292 | 265 | 265 | 3 |

### All checks

| Section | Check | Result | Detail |
|---|---|---|---|
| Login | user1 logs in through POST /api/auth/login | PASS |  |
| Login | user1: identity comes from the session token | PASS |  |
| Login | user2 logs in through POST /api/auth/login | PASS |  |
| Login | user2: identity comes from the session token | PASS |  |
| Login | user3 logs in through POST /api/auth/login | PASS |  |
| Login | user3: identity comes from the session token | PASS |  |
| Login | admin logs in through POST /api/auth/login | PASS |  |
| Login | admin: identity comes from the session token | PASS |  |
| Test 1 - user1 | user1: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 1 - user1 | user1: result, CV document and run all belong to user1 | PASS |  |
| Test 1 - user1 | user1: the stored CV is user1's own text | PASS |  |
| Test 1 - user1 | user1: the model's evidence is grounded in user1's own CV | PASS | category Back-End Developer (expected Back-End Developer) |
| Test 1 - user1 | user1: Sentiment Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 1 - user1 | user1: sentiment result and run belong to user1 | PASS | sentiment POSITIVE (expected positive) |
| Test 2 - user2 | user2: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 2 - user2 | user2: result, CV document and run all belong to user2 | PASS |  |
| Test 2 - user2 | user2: the stored CV is user2's own text | PASS |  |
| Test 2 - user2 | user2: the model's evidence is grounded in user2's own CV | PASS | category Front-End Developer (expected Front-End Developer) |
| Test 2 - user2 | user2: Sentiment Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 2 - user2 | user2: sentiment result and run belong to user2 | PASS | sentiment NEGATIVE (expected negative) |
| Test 3 - user3 | user3: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 3 - user3 | user3: result, CV document and run all belong to user3 | PASS |  |
| Test 3 - user3 | user3: the stored CV is user3's own text | PASS |  |
| Test 3 - user3 | user3: the model's evidence is grounded in user3's own CV | PASS | category Web Automation (expected Web Automation) |
| Test 3 - user3 | user3: Sentiment Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Test 3 - user3 | user3: sentiment result and run belong to user3 | PASS | sentiment NEUTRAL (expected neutral) |
| Concurrency A | user1: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Concurrency A | user1: result, CV document and run all belong to user1 | PASS |  |
| Concurrency A | user1: the stored CV is user1's own text | PASS |  |
| Concurrency A | user1: the model's evidence is grounded in user1's own CV | PASS | category AI Engineer (expected AI Engineer) |
| Concurrency A | user2: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Concurrency A | user2: result, CV document and run all belong to user2 | PASS |  |
| Concurrency A | user2: the stored CV is user2's own text | PASS |  |
| Concurrency A | user2: the model's evidence is grounded in user2's own CV | PASS | category Mobile Automation (expected Mobile Automation) |
| Concurrency A | HTTP requests overlapped (user1 start < user2 end AND user2 start < user1 end) | PASS | user1 1444 ms, user2 2241 ms |
| Concurrency A | real OpenAI calls overlapped | PASS |  |
| Concurrency A | peak concurrent OpenAI calls >= 2 | PASS | peak 2 |
| Concurrency A | stored run start/complete intervals overlapped | PASS |  |
| Concurrency A | distinct run ids | PASS |  |
| Concurrency B | user1: Sentiment Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Concurrency B | user1: sentiment result and run belong to user1 | PASS | sentiment POSITIVE (expected positive) |
| Concurrency B | user2: CV Classification Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Concurrency B | user2: result, CV document and run all belong to user2 | PASS |  |
| Concurrency B | user2: the stored CV is user2's own text | PASS |  |
| Concurrency B | user2: the model's evidence is grounded in user2's own CV | PASS | category Chatbot Application Tester (expected Chatbot Application Tester) |
| Concurrency B | user3: Sentiment Agent (real OpenAI) -> HTTP 201 | PASS |  |
| Concurrency B | user3: sentiment result and run belong to user3 | PASS | sentiment NEGATIVE (expected negative) |
| Concurrency B | three users and both agents overlapped | PASS | peak 3 |
| Concurrency B | peak concurrent OpenAI calls >= 2 | PASS | peak 3 |
| Decisions | MODIFY and REJECT without a reason are rejected (400) | PASS |  |
| Decisions | concurrent user1 MODIFY and user2 REJECT each attached to their own CV, run and user | PASS |  |
| Decisions | original recommendations unchanged | PASS |  |
| Isolation | user1 -> user2: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user2 -> user1: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user1 -> user3: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user2 -> user3: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user3 -> user1: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user3 -> user2: CV result, decisions, decision submit, re-classify CV, sentiment, usage logs all denied | PASS | 403/403/403/403/403/403; OpenAI calls triggered: 0 |
| Isolation | user1's CV, sentiment and usage-log lists contain only user1's rows | PASS |  |
| Isolation | user1's dashboard summary equals user1's own real usage only | PASS | 3378 in / 459 out |
| Isolation | user2's CV, sentiment and usage-log lists contain only user2's rows | PASS |  |
| Isolation | user2's dashboard summary equals user2's own real usage only | PASS | 3850 in / 541 out |
| Isolation | user3's CV, sentiment and usage-log lists contain only user3's rows | PASS |  |
| Isolation | user3's dashboard summary equals user3's own real usage only | PASS | 2292 in / 265 out |
| Usage logging | every successful real OpenAI call has a matching usage log (user, agent, model, tokens, latency, status, cost, run, response id) | PASS | 11/11 rows exact |
| Usage logging | no usage log row without a real OpenAI response | PASS | 0 unmatched |
| Usage logging | no failed (non-200) OpenAI responses | PASS | 0 non-200 |
| Admin | admin global summary = database totals = raw OpenAI usage totals | PASS | input 9520 / output 1265 |
| Admin | per-user breakdown lists all three users with their exact raw OpenAI token totals | PASS |  |
| Admin | per-agent breakdown matches raw OpenAI usage for both agents | PASS |  |
| Admin | admin sees all three users' CV and sentiment results | PASS |  |
| Admin | regular users are denied the admin per-user view (403) | PASS |  |

## CONTROLLED (provider stub, not real OpenAI)

`backend/tests/multiUserConcurrency.test.ts` (30 tests, part of `npm test`) runs the same multi-user, isolation, concurrency, usage-logging and concurrent-decision checks with a **scripted provider stub** in place of OpenAI. It proves the application pipeline deterministically on every test run. It is **not** evidence about the real OpenAI API.

Re-run this verification with `cd backend && npm run verify:multi-user-real-openai` (about 11 short gpt-4o calls). Database used: `backend/data/multi-user-real.db` (git-ignored, recreated on each run).
