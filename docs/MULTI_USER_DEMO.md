# Multi-User Demo (Step 16)

How to demonstrate that three users use both agents, that two users can work
at the same time, that each user only ever sees their own data, and that the
admin sees everything. Identity always comes from the login token; no user id
is ever sent by the client to say who is making a request.

| User | Email | Password | Role |
|---|---|---|---|
| Admin | admin@example.com | password123 | ADMIN |
| User 1 | user1@example.com | password123 | USER |
| User 2 | user2@example.com | password123 | USER |
| User 3 | user3@example.com | password123 | USER |

These are local demo credentials created by `npm run db:seed` (see `backend/src/db/seed.ts`).

## 0. Prerequisites

- A **valid** OpenAI key, either in `backend/.env.local` (`OPENAI_API_KEY=sk-...`)
  or in the `OPENAI_API_KEY` environment variable. If both are set, the
  environment variable wins. Without a working key the agents return an error
  instead of a result, but every login, isolation and admin step below still works.
- A seeded database with the demo accounts. **Do not re-seed `backend/data/dev.db` if it holds data you want to keep:** `db:seed` deletes every row first. Use a separate demo database instead, exactly as in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) section 1 (PowerShell, in `backend\`):

```powershell
$env:DATABASE_URL = 'file:../data/demo.db'   # check it prints this before continuing
npm run db:setup                             # migrate + seed demo.db only
```

  (bash: `export DATABASE_URL="file:../data/demo.db"`, then `npm run db:setup`.)

- Start the app (two terminals), with the same `DATABASE_URL` set in the backend's terminal:

```bash
cd backend  && npm run dev   # API on http://localhost:3001
cd frontend && npm run dev   # UI on  http://localhost:5173
```

  Sections 1 and 2 below use their own throwaway databases and need neither step.

## 1. Real OpenAI verification

```bash
cd backend
npm run verify:multi-user-real-openai
```

`backend/src/evaluation/runMultiUserRealOpenAI.ts` calls the **real OpenAI
API**. It runs the real application:

- a fresh `backend/data/multi-user-real.db` seeded by the real seed script;
- the Express app on an ephemeral port;
- real logins as user1, user2, user3 and admin;
- the real `/api/cv/*`, `/api/sentiment/*`, `/api/usage-logs` and `/api/analytics/*` endpoints.

OpenAI is called through the production adapter. The only addition is a
recording `fetch` that reads each raw response (id, model, `usage`) and counts
calls in flight; it never records headers. The run:

- **Both agents for every user.** Each result, CV, run and usage log must belong to that user, and each CV's evidence must be grounded in that user's own CV.
- **Real concurrency.**
  - A: user1 and user2 classify CVs at the same time.
  - B: user1 sentiment, user2 CV and user3 sentiment at the same time.
  - Overlap is proven by HTTP request times, real OpenAI call times with a peak in-flight count, and stored run start/complete times.
- **Concurrent decisions** (MODIFY and REJECT by two users), plus the reason requirement.
- **Cross-user denial** for all 6 user pairs: 403, no data, no OpenAI call triggered.
- **Usage logs.** Every real call is matched to its log row by OpenAI response id, comparing user, agent, model, tokens, latency, status, cost and run.
- **Admin views.** Global, per-user and per-agent totals must equal the raw OpenAI usage.

Output: `evaluation/multi-user-real-openai-report.md` (and `.json`). Last run
(2026-10-09): **72/72 checks PASS, 11 real OpenAI calls (all HTTP 200), peak 3
concurrent OpenAI calls, cost about $0.04.** It covers the CV and sentiment
agents only. It needs a valid `OPENAI_API_KEY` in
`backend/.env.local` with no conflicting `OPENAI_API_KEY` environment variable,
which would take precedence.

## 2. Automated pipeline proof without OpenAI (controlled)

```bash
cd backend
npm test -- multiUserConcurrency
```

`backend/tests/multiUserConcurrency.test.ts` (30 tests) runs the real seed
script against the test database, logs in user1, user2, user3 and admin
through `POST /api/auth/login`, and then exercises the real API. It covers:

- **Both agents for every user.** Each run is checked for the correct user id, agent name, run id, timestamps, status, CV document owner and usage log.
- **Concurrency.** user1 and user2 classify CVs at the same time (`Promise.all`). Overlap is shown by HTTP request start/end times, provider call start/end times with 2 calls in flight at once, and the overlapping start/complete times of the stored runs. The evidence is printed as `[Step 16 concurrency evidence] {...}`. A second check runs three users and both agents at once.
- **Usage logs.** Every field is checked (userId, agentName, model, input/output tokens, latencyMs, status, runId, timestamp). Each response has unique token counts, so usage credited to the wrong user would fail the test.
- **Concurrent decisions.** user1 and user2 submit decisions at the same time; each is stored against the submitter's own CV and run.
- **Cross-user denial (403)** for user1→user2, user2→user1 and user3→user1/user2: CV result, decisions, decision submit, re-classifying the CV, sentiment result, batch status and usage logs. Lists and `?userId=` overrides never return another user's rows.
- **Admin access** to every user's records, the global lists and the global analytics, matched against the database.
- **Dashboard isolation.** Every analytics endpoint the dashboard calls is checked against the database, per user.

> **This test uses a scripted provider in place of OpenAI** (installed through
> the existing agent test hooks). Everything else is the real application. It
> proves the multi-user, concurrency and logging pipeline, not OpenAI's answers.

## 3. In the browser

The session token is stored in `localStorage`, which is shared by all tabs of
one browser profile. **Use a separate window per user**: a normal window and a
private/InPrivate window, or two different browsers.

1. **User1 login.** Window A → http://localhost:5173 → sign in as user1.
2. **User2 login.** Window B (private window) → sign in as user2.
3. **User3 login.** Window C (another browser, or after finishing with A) → sign in as user3.
4. **Both agents per user.** In each window:
   - **CV PROCESSING** tab: upload a `.txt` CV → *Classify CV*.
   - **SENTIMENT** tab: enter feedback → *Analyze sentiment*.
5. **Concurrent user1/user2 activity.** Select a CV in both window A and window B, then click *Classify CV* in A and immediately in B. Both show *Processing* at the same time and complete independently.
6. **Isolation.** In each user's window, the **ANALYTICS**, **MY RECORDS**, **CV PROCESSING** and **SENTIMENT** tabs show only that user's results, decisions, token usage and costs. The data comes from backend responses that are already filtered to that user, not hidden by the UI.
7. **Admin global access.** Sign in as admin in a separate window:
   - **ANALYTICS** shows global totals plus a per-user breakdown.
   - **ADMIN USERS** lists all accounts.
   - **CV PROCESSING** and **SENTIMENT** list every user's results; the sentiment list shows each owner's email.

## 4. Directly against the API (Windows PowerShell)

Run these with the backend running on port 3001.

```powershell
$api = 'http://localhost:3001/api'
function Get-Token($email) {
  $body = @{ email = $email; password = 'password123' } | ConvertTo-Json
  (Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType 'application/json' -Body $body).data.accessToken
}
function Auth($token) { @{ Authorization = "Bearer $token" } }

$t1 = Get-Token 'user1@example.com'
$t2 = Get-Token 'user2@example.com'
$t3 = Get-Token 'user3@example.com'
$ta = Get-Token 'admin@example.com'

# Who am I? (identity comes from the token)
(Invoke-RestMethod -Uri "$api/auth/me" -Headers (Auth $t1)).data
```

**Concurrent user1/user2 CV classification.** The two requests run in separate background jobs, so they really are in flight at the same time; the printed times show the overlap.

```powershell
$classify = {
  param($api, $token, $label, $cv)
  $start = Get-Date
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$api/cv/classify" -Headers @{ Authorization = "Bearer $token" } `
      -ContentType 'application/json' -Body (@{ cvContent = $cv; fileName = "$label.txt" } | ConvertTo-Json)
    $outcome = "result $($r.data.id), run $($r.data.runId), user $($r.data.userId)"
  } catch { $outcome = "failed: $($_.ErrorDetails.Message)" }
  "{0}: {1:HH:mm:ss.fff} -> {2:HH:mm:ss.fff}  {3}" -f $label, $start, (Get-Date), $outcome
}
$j1 = Start-Job $classify -ArgumentList $api, $t1, 'user1', 'Backend engineer, 6 years of Node.js and Express REST APIs.'
$j2 = Start-Job $classify -ArgumentList $api, $t2, 'user2', 'Frontend developer building React and TypeScript apps.'
Wait-Job $j1, $j2 | Receive-Job
```

**Sentiment for a user:**

```powershell
Invoke-RestMethod -Method Post -Uri "$api/sentiment/analyze" -Headers (Auth $t3) -ContentType 'application/json' `
  -Body (@{ text = 'The new dashboard is great and support was quick.' } | ConvertTo-Json)
```

**Isolation.** Each user's lists contain only their own rows, and another user's ids are refused:

```powershell
$u2Results = (Invoke-RestMethod -Uri "$api/cv/results" -Headers (Auth $t2)).data
(Invoke-RestMethod -Uri "$api/cv/results" -Headers (Auth $t1)).data | Select-Object id, userId

# user1 asking for user2's result -> HTTP 403
try { Invoke-RestMethod -Uri "$api/cv/results/$($u2Results[0].id)" -Headers (Auth $t1) } catch { $_.Exception.Response.StatusCode.value__ }

# user1 asking for user2's usage logs -> HTTP 403
$u2Id = (Invoke-RestMethod -Uri "$api/auth/me" -Headers (Auth $t2)).data.id
try { Invoke-RestMethod -Uri "$api/usage-logs/$u2Id" -Headers (Auth $t1) } catch { $_.Exception.Response.StatusCode.value__ }

# a ?userId= override is ignored for a regular user: still user1's own totals
(Invoke-RestMethod -Uri "$api/analytics/summary?userId=$u2Id" -Headers (Auth $t1)).data
```

**Admin global access:**

```powershell
(Invoke-RestMethod -Uri "$api/analytics/summary" -Headers (Auth $ta)).data    # global totals
(Invoke-RestMethod -Uri "$api/analytics/by-user" -Headers (Auth $ta)).data    # per-user breakdown
(Invoke-RestMethod -Uri "$api/users" -Headers (Auth $ta)).data                # all accounts
(Invoke-RestMethod -Uri "$api/cv/results" -Headers (Auth $ta)).data | Group-Object userId | Select-Object Name, Count
(Invoke-RestMethod -Uri "$api/usage-logs/$u2Id" -Headers (Auth $ta)).data | Select-Object -First 3 userId, agentName, inputTokens, outputTokens
```

## Routes used

| Purpose | Route |
|---|---|
| Login / current identity | `POST /api/auth/login`, `GET /api/auth/me` |
| CV agent | `POST /api/cv/classify`, `POST /api/cv/batch`, `GET /api/cv/batch/:batchId/status`, `GET /api/cv/results(/:id)`, `POST /api/cv/results/:id/decision` |
| Sentiment agent | `POST /api/sentiment/analyze`, `GET /api/sentiment/results(/:id)` |
| Usage logs | `GET /api/usage-logs` (own; all for admin), `GET /api/usage-logs/:userId` (self or admin, else 403) |
| Agent runs | `GET /api/runs` (own; all active users for admin, optional `?userId=` for admin), `GET /api/runs/:id` (owner or admin, else 403) |
| Dashboard analytics | `GET /api/analytics/summary`, `/by-agent`, `/runs`, `/errors`, `/latency`, `/acceptance-rate`, `/time-saved` (own; global for admin) |
| Admin only | `GET /api/users` (and user management: `POST /api/users`, `PUT /api/users/:id/password`, `DELETE /api/users/:id`), `GET /api/analytics/by-user`, the `DELETE` routes for CV documents, sentiment results and skills-gap analyses |
