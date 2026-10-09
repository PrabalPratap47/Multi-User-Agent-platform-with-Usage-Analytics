# Multi-User Agent Platform with Usage Analytics - Architecture

**Date**: 2026-10-06  
**Status**: Original design proposal, written before implementation. The implemented system is described in [README.md](README.md) and `docs/`.

> **Implementation notes (reviewed 2026-10-09).** Parts of this design were built differently or not at all. Where this document and the code disagree, the code and README.md are authoritative:
>
> | This document says | Implemented |
> |---|---|
> | JWT + secure **httpOnly cookies**; refresh token is a JWT in a cookie | Access token sent as `Authorization: Bearer`. The refresh token is an opaque random value, stored server-side as a SHA-256 hash and sent in the request body. **The browser keeps both tokens in `localStorage`** (a recorded residual risk; see docs/SECURITY_AUDIT.md). Each request resolves the token's session and role from the database. |
> | `POST /api/auth/register` | No registration endpoint. Accounts come from `npm run db:seed` (demo, local only). |
> | CSP headers; CORS allowlist `localhost:3000` | No Content-Security-Policy header is set. CORS allows exactly `FRONTEND_URL` (default `http://localhost:5173`). |
> | `.env.local` holds a DB password | SQLite: no database server and no password. |
> | Docker, CI/CD, deployment guide, user guide, API docs (§13, §14 Phase 7) | None of these exist. Setup is in README.md/SETUP.md; endpoints are listed in README.md and docs/ANALYTICS_API.md. |
> | Charts; real-time updates via WebSocket | The dashboard uses stat cards and tables (no charts). Batch progress is polled. |
> | Evaluation set of 20 samples (Appendix C) | `evaluation/datasets/cv-classification-eval-v1.json`: 27 samples (3 per category). |
> | E2E tests with Selenium/Playwright (§12) | Real-OpenAI E2E runner (`verify:e2e-real-openai`, API level) and Chrome checks through `playwright-core` (`verify:ui`, `verify:dashboard-run-outcomes`). |

## 1. Executive Summary

A full-stack web application enabling multiple authenticated users to leverage AI agents for CV classification and sentiment analysis, with comprehensive usage tracking, role-based access control, and detailed analytics dashboards. The platform prioritizes security (user data isolation), accuracy (real token counts from API), and auditability (detailed logging).

---

## 2. Tech Stack Decisions

### Frontend
- **Framework**: React 18 (TypeScript)
- **Why**: Component-based, rich ecosystem for dashboards, mature tooling
- **State Management**: Zustand or Redux Toolkit
- **Styling**: Tailwind CSS + shadcn/ui components
- **Charts**: Recharts or Chart.js (accessible, responsive)
- **Build**: Vite (fast dev/prod builds)

### Backend
- **Runtime**: Node.js (LTS)
- **Framework**: Express.js
- **Why**: Lightweight, excellent middleware ecosystem, easy LLM integration, straightforward to demo
- **Language**: JavaScript/TypeScript for consistency
- **ORM**: Prisma (type-safe, migrations built-in, excellent DX)

### Database
- **Primary**: SQLite via Prisma 6, one file per environment: `backend/data/dev.db` (development), `backend/data/test.db` (tests)
- **Why**: Relational structure suits users/agents/logs, ACID transactions, foreign keys and CHECK constraints, and zero setup (no database server or credentials) for an academic/local project
- **Access**: Prisma Client only (`backend/src/db/client.ts`); no raw SQL in application code
- **Migrations**: Prisma migrations (`backend/prisma/migrations/`); the earlier PostgreSQL history is archived in `backend/prisma/migrations_postgresql_archive/`
- **Details**: see [docs/DATABASE.md](docs/DATABASE.md) (SQLite-specific differences, CHECK constraints, write-concurrency limits)

### Authentication & Security
- **Auth Strategy**: JWT (stateless) + secure session cookies
- **Password Hashing**: bcryptjs
- **Secrets**: Environment variables via dotenv
- **HTTPS**: Always in production, mocked in dev
- **CORS**: Strict origin allowlisting

### LLM Integration
- **Provider**: OpenAI API
- **Integration**: Official `openai` npm package
- **Model**: gpt-4o (for accuracy) or gpt-4o-mini (for speed/cost trade-off), configured via `OPENAI_MODEL`
- **Structured Output**: Native JSON mode or custom JSON parsing + schema validation

### Monitoring & Logging
- **Application Logging**: Winston (structured JSON logs)
- **Database Logging**: Direct insertion into `LLMUsageLog` table
- **Error Tracking**: In-app error logging (production: optional Sentry)

### DevOps & Deployment
- **Local Development**: Node.js only - `npm install`, then `npm run db:setup` in `backend/` (SQLite, no database server)
- **Deployment**: Containerized (Dockerfile), any cloud provider
- **Environment**: .env.local for secrets

---

## 3. Frontend Architecture

### Directory Structure
```
frontend/
├── src/
│   ├── components/
│   │   ├── Auth/
│   │   │   ├── LoginForm.tsx
│   │   │   ├── ProtectedRoute.tsx
│   │   │   └── RoleGate.tsx
│   │   ├── Dashboard/
│   │   │   ├── AdminDashboard.tsx
│   │   │   ├── UserDashboard.tsx
│   │   │   ├── Analytics/
│   │   │   │   ├── TokenChart.tsx
│   │   │   │   ├── CostChart.tsx
│   │   │   │   ├── LatencyChart.tsx
│   │   │   │   ├── ErrorRateChart.tsx
│   │   │   │   └── CategoryAcceptanceChart.tsx
│   │   │   └── ImportedLogsTab.tsx
│   │   ├── CVProcessing/
│   │   │   ├── CVUpload.tsx
│   │   │   ├── BatchProcessor.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   └── ResultsTable.tsx
│   │   ├── DecisionWorkflow/
│   │   │   ├── CVDecision.tsx
│   │   │   ├── RecommendationCard.tsx
│   │   │   └── FeedbackForm.tsx
│   │   └── Common/
│   │       ├── Layout.tsx
│   │       ├── Navbar.tsx
│   │       └── ErrorBoundary.tsx
│   ├── hooks/
│   │   ├── useAuth.ts
│   │   ├── useAPI.ts
│   │   └── useAnalytics.ts
│   ├── services/
│   │   ├── api.ts (centralized axios instance)
│   │   ├── authService.ts
│   │   ├── cvService.ts
│   │   ├── analyticsService.ts
│   │   └── importService.ts
│   ├── store/
│   │   ├── authStore.ts
│   │   ├── cvStore.ts
│   │   └── analyticsStore.ts
│   ├── types/
│   │   ├── api.ts (API response types)
│   │   ├── domain.ts (business logic types)
│   │   └── UI.ts (component prop types)
│   ├── App.tsx
│   └── main.tsx
├── index.html
└── package.json
```

### Key Features
1. **Role-Based UI**: Admin sees all users' data; User sees only their own
2. **Real-Time Progress**: WebSocket or polling for batch processing
3. **Type Safety**: Full TypeScript with strict mode
4. **Responsive Design**: Mobile-first, works on tablets
5. **Accessibility**: WCAG 2.1 AA compliance (shadcn components help here)

### Authentication Flow
```
User Login → POST /api/auth/login → Backend validates → JWT + refresh token
JWT in Authorization header for all requests
Protected routes check token expiry and role
```

---

## 4. Backend Architecture

### Directory Structure
```
backend/
├── src/
│   ├── controllers/
│   │   ├── authController.ts
│   │   ├── cvController.ts
│   │   ├── analyticsController.ts
│   │   ├── agentController.ts
│   │   └── importController.ts
│   ├── services/
│   │   ├── authService.ts
│   │   ├── cvService.ts
│   │   ├── usageLogService.ts
│   │   ├── analyticsService.ts
│   │   └── importService.ts
│   ├── agents/
│   │   ├── Agent.ts (abstract base)
│   │   ├── CVClassificationAgent.ts
│   │   ├── SentimentAgent.ts
│   │   └── llmWrapper.ts (with logging)
│   ├── middleware/
│   │   ├── authMiddleware.ts (JWT validation)
│   │   ├── errorHandler.ts
│   │   ├── loggingMiddleware.ts
│   │   └── roleGuard.ts (admin-only routes)
│   ├── db/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── dbClient.ts
│   ├── utils/
│   │   ├── validators.ts (JSON schema validation)
│   │   ├── costCalculator.ts
│   │   ├── tokenCounter.ts (from actual API, not estimates)
│   │   └── promptInjectionDefense.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── cv.ts
│   │   ├── analytics.ts
│   │   ├── agents.ts
│   │   └── import.ts
│   ├── config/
│   │   ├── env.ts (validated env variables)
│   │   ├── llm.ts (OpenAI API config)
│   │   └── logging.ts (Winston setup)
│   ├── app.ts (Express app setup)
│   └── server.ts (entry point)
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

### API Endpoints (RESTful)

#### Authentication
- `POST /api/auth/register` - Create user (admin only in this demo)
- `POST /api/auth/login` - Issue JWT token
- `POST /api/auth/refresh` - Refresh expired token
- `POST /api/auth/logout` - Invalidate token

#### CV Processing
- `POST /api/cv/classify` - Single CV classification
- `POST /api/cv/batch` - Upload multiple CVs for batch processing
- `GET /api/cv/batch/:batchId/status` - Poll batch progress
- `GET /api/cv/results` - Get user's classification results (or all if admin)
- `POST /api/cv/:resultId/decision` - User accepts/rejects recommendation

#### Analytics (Admin can query all users; User can query own data only)
- `GET /api/analytics/summary` - Token usage, cost, agent counts
- `GET /api/analytics/tokens?userId=&period=24h|7d|30d` - Token trends
- `GET /api/analytics/cost?userId=&period=24h|7d|30d` - Cost trends
- `GET /api/analytics/by-user` - Token/cost breakdown (admin only)
- `GET /api/analytics/by-agent` - Agent performance stats
- `GET /api/analytics/errors?period=24h|7d|30d` - Error rates by agent
- `GET /api/analytics/latency?agent=` - Latency stats
- `GET /api/analytics/acceptance-rate?category=` - CV recommendation acceptance rates
- `GET /api/analytics/evaluation` - Evaluation metrics (precision, recall, logging accuracy)

#### Agent Management
- `GET /api/agents` - List available agents
- `GET /api/agents/:agentId/logs` - Agent run logs (admin only)

#### Import External Logs
- `POST /api/import/logs` - Upload external agent log file (JSON)
- `GET /api/import/logs` - List imported logs
- `GET /api/import/logs/:importId` - Get imported log details

### Key Services

#### LLMWrapper Service
```typescript
// Pseudocode
class LLMWrapper {
  async call(input: string, agent: string): Promise<{response, usage}> {
    const startTime = performance.now();
    const result = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [...],
    });
    
    // Extract ACTUAL token counts from API response
    const { usage } = result;
    const latency = performance.now() - startTime;
    
    // Log to database immediately
    await usageLogService.create({
      timestamp: new Date(),
      userId: currentUser.id,
      agentName: agent,
      model: 'gpt-4o',
      inputTokens: usage.prompt_tokens,      // ACTUAL, not estimated
      outputTokens: usage.completion_tokens, // ACTUAL, not estimated
      latency,
      status: 'success',
      cost: calculateCost(usage),
    });
    
    return { response: result.content[0].text, usage };
  }
}
```

#### Usage Log Service
- Insert logs synchronously after every LLM call
- Ensure no token loss
- Query logs with user/time/agent filters
- Aggregate for dashboards

#### Analytics Service
- Query `LLMUsageLog` table with aggregations
- Calculate metrics: total tokens, total cost, error rates, latency percentiles
- Generate time-series data for charts

#### Import Service
- Parse uploaded JSON log files
- Validate structure
- Store with import timestamp and source metadata
- Query separately from native logs (different dashboard tab)

---

## 5. Database Schema

**Source of truth**: `backend/prisma/schema.prisma`, applied via the versioned SQLite migrations in `backend/prisma/migrations/` (baseline `20261007000000_init_sqlite` plus two later migrations; the original PostgreSQL migration is archived in `backend/prisma/migrations_postgresql_archive/` - see docs/DATABASE.md). The summary below is kept intentionally short to avoid drifting out of sync with that file again - if anything here disagrees with `schema.prisma`, the schema file wins.

### Tables

| Table | Purpose |
|---|---|
| `users` | Accounts + role (ADMIN/USER) |
| `refresh_tokens` | Server-side session data - hashed opaque refresh tokens, revocable |
| `agents` | The two agent definitions (CV Classification, Sentiment Analysis) |
| `agent_runs` | One row per agent invocation (`id` is a UUID) - the "request/run identifier" referenced by usage logs and results |
| `llm_usage_logs` | Every LLM call: tokens, latency, cost, status, error info, run/user/agent references |
| `cv_documents` | The uploaded CV itself (immutable input) |
| `cv_recommendations` | The LLM's classification output for a document - the **original recommendation**, written once, never mutated |
| `recommendation_decisions` | The human decision on a recommendation (ACCEPT/MODIFY/REJECT) - a separate, append-only table so the original output is never overwritten |
| `sentiment_results` | Sentiment agent output |
| `external_agent_logs` | Imported logs from another agent's log file |

### Key relationships

```
users 1──* agent_runs 1──* llm_usage_logs
users 1──* cv_documents 1──* cv_recommendations 1──* recommendation_decisions
agent_runs 0..1──1 cv_recommendations   (a run produces at most one recommendation)
agent_runs 0..1──1 sentiment_results
```

### Business rules enforced at two layers
- **reason is mandatory for MODIFY/REJECT, optional for ACCEPT** on `recommendation_decisions` - enforced by a Zod refinement (`validators.ts`) for a clean 400, and by a `CHECK` constraint in the migration as a DB-level safety net (Prisma's schema language has no declarative CHECK attribute, so it's appended as raw SQL).
- **`llm_usage_logs.isSeedData`** defaults to `false` and must never be set by real agent code - only `db/seed.ts` sets it `true`, so dashboard/evaluation queries can exclude fabricated demo token counts from real usage data.
- **Denormalized `agentName`** on `agent_runs`/`llm_usage_logs` is a snapshot at write time, not a live join - usage logs are an audit trail and must stay accurate even if an `agents` row is later renamed.

### Indexing strategy
Every table used by a dashboard query is indexed on `(userId, createdAt DESC)` (or the closest equivalent) for the "my records, newest first" access pattern, plus targeted single-column indexes for the columns actually filtered on: `status`, `primaryCategory`, `runId`, `isSeedData`. See `schema.prisma` `@@index` declarations for the authoritative list.

---

## 6. Authentication Architecture

### Approach: JWT + Secure Cookies + Database Sessions

#### User Registration (Hardcoded 3 Demo Users - Admin Only)
```
POST /api/auth/register (admin-only endpoint)
Body: { email, password, role }
Response: { user: { id, email, role }, token: JWT }
```

#### User Login
```
POST /api/auth/login
Body: { email, password }
Response: { 
  accessToken: JWT (expires 15min),
  refreshToken: JWT (expires 7d, stored in httpOnly cookie),
  user: { id, email, role }
}
```

#### Token Structure (JWT Claims)
```json
{
  "sub": "user_id",
  "email": "user@example.com",
  "role": "admin|user",
  "iat": 1234567890,
  "exp": 1234568890
}
```

#### Security Guards
1. **Authentication Middleware**: Validates JWT on every request
2. **Role Guard Middleware**: Checks `role === 'admin'` for sensitive routes
3. **User Isolation**: Queries always filter by `user_id from JWT claim`, never URL params
4. **CORS**: Strict allowlist (localhost:3000 for dev)
5. **HTTPS**: Enforced in production

#### Prevented Attack Vectors
- ✅ URL parameter injection: User ID from JWT, not from query params
- ✅ Token forgery: HMAC-SHA256 signature with secret key
- ✅ Token theft: httpOnly, secure flags on cookies
- ✅ Cross-site scripting: Input sanitization, CSP headers

---

## 7. Agent Architecture

### Base Agent Interface
```typescript
abstract class Agent {
  abstract name: string;
  abstract version: string;
  
  abstract execute(input: string, context: AgentContext): Promise<AgentResult>;
  
  // Logging happens in wrapper, not agent itself
}
```

### CV Classification Agent
**Responsibility**: Parse CV text, classify into one of 9 categories, output structured JSON.

**Prompt Strategy** (Injection-Resistant):
```
You are a CV classifier. Analyze the CV text below and classify it into ONE primary category and up to THREE secondary categories.

[STRICT SCHEMA]
Return ONLY valid JSON (no markdown, no commentary):
{
  "primaryCategory": "string (one of: PSS, DCS, Front-End Developer, Back-End Developer, Web Automation, Mobile Automation, AI Engineer, Chatbot Application Tester, Other)",
  "secondaryCategories": ["string", ...],
  "confidenceScore": 0.0-1.0,
  "rationale": "string citing specific CV text evidence"
}

[CV TEXT - USER PROVIDED]
${escapeUserInput(cvText)}

[END CV TEXT]

Remember: Output ONLY JSON, no markdown, no explanation.
```

**Injection Defense**:
- Escape user input using JSON string escaping
- Fixed prompt structure with clear delimiters
- Validate output against schema before storing
- Never include user input in system prompt

**Output Validation**:
```typescript
const CVClassificationSchema = {
  type: 'object',
  required: ['primaryCategory', 'confidenceScore', 'rationale'],
  properties: {
    primaryCategory: {
      type: 'string',
      enum: ['PSS', 'DCS', 'Front-End Developer', 'Back-End Developer', 'Web Automation', 'Mobile Automation', 'AI Engineer', 'Chatbot Application Tester', 'Other']
    },
    secondaryCategories: { type: 'array', items: { type: 'string' } },
    confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' }
  }
};
```

### Sentiment Agent
**Responsibility**: Analyze feedback text, determine sentiment (positive/neutral/negative).

**Output Schema**:
```json
{
  "sentimentLabel": "positive | neutral | negative",
  "confidence": 0.0-1.0,
  "reasoning": "string"
}
```

### LLMWrapper (Logging Wrapper)
- Wraps every LLM call
- Extracts ACTUAL token counts from `response.usage`
- Calculates cost based on model pricing
- Logs to database immediately
- Returns response + metadata

---

## 8. Usage Logging Architecture

### Core Principle
**Never estimate tokens. Always use actual token counts from the OpenAI API response.**

### Logging Flow
```
1. Agent calls LLMWrapper.call(prompt)
2. LLMWrapper sends request to OpenAI (Chat Completions API)
3. API returns response with usage { prompt_tokens, completion_tokens }
4. LLMWrapper synchronously inserts record into llm_usage_logs table
5. Row includes: timestamp, user_id (from context), agent_id, model, input_tokens, output_tokens, latency, status, cost
6. Dashboard queries this table for analytics
```

### Cost Calculation
```typescript
const PRICING = {
  'gpt-4o': {
    input: 2.5 / 1_000_000,   // $2.50 per 1M tokens
    output: 10 / 1_000_000,   // $10.00 per 1M tokens
  },
  // Update as pricing changes
};

function calculateCost(usage: { prompt_tokens: number, completion_tokens: number }): number {
  const inputCost = usage.prompt_tokens * PRICING['gpt-4o'].input;
  const outputCost = usage.completion_tokens * PRICING['gpt-4o'].output;
  return inputCost + outputCost;
}
```

### Logging Auditing
- **Raw Logs**: Every LLM call in `llm_usage_logs` table
- **Dashboard Totals**: Sums aggregated from this table
- **Evaluation**: Compare dashboard totals to raw API responses (store full response in audit table)
- **Precision Check**: Query sum(input_tokens) in dashboard === sum from raw logs

---

## 9. Dashboard Architecture

### Role-Based Views

#### Admin Dashboard
Shows all data across all users and agents.

**Tabs**:
1. **Overview**
   - Total input tokens (last 24h, 7d, 30d)
   - Total output tokens (last 24h, 7d, 30d)
   - Total estimated cost
   - Agent run counts
   - Error rate

2. **By User**
   - Token consumption per user (sortable)
   - Cost per user
   - Agent run counts per user
   - Time saved per user (hours)

3. **By Agent**
   - Token consumption per agent
   - Error rate per agent
   - Average latency per agent
   - Run counts per agent

4. **CV Classifications**
   - Recommendation acceptance rate by category
   - Precision/recall per category (if ground truth available)
   - Total CVs processed

5. **Imported Logs**
   - List of imported external agent logs
   - Comparison view: imported vs native logs
   - Stats from imported sources

6. **Evaluation Metrics**
   - Logging accuracy: Dashboard totals vs. raw API logs
   - Precision by category
   - Recall by category
   - Time saved in person-hours

#### User Dashboard
Shows only data for the logged-in user.

**Tabs**:
1. **My Usage**
   - My input/output tokens
   - My total cost
   - My agent runs (timeline)

2. **My CVs**
   - Uploaded CVs and their classifications
   - Accept/reject decisions
   - Export results

3. **My Analytics**
   - Agent latency trends
   - Error history
   - Cost breakdown

### Imported Logs Tab (Both Roles)
- **Admin**: View all imported logs across users
- **User**: View only their own imported logs
- **Features**:
  - File name, upload date, record count
  - Summary stats from imported data
  - Side-by-side comparison with native logs
  - Download as CSV/JSON

### Chart Types
- **Line Charts**: Token trends over time
- **Bar Charts**: Token/cost breakdown by user/agent
- **Pie Charts**: Category distribution
- **Gauge Charts**: Error rate, acceptance rate
- **Table**: Sortable, filterable results

### Performance
- Cache aggregated stats (5-minute TTL)
- Lazy-load detailed views
- Pagination for large result sets
- Real-time updates via polling or WebSocket (phase 2)

---

## 10. Evaluation Architecture

### 1. CV Classification Metrics

#### Precision per Category
```
Precision(category) = True Positives / (True Positives + False Positives)
= # correctly classified as X / # all classified as X
```
**Requires**: Ground truth labels (manually annotated test set)

#### Recall per Category
```
Recall(category) = True Positives / (True Positives + False Negatives)
= # correctly classified as X / # all actual X instances
```

#### Implementation
- Seed database with ~20 test CVs with known categories
- Run agent on test set
- Compare predictions to ground truth
- Dashboard displays precision/recall per category
- Evaluate separately for primary vs. secondary categories

### 2. Logging Accuracy

#### Dashboard Total vs. Raw Logs
```
SELECT SUM(input_tokens) as dashboard_total FROM llm_usage_logs WHERE created_at > now() - interval '24 hours';
SELECT SUM(input_tokens) as actual_total FROM llm_usage_logs WHERE status = 'success' AND created_at > now() - interval '24 hours';

if dashboard_total == actual_total: "Logging Accurate" else "Discrepancy"
```

#### Cost Accuracy
```
dashboard_cost = SUM(estimated_cost) from table
manual_cost = SUM(input_tokens * input_rate + output_tokens * output_rate)

if dashboard_cost == manual_cost: "Cost Calculation Accurate"
```

### 3. Time Saved Estimation
```
Assumption: Manual CV classification takes ~5 minutes per CV
Time Saved (hours) = (# CVs processed × 5 minutes) / 60
Example: 50 CVs × 5 min = 250 min = 4.2 person-hours saved
```

### 4. Agent Performance Metrics
- **Latency P50, P95, P99**: Parse from `latency_ms` column
- **Error Rate**: (# errors) / (# total calls)
- **Throughput**: # requests per minute
- **Hallucination Detection**: Compare LLM confidence vs. ground truth accuracy

### 5. Dashboard Display
**Evaluation Tab** (Admin only):
```
┌─────────────────────────────────────────┐
│ CV Classification Accuracy              │
├─────────────────────────────────────────┤
│ Category          │ Precision │ Recall  │
├─────────────────────────────────────────┤
│ PSS               │ 0.95      │ 0.92    │
│ DCS               │ 0.88      │ 0.90    │
│ Front-End Dev     │ 0.92      │ 0.94    │
│ ... (all 9)       │           │         │
├─────────────────────────────────────────┤
│ Logging Accuracy: ✅ 100% (token match) │
│ Cost Calculation: ✅ 100% (verified)    │
│ Time Saved:       4.2 person-hours      │
└─────────────────────────────────────────┘
```

---

## 11. Security & Compliance

### Data Isolation
✅ **User-to-User**: Every table row contains `user_id`. Queries always filter by current user (from JWT).
✅ **Admin Access**: Admin role can bypass user filter and see all data.
✅ **No Hardcoded IDs**: User ID only from JWT claim, never from URL or frontend constants.

### Prompt Injection Defense
1. **Strict Schema**: LLM response must be valid JSON matching schema.
2. **User Input Escaping**: CV text escaped as JSON string value, not in system prompt.
3. **Prompt Structure**: Clear delimiters, immutable instructions.
4. **Output Validation**: Reject any response that doesn't match schema.
5. **Test Cases**: Craft adversarial CVs with injection attempts, verify they're classified correctly.

### HTTPS & Transport Security
- SSL/TLS in production
- Secure, httpOnly, sameSite=Strict cookies
- CORS: Allowlist localhost:3000 (dev), production domain (prod)

### Secrets Management
- `.env.local` for OpenAI API key, DB password, JWT secret
- Never commit `.env.local` to git
- Production: Use environment secrets in CI/CD

### Audit Logging
- Every LLM call logged with user, timestamp, input/output tokens
- Decision workflow logs: who accepted/rejected which classification
- Admin actions logged (viewing other users' data, imports)

---

## 12. Testing Strategy

### Unit Tests
- **Services**: authService, cvService, analyticsService (mock LLM)
- **Utilities**: validators, costCalculator, tokenCounter
- **Agents**: Verify prompt construction, output validation

### Integration Tests
- **Auth Flow**: Register user → Login → Access protected route
- **CV Processing**: Upload CV → Agent classification → Store result → Query dashboard
- **Analytics**: Insert logs → Aggregate in dashboard → Verify totals
- **Isolation**: User A cannot access User B's data

### E2E Tests (Selenium/Playwright)
- Admin login → View all users' data
- User login → Upload CV → See classification → Accept/reject
- Batch upload → Monitor progress → Verify all results
- Import external logs → View in dashboard tab

### Evaluation Tests
- **Precision/Recall**: Run agent on test set, verify metrics
- **Logging Accuracy**: Insert logs, query dashboard, compare totals
- **Injection Resistance**: Feed adversarial CVs, verify classification remains correct

### Test Data
- 3 demo users (2 regular users + 1 admin)
- 20-50 test CVs with ground truth labels
- Sample batch upload file (10 CVs)
- External log file (from a fictitious agent)

---

## 13. Project Directory Structure

```
multi-user-agent/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Auth/
│   │   │   ├── Dashboard/
│   │   │   ├── CVProcessing/
│   │   │   ├── DecisionWorkflow/
│   │   │   └── Common/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── store/
│   │   ├── types/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── agents/
│   │   ├── middleware/
│   │   ├── db/
│   │   │   └── prisma/
│   │   │       ├── schema.prisma
│   │   │       └── migrations/
│   │   ├── utils/
│   │   ├── routes/
│   │   ├── config/
│   │   ├── app.ts
│   │   └── server.ts
│   ├── .env.example
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── tsconfig.json
│   ├── package.json
│   └── jest.config.js
│
├── docs/
│   ├── API_REFERENCE.md
│   ├── DEPLOYMENT.md
│   ├── EVALUATION_GUIDE.md
│   └── USER_GUIDE.md
│
├── ARCHITECTURE.md (this file)
├── README.md
└── .gitignore
```

---

## 14. Development Phases

### Phase 1: Core Infrastructure (Week 1)
- [x] Database schema + Prisma setup
- [x] Express backend scaffold
- [x] User authentication (login; no register endpoint - accounts come from the seed)
- [x] JWT middleware
- [x] User role guards
- [x] React frontend scaffold
- [x] Auth flow (login form, protected routes)

### Phase 2: Agent Integration (Week 2)
- [x] OpenAI API integration
- [x] CV Classification Agent (prompt + output validation)
- [x] Sentiment Agent
- [x] LLMWrapper with logging
- [x] Usage logging to database
- [x] API endpoints for CV classification

### Phase 3: CV Processing & Decision Workflow (Week 2-3)
- [x] Single CV classification endpoint
- [x] Batch upload endpoint with progress tracking
- [x] CV results table and storage
- [x] User decision workflow (accept/reject)
- [x] Decision logging

### Phase 4: Analytics & Dashboard (Week 3-4)
- [x] Analytics service (token aggregations, cost, latency)
- [x] Admin dashboard (all users' data)
- [x] User dashboard (own data)
- [ ] Charts (Recharts): not implemented - the dashboard shows stat cards and tables
- [x] Imported logs dashboard tab

### Phase 5: Evaluation & Testing (Week 4)
- [x] Test data (27 CVs with ground truth labels, 3 per category)
- [x] Precision/recall calculation
- [x] Logging accuracy verification
- [x] Integration tests
- [ ] Evaluation tab in dashboard - not implemented (results are written to evaluation/ by the CLI)

### Phase 6: Security & Polish (Week 5)
- [x] Prompt injection testing
- [x] Input validation & sanitization
- [x] CORS hardening
- [x] Rate limiting - login throttling only (10 failures / 15 min per IP + email); no general API rate limit
- [x] Error handling & user feedback
- [x] Documentation

### Phase 7: Deployment Prep (Week 5-6)
- [ ] Docker setup (local dev) - not implemented
- [ ] CI/CD pipeline (GitHub Actions or similar) - not implemented
- [ ] Deployment guide (any cloud provider) - not written
- [ ] User guide + API docs - no separate guides; see README.md and docs/

---

## 15. Key Technical Decisions & Rationale

| Decision | Alternative | Why Chosen |
|----------|-------------|-----------|
| Node.js + Express | Python/FastAPI | Quick setup, easy LLM integration, single language for full-stack |
| SQLite (via Prisma) | PostgreSQL / MongoDB | Relational structure suits user/agent/log schema; ACID transactions for audit logging; no server to install for local/academic use. Trade-off: one writer at a time - a multi-user production deployment would move to PostgreSQL (see docs/DATABASE.md) |
| Prisma ORM | Raw SQL / Sequelize | Type-safe, excellent migrations, DX, no boilerplate |
| JWT + Cookies | Session-based only | Stateless auth scales better; httpOnly cookies prevent XSS |
| Actual token counts from API | Tiktoken/character estimation | Accuracy critical for cost billing and evaluation; API response is source of truth |
| React | Vue/Svelte | Larger ecosystem, more dashboarding libraries, easier to hire for |
| Recharts | Chart.js / D3 | Responsive, accessible, React-native, good for demos |
| Structured JSON from LLM | Regex parsing | Deterministic, schema-validatable, audit trail |
| Prompt injection defense via escaping + validation | Separate LLM call to sanitize | Simpler, fewer API calls, less latency |

---

## 16. Known Constraints & Future Improvements

### Current Constraints
1. **No real-time collaboration**: Dashboard updates on 5-sec polling, not WebSocket
2. **Single instance**: No multi-region deployment yet
3. **Demo users**: Only 3 hardcoded users; no user management UI
4. **Ground truth labeling**: Evaluation requires manual annotation of test CVs

### Phase 2+ Improvements
- WebSocket real-time updates
- Redis caching for dashboard aggregations
- Multi-tenancy support (org-level isolation)
- Email notifications for batch completion
- Scheduled batch processing (cron jobs)
- Advanced filtering (date range, status, error type)
- Export analytics as CSV/PDF
- Slack integration for alerts
- Cost budgeting & alerts (e.g., "You've used $500 this month")

---

## 17. Rollout & Academic Evaluation Checklist

### Demo Readiness
- [ ] All 11 requirements met
- [ ] 3 demo users with realistic data
- [ ] 50+ CVs pre-classified for analytics
- [ ] Admin + User dashboards show meaningful data
- [ ] Sample external log file ready for import
- [ ] Evaluation metrics computed and displayed
- [ ] Prompt injection test cases pass
- [ ] No hardcoded user IDs (all from JWT)

### Presentation Points
1. **Multi-user isolation**: Show Admin seeing all data, User seeing only their own
2. **Actual token logging**: Compare dashboard totals to raw API logs (100% match)
3. **Prompt injection resistance**: Inject malicious CV text, verify classification unaffected
4. **Real analytics**: Token trends, cost breakdown, agent performance
5. **Evaluation metrics**: Precision/recall per category, logging accuracy
6. **Security**: Explain JWT flow, role guards, user isolation

---

## Appendix A: Example User Flows

### Flow 1: User Uploads and Classifies Single CV
```
1. User logs in → JWT token stored
2. Navigate to "Upload CV" page
3. Select CV file, click "Classify"
4. Frontend POSTs to POST /api/cv/classify with CV content
5. Backend calls CVClassificationAgent.execute()
6. Agent calls OpenAI API, gets response with tokens
7. LLMWrapper logs to llm_usage_logs table (tokens, latency, cost)
8. Classification stored in cv_results table
9. Frontend displays classification with rationale
10. User clicks "Accept" or "Reject"
11. Decision recorded in cv_results.user_decision
12. Dashboard updates with new acceptance rate
```

### Flow 2: Admin Views All Users' Analytics
```
1. Admin logs in (role='admin')
2. Navigate to "Dashboard" → "By User" tab
3. Frontend calls GET /api/analytics/by-user
4. Backend queries: SELECT user_id, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost) FROM llm_usage_logs GROUP BY user_id
5. Dashboard displays table: User A (1M tokens, $15), User B (500K tokens, $8), etc.
6. Admin clicks on User A → Drill into User A's agent runs, CVs, decisions
7. All data shows User A's data only (verified by backend user_id filter)
8. Admin cannot see User B's data when logged in as User B (different JWT)
```

### Flow 3: Admin Imports External Agent Logs
```
1. Admin navigates to "Dashboard" → "Imported Logs" tab
2. Clicks "Upload External Log File"
3. Selects JSON file (e.g., from a competitor's agent)
4. Frontend POSTs to POST /api/import/logs with file content
5. Backend validates JSON structure, inserts into imported_agent_logs table
6. Admin sees summary: "Source: SalesforceAgent, Records: 47, Date: 2026-10-01"
7. Tab shows side-by-side comparison: Native logs vs. Imported logs
8. Charts overlay: Our agent's cost/latency vs. their agent's cost/latency
```

### Flow 4: Batch Upload with Progress Tracking
```
1. User navigates to "Batch Upload"
2. Selects folder with 50 CVs
3. Frontend sends POST /api/cv/batch with all CVs (or streams)
4. Backend creates batch_id, spawns background job
5. Frontend polls GET /api/cv/batch/{batchId}/status every 1 second
6. Backend returns: { processed: 15, total: 50, progress: 30%, errors: 0 }
7. Frontend displays progress bar
8. Job completes → "All 50 CVs classified, 48 accepted, 2 rejected"
9. User clicks "View Results" → Table of all classifications
10. Dashboard automatically updates with new token counts and cost
```

---

## Appendix B: Prompt Templates

### CV Classification Prompt (Injection-Resistant)
```
You are an expert CV classifier with deep knowledge of software engineering roles and specializations.

Your task: Analyze the provided CV text and classify it into ONE primary category and zero to THREE secondary categories from the provided list.

[OUTPUT SCHEMA]
You MUST respond with ONLY valid JSON, with NO markdown, NO code blocks, NO explanations, NO commentary. The JSON must conform to this exact schema:

{
  "primaryCategory": "one of: PSS, DCS, Front-End Developer, Back-End Developer, Web Automation, Mobile Automation, AI Engineer, Chatbot Application Tester, Other",
  "secondaryCategories": ["list of 0-3 categories from the same list"],
  "confidenceScore": 0.0 to 1.0,
  "rationale": "2-3 sentences explaining your classification with specific evidence from the CV"
}

[CV TEXT - BEGIN]
${escapeJSON(cvText)}
[CV TEXT - END]

Remember: Output ONLY the JSON object. No markdown, no code blocks, no preamble.
```

### Sentiment Analysis Prompt (Injection-Resistant)
```
You are a sentiment analysis expert. Analyze the provided feedback text and determine its sentiment.

[OUTPUT SCHEMA]
You MUST respond with ONLY valid JSON, with NO markdown, NO explanation:

{
  "sentimentLabel": "positive, neutral, or negative",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence explaining the sentiment"
}

[FEEDBACK TEXT - BEGIN]
${escapeJSON(feedbackText)}
[FEEDBACK TEXT - END]

Output ONLY the JSON object.
```

---

## Appendix C: Evaluation Test Data

### Test CV Set (20 samples with ground truth labels)
```csv
cv_id,name,groundTruthCategory,complexity
1,john_backend.txt,Back-End Developer,high
2,alice_pss.txt,PSS,medium
3,bob_frontend.txt,Front-End Developer,high
... (17 more)
```

### Expected Metrics (Targets)
- Precision per category: ≥ 0.85
- Recall per category: ≥ 0.80
- Logging accuracy: 100% (tokens match API response)
- Cost calculation accuracy: 100% (within 0.01% rounding)
- Average latency: < 5 seconds per CV

---

**End of Architecture Document**

---

### Next Steps (After Approval)

1. **Review this architecture** with stakeholder; provide feedback
2. **Move to Phase 1**: Database schema, backend scaffold, authentication
3. **Create detailed implementation tickets** for each component
4. **Set up development environment**: Docker Compose, database, Node.js setup

---

*Document prepared for academic evaluation. Technology choices favor local deployability and ease of demonstration.*
