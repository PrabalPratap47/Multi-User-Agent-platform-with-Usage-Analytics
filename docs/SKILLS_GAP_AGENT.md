# CV Skills Extraction & Gap Analysis Agent

The third agent. It reads a CV, compares the skills it **demonstrates** with
the skills expected for a selected target role, and writes a prioritized,
role-specific learning plan for the potential gaps. It is an AI-generated
learning aid: it never makes a hiring decision, guarantees job readiness,
or touches CV classification results or decisions.

## Using it

Dashboard → **SKILLS GAP ANALYSIS**: choose a `.txt` or text-based `.pdf`
CV, choose a target role, **Analyze CV**. The result shows a compact summary
(demonstrated / partially demonstrated / potential gaps / approximate
preparation time), the skills with CV evidence, the gaps grouped by priority
(expand one for its learning guidance) and the staged roadmap. Saved
analyses are listed below and can be reopened; an admin also gets a Delete
action (with confirmation) on each. `limitations` is still part of the
validated response and stored, but is not displayed.

## Code

| Part | File |
|---|---|
| Roles and expected skills (the only place they live) | `backend/src/agents/skillsGap/roles.ts` |
| Prompt (system prompt built only from `roles.ts`) | `backend/src/agents/skillsGap/prompt.ts` |
| Output schema (Zod) / documented JSON Schema | `backend/src/agents/skillsGap/schema.ts` / `skillsGapResponse.schema.json` |
| Role and content checks | `backend/src/agents/skillsGap/outputGuard.ts` |
| Agent | `backend/src/agents/SkillsGapAgent.ts` (`CV Skills Extraction & Gap Analysis Agent`) |
| Service / API | `backend/src/services/skillsGapService.ts`, `controllers/skillsGapController.ts`, `routes/skillsGap.ts` |
| UI | `frontend/src/components/skillsGap/SkillsGapTab.tsx` |

## API (authenticated; identity always from the session)

| Endpoint | |
|---|---|
| `GET /api/skills-gap/roles` | The roles with their expected skills, importance and gap priority. |
| `POST /api/skills-gap/analyze` | `{ targetRole, fileName?, cvContent }` or `{ targetRole, fileName?, pdfBase64 }`. Per-user AI rate limit. 201 with the saved analysis; 400 for bad input (same CV text rules and PDF extraction as CV classification); 502 with a safe message when the model output fails validation or the provider fails. |
| `GET /api/skills-gap/analyses` | Own analyses (all for an admin), newest first. |
| `GET /api/skills-gap/analyses/:id` | One analysis: owner or admin, otherwise 403. |
| `DELETE /api/skills-gap/analyses/:id` | **Admin only** (route `requireAdmin` + service check; 403 for every regular user, owner included). Permanently deletes that saved analysis; its agent run and usage logs are kept. 404 unknown id, 400 invalid id. |

## Output contract

Strict: unknown fields, wrong types, out-of-range numbers and invalid enum
values are rejected, never repaired with invented values.

- `targetRole` - one of the eight role ids (`roles.ts`; `PSS` and `DCS` are shown as Passenger Service System and Departure Control System); must equal the requested role.
- `overallSummary` - string.
- `demonstratedSkills[]` - `{ skill, status: "demonstrated", evidence }`.
- `partiallyDemonstratedSkills[]` - `{ skill, status: "partially_demonstrated", evidence, missingEvidence }`.
- `potentialGaps[]` - `{ skill, status: "not_demonstrated", priority: High|Medium|Low, whyItMatters, whatToUnderstand, topics[1-8], practicalExercise, miniProject | null, completionCriterion, estimatedLearningTime: { minHours, maxHours (1-400, min <= max), isApproximate: true } }`.
- `learningRoadmap[2-6]` - `{ stage (1, 2, 3, ... in order), title, objective, topics[], practicalTask, completionCriteria }`.
- `estimatedPreparationTime` - `{ minWeeks, maxWeeks (0-104, min <= max), hoursPerWeekAssumed, isApproximate: true, note }`.
- `limitations[1-6]`.

On top of the schema (`outputGuard.ts`):

1. Every skill configured for the role appears **exactly once** across the
   three lists, with its exact name; no other skills.
2. A gap's `priority` equals the configured importance (high → High, ...).
3. **Non-fabrication**: each evidence string must come from the CV - at least
   half of its significant words occur in the CV (very short evidence such as
   "CSS" must occur verbatim). A heuristic, not a semantic proof.
4. No leaked system-prompt phrases or key-shaped strings.
5. Markup and control characters are stripped from every string, then the
   result is validated again.

A failure gets **one** repair retry. The repair prompt lists the problems by
JSON path with fixed wording only - it never quotes values the model
returned, so CV- or model-influenced text cannot reach the system prompt.
If the retry also fails: `SkillsGapValidationError` → HTTP 502, nothing
stored, the run marked ERROR.

"Not demonstrated" means *not shown in the submitted CV*, not that the
candidate lacks the skill - the prompt, the UI and the limitations say so.

## Security

Same layers as the CV Classification Agent (`docs/PROMPT_INJECTION_SECURITY.md`):
fixed system prompt (the role is an enum, never free text), CV only in the
user message inside `[CV TEXT - BEGIN/END]` markers with look-alike markers
neutralized, no tools, strict output validation, 50,000-character input cap,
4,096-token output cap. Logs contain ids, counts and validation problems,
never CV text.

## Storage

Table `skills_gap_analyses` (migration `20261011000000_skills_gap_analysis`,
additive): owner, agent, run, target role, CV file name and length, the
validated `result` and the raw parsed model output for audit. The CV text
itself is **not** stored. No link to `cv_recommendations` or
`recommendation_decisions`.

Apply on an existing database (non-destructive, keeps all data):
`npm run db:migrate:deploy` from `backend/` (back up `backend/data/dev.db`
first). The agent row is created automatically on first use.

## Usage logging and analytics

Every provider call (including the repair retry) goes through
`LLMService`, which writes `llm_usage_logs` with the authenticated user, the
agent name, model, the provider's real `prompt_tokens`/`completion_tokens`,
latency, status and estimated cost. Missing usage metadata is recorded as 0
tokens with `errorCode: MISSING_USAGE_DATA` - never estimated. The agent then
appears automatically in the existing per-agent token, error-rate, latency
and run-count analytics; it is not part of the CV classification metrics.
External-log separation is unchanged.

## Limitations

- Skill and evidence judgement is the model's; the checks guarantee shape,
  coverage, priorities and that evidence text comes from the CV, not that the
  judgement is right. Evidence copied from irrelevant CV text (including
  injected text) can pass the evidence check.
- Role requirements are a small, fixed list; editing `roles.ts` changes them.
- Learning-time estimates are the model's approximations.
- Not yet tested against the real model (no paid calls were made).
