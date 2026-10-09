# Documentation Review and Setup Verification (Step 20)

Date: 2026-10-09. Environment: Windows 10 Pro 10.0.19045, Node.js 24.21.0, npm 12.0.2, Windows PowerShell 5.1.19041, Git Bash, Google Chrome (headless, via `playwright-core`).

Every result below comes from a command that was actually run. Items that were only inspected are labelled as such.

## Round 1: review against the code

**What was reviewed.** All 22 documentation files were compared with the code, package scripts, env templates, Prisma schema and migrations, routes, agents, analytics and the test reports.

**Corrections.**

- **README.md.** Rewritten as the entry point. It had listed implemented features as TODO, and its endpoint list was incomplete.
- **QUICK_START.md.** It claimed tokens are stored in an httpOnly cookie; they are in `localStorage`.
- **ARCHITECTURE.md.** Its Docker, CI, charts, register endpoint and CSP were not implemented. It now has an implementation-notes table, and five false checklist ticks are fixed.
- **backend/TESTING.md.** It described the identity model from before the session-based fix.
- **docs/DATABASE.md.** Two of the three migrations were missing.
- **docs/ANALYTICS_API.md and docs/PROMPT_INJECTION_SECURITY.md.** They still said they were "not verified".
- **docs/BATCH_CV_PROCESSING.md.** Referenced by the code but did not exist; it was written.
- **Historical scaffold files.** The four snapshots were marked as historical.

**Commands run in round 1:**

| Command | Result |
|---|---|
| Doc check script: every `npm run X` in 16 docs exists; relative links, anchors and quoted paths resolve | PASS. The only remaining hits are two deliberate mentions of `backend/.env` ("must not exist") |
| `npm run typecheck` (root, both workspaces) | PASS |
| `npm test` (backend) | 313/313 |
| `npm run dev` (backend, `BACKEND_PORT=3199` from the environment) | The 4 documented log lines appeared; `GET /health` returned `{"status":"ok","message":"Server is healthy"}` |
| `npx dotenv -e .env.local -- prisma migrate status` | Works. Reports that the developer's `dev.db` lacks `20261008120000_usage_log_provider_response_id`, with exit 1 while it is pending |
| README eval-DB preparation, bash variant, on a throwaway DB | migrate and seed passed; the paid evaluation was not run |
| `npm audit` (read-only) | 22 findings (3 with `--omit=dev`), unchanged |
| Secret scan of 31 docs and reports, plus the whole repository | The API key exists only in `backend/.env.local`; no JWT secret, real key or token appears in any doc |

## Round 2: fresh setup and the remaining workflows

### Method: an isolated copy, not the developer's checkout

**Why not `git clone`.** A literal `git clone` is not possible, because the repository has no commits; a clone would be empty.

**What was used instead.** The exact file set a first commit would contain: the 195 files from `git ls-files --others --exclude-standard`. These are all files not excluded by `.gitignore`, so the set has no `node_modules`, no `.env.local`/`.env.test`, no `*.db` and no `dist`. It was checked to contain only the four `*.example` env templates, and it includes `backend/data/.gitkeep`.

**Where it ran.** The files were copied to an isolated scratch directory outside the repository. Every command below ran inside that copy, with its own databases. The developer's `backend/data/dev.db` was never opened by these commands.

### Results

| # | Workflow | Exact command(s) | Result |
|---|---|---|---|
| 1 | Install | `npm install` (copy root) | PASS: exit 0, 638 packages, about 3 min. npm 12 printed "install scripts blocked" for `@prisma/client`, `@prisma/engines`, `prisma` and `esbuild` (×2), but the workspace's own `postinstall` still generated the Prisma Client. The engines and the esbuild `win32-x64` binary were present. |
| 2 | Env files (PowerShell) | `Copy-Item .env.example .env.local`, `Copy-Item .env.test.example .env.test`, then `JWT_SECRET` set from the README's `node -e "...randomBytes(32)..."`. `OPENAI_API_KEY` left empty. | PASS (secret not printed) |
| 3 | Database setup | `npm run db:setup` (copy `backend\`, PowerShell) | PASS: exit 0. Created the copy's `dev.db`, applied 3 migrations, and printed the seed output exactly as SETUP.md documents. |
| 4 | Test suite | `npm test` (copy `backend/`) | PASS: 17 files, 313/313, 120 s |
| 5 | Backend startup | `npm run dev` (copy `backend/`, default port 3001) | PASS: `GET /health` 200. Logged `Server running on http://localhost:3001`, `Environment: development`, `Frontend URL: http://localhost:5173`, `OpenAI model: gpt-4o` and the documented empty-key warning. |
| 6 | Frontend dev server | `npm run dev` (copy `frontend/`, `BROWSER=none` only so that no window opens on the desktop) | PASS: `http://localhost:5173` returned 200 |
| 7 | QUICK_START `curl` (bash) | `curl -s http://localhost:3001/health`; `curl -s -X POST .../api/auth/login -H "Content-Type: application/json" -d "{...}"` | PASS: the documented health body; login returned `success=true` with `accessToken`/`refreshToken`/`user` |
| 8 | Browser login and navigation (dev server) | Chrome on `http://localhost:5173` | PASS (see below) |
| 9 | Production build | `npm run build` (copy `frontend/`) | PASS: built in 37.7 s |
| 10 | Preview | `npm run preview` | Serves `http://localhost:4173` (PASS, and the demo-credentials box is absent). **Login FAILED with the default settings:** the browser's CORS check blocked every API call because the backend allows only `FRONTEND_URL=http://localhost:5173`, and the UI showed "Could not reach the server". This is a documentation gap, not a code defect: with `FRONTEND_URL=http://localhost:4173` (backend restarted), the same preview passed every browser check. README and SETUP now document this. |
| 11 | Prisma Studio | `npm run db:studio -- --browser none` (copy `backend/`) | PASS: "Prisma Studio is up on http://localhost:5555", HTTP 200, on the copy's database. Only the server was checked, not the Studio UI. |
| 12 | PowerShell: `&&` lines | `cd . && echo ...` in Windows PowerShell 5.1 | Fails: "The token '&&' is not a valid statement separator in this version." Now documented in README, SETUP and QUICK_START. |
| 13 | PowerShell: QUICK_START `curl` | The documented lines, as written | `curl http://localhost:3001/health` works (PowerShell's `curl` is `Invoke-WebRequest`; tested with `-UseBasicParsing`). **The login line fails:** "Cannot bind parameter 'Headers'". The documented replacements were run exactly as written and both returned `success=True`: `curl.exe -s -X POST ... -d '{\"email\":...}'` and `Invoke-RestMethod -Method Post ...`. |
| 14 | PowerShell: eval-DB variant | `$env:DATABASE_URL = "file:../data/cv-eval.db"`, then `node ../node_modules/prisma/build/index.js migrate deploy; npm run db:seed` (the paid evaluation was not run) | PASS: migrate exit 0, seed exit 0, on a throwaway DB in the copy |

Row 8 in detail (dev server):

- A failed login showed "Invalid email or password".
- `admin@example.com` saw 6 tabs, including ADMIN USERS; `user1@example.com` saw 5. Every tab loaded without an error state.
- Both users logged out back to the login form.
- The demo-credentials box was shown.

### The developer's database was not touched

`backend/data/dev.db` fingerprint before and after all of the above (SHA-256 prefix, size, mtime):

| | SHA-256 (first 16) | Size | Modified (UTC) |
|---|---|---|---|
| Before round 2 | `127e2cf5fcae0857` | 208,896 | 2026-10-08 07:01:57 |
| After round 2 | `127e2cf5fcae0857` | 208,896 | 2026-10-08 07:01:57 |

It is still missing migration `20261008120000_usage_log_provider_response_id`. Apply it with `npm run db:migrate:deploy` when convenient; this review did not.

## Not verified / limitations

- **Literal `git clone`.** Not possible until the repository has a commit. The commit-equivalent copy above is the substitute.
- **One environment.** Only Windows 10, Node 24.21.0, npm 12.0.2. macOS, Linux, other Node/npm versions and PowerShell 7 were not tested.
- **Paid workflows.** The real-OpenAI workflows (`eval:cv-classification`, `verify:*-real-openai`, `audit:logging-accuracy`, and real CV/sentiment calls from the UI) were not run here. Their last evidence is in `evaluation/`.
- **Prisma Studio.** Only the server start was checked, not its UI.
- **Interactive login.** Browser login was automated in headless Chrome; no manual or other-browser login was done.
- **Automatic browser opening.** `npm run dev` (frontend) opens a browser by default (`server.open: true` in `vite.config.ts`). This was suppressed with `BROWSER=none` during the test, so the opening itself was not observed.

## Status

**Step 20: VERIFIED** for the environment above.

- **Setup works from scratch:** install, environment files, `db:setup`, tests and startup were all executed from a clean, commit-equivalent copy.
- **The remaining workflows are covered:** browser login and navigation, build and preview, Prisma Studio, and the PowerShell variants were executed.
- **Gaps found were fixed and re-run:** the two documentation gaps (preview CORS and PowerShell 5.1 syntax) were documented, and the corrected instructions were executed and pass.
- **Remaining limits:** a literal `git clone` and other operating systems are not covered (see above).
