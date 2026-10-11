# UI/UX Review (Step 19)

> **Historical report (2026-10-09).** It describes the UI and results at that date. Since then:
>
> - Recharts charts were added: the analytics doughnut, the CV treemap, the sentiment doughnut and the admin token-usage bar chart. The "No charts" limitation below no longer applies.
> - New tabs and features were added: SKILLS GAP ANALYSIS, PDF upload, CV feedback, deletion actions and admin user management.
> - `npm run verify:ui` grew to 85 checks; the last run was 2026-10-11 (85/85, `evaluation/ui-verification-results.json`).
>
> The other limitations below still apply.

This step changed the frontend only. Backend business logic, API contracts, authentication, RBAC and the Step 17 security fixes are unchanged. Every dashboard value still comes from the analytics API. No real OpenAI calls were made; browser runs used a CONTROLLED provider.

## Areas inspected

**How the inspection was done.** Before changing anything, the real frontend (Vite) was run against the real backend in headless Google Chrome via `playwright-core`.

**What was covered.**

- **Screens and controls:** login/logout, the dashboard (all six tabs), the analytics cards and tables, CV upload, single and batch processing, result cards with evidence, Accept/Modify/Reject, sentiment, the Successful/Failed Runs cards, external agent logs and the admin user list.
- **States:** loading, error and empty.
- **Layout and accessibility:** responsive layout, form labels, keyboard focus and text contrast.

**Method.** For admin and a regular user, at 1440 px (desktop), 820 px (tablet) and 390 px (mobile), an inspection script did the following on every tab:

- took full-page screenshots;
- measured horizontal page overflow and the elements causing it;
- listed controls without an accessible name;
- computed WCAG contrast from the rendered colours;
- tabbed through the page to check that focus is visible.

**Baseline findings** (unmodified UI):

| # | Finding | Where |
|---|---|---|
| 1 | **Defect.** A failed login showed the HTTP client's text "Request failed with status code 400" instead of the server's "Invalid email or password". The 429 lockout message would have been hidden the same way. The error box had no `role="alert"`. | Login, all widths |
| 2 | **Defect.** The import form's "Source agent name", "Log file" and "Notes" labels were not associated with their inputs, so the 3 controls had no accessible name. | External Logs, all widths, both roles |
| 3 | **Defect.** The usage-records table widened the page by 18 px and its columns collided ("LatencyStatus", overlapping token headers). It had no scroll container. | My Records at 390 px |
| 4 | **Defect.** Text below WCAG AA contrast. | Every page |

The contrast failures in finding 4:

- navbar role text: 3.61:1 (white at 75% opacity);
- "SUCCESS" status: 3.30:1;
- `text-gray-400` meta text ("Data as of…", result ids, file sizes): 2.54:1;
- inline `code`: 4.39:1.

Also observed in the baseline:

- **Already good:** keyboard focus was visible at every stop; the CV and sentiment flows already used text plus colour, `role="alert"` and progress bars.
- **Mobile navbar:** the title wrapped onto three lines.
- **Card layout:** My Records and Admin Users used ad-hoc wrappers with no heading.
- **Heading levels:** they jumped from h1 to h3.
- **Network errors:** shown as the bare "Network Error".
- **"Reason required" rule:** "Modify and Reject require a reason" was only shown after choosing one.
- **Demo passwords:** included in every build, including production.

## Changes made

All changes follow the existing conventions: `SectionCard`/`StatCard`, the Loading/Error/Empty states, Tailwind tokens and button styles. There is no redesign and no new runtime dependency.

**Defect fixes**

1. **Login message:** `useAuth` uses the shared `apiErrorMessage`, so the server's message, or "Could not reach the server…", is shown. The error box is `role="alert"`.
2. **Import form labels:** inputs now have ids and `htmlFor` labels.
3. **Wide tables:** every data table now sits in a new `ScrollableTable` primitive. A table wider than its card scrolls inside it, never the page. When it really overflows, the wrapper becomes a named, focusable region (so keyboard users can scroll it) and shows "Scroll sideways to see every column."
4. **Contrast:**
   - `text-gray-400` → `text-gray-500`;
   - the role is now a `bg-blue-700` badge;
   - status and error text → `-700` shades;
   - the inline code is removed from the admin note.

**Dashboard and visual consistency**

- **Landmarks:** `<header>`/`<nav aria-label="Account">`, `<main>`, and the tab bar is `<nav aria-label="Dashboard sections">`. The active tab has `aria-current="page"`.
- **Headings:** h1 Dashboard → h2 section titles (`SectionCard`) → h3 subsections and CV result cards.
- **Tables:** numeric columns are right-aligned with tabular figures, headers have `scope="col"` and nowrap, and name columns get a minimum width.
- **Shared card layout:** My Records and Admin Users now use `SectionCard` and the shared Loading, Error (with Retry) and Empty states.
- **My Records copy:** the description is now correct for admins: "from every user". The old text claimed "your own account" for everyone.
- **Successful/Failed Runs cards:** unchanged in content. They stay visible with their "All time - status SUCCESS/ERROR" subtitles, and Failed turns red when above 0.

**Responsive**

- **Navbar:** wraps into two compact lines on phones, with the title at `text-lg` below `sm` and the email truncated.
- **Tab bar:** tighter padding on mobile.
- **Login card:** has side gutters on small screens.

**CV workflow**

- **Decision rule:** "Accept keeps the AI recommendation. Modify and Reject require a reason." is shown before anything is chosen. It is linked to the radio group with `aria-describedby`.
- **Selected option:** shows a ✓ (decorative, `aria-hidden`), so the selection is not communicated by colour alone.
- **Field errors:** the decision-type, primary-category, categories and reason errors have ids, and their fields use `aria-invalid` and `aria-describedby`.
- **Duplicate submissions:** the decision controls and the reason field are disabled while a decision is saving.
- **Status announcements:** "Checking files…" is `role="status"`. Batch progress ("N of M finished") is `aria-live="polite"`, and the all-success outcome is `role="status"`.
- **Failures stay prominent:** failed counts and per-file reasons are emphasised (`text-red-700`, bold "Failed N"), and partial failures still read "Partially completed: X of N classified, Y failed".

**Sentiment and external logs**

- Meta text contrast is fixed.
- The import file picker uses the same styling as the CV upload and is disabled while importing.
- The import success message is `role="status"`.
- Import errors use `apiErrorMessage`, so per-field validation details are shown, e.g. "content: file content must not be empty".
- The "N errors" toggle exposes `aria-expanded`.

**Error handling and session**

- `useAsyncData` shows the server message or "Could not reach the server…" instead of "Network Error". Its 403 wording is unchanged.
- Logout is guarded against double clicks ("Logging out…").
- The demo-credentials box is only rendered by the dev server (`import.meta.env.DEV`). The production bundle contains no demo passwords; this was verified by scanning `frontend/dist`.

**Global**

- One consistent `:focus-visible` outline for buttons, links, `summary`, file inputs, checkboxes and scroll regions. Inputs keep their focus ring.
- Loading states are `role="status"` and error states are `role="alert"`.

## Accessibility improvements

| Check | Before | After |
|---|---|---|
| Controls without an accessible name | 3 on External Logs, at every width and for both roles | 0 on every tab, at every width, for both roles |
| Text below WCAG AA contrast | 4 kinds, on every page | 0 (automated, every tab, 4 widths) |
| Failed-login message | Generic HTTP text, not announced | Server message in `role="alert"` |
| Visible keyboard focus | 23/23 stops | 27/27 stops (admin, desktop) |
| Landmarks and heading order | No `main` or navigation landmarks; h1 → h3 | `header`, `nav` ×2 and `main`; h1 → h2 → h3 |
| Active tab | Colour only | `aria-current="page"` and colour |
| Decision selection | Colour plus `aria-checked` | ✓ marker, `aria-checked`, and a visible reason rule |
| Wide tables | Page overflow; not keyboard-scrollable | Scroll inside the card; focusable named region; the keyboard scrolls it (320 px verified) |

## Responsive-layout checks

Viewports were emulated in headless Google Chrome. **No physical phones or tablets, and no other browsers, were used.**

| Width | Page overflow, before | Page overflow, after |
|---|---|---|
| 1440 px | 0 on every tab | 0 on every tab |
| 820 px | 0 on every tab | 0 on every tab |
| 390 px | 18 px on My Records (admin and user) | 0 on every tab |
| 320 px | not measured before | 0 on every tab |

The final screenshots were reviewed visually (desktop analytics, mobile My Records, mobile login).

## Tests executed

| Test | Provider | Result |
|---|---|---|
| `npm run verify:ui` (**new, committed**: `backend/src/evaluation/verifyUi.ts`) | CONTROLLED, Chrome | **64/64** |
| `npm run verify:dashboard-run-outcomes` (DB → API → dashboard for successful/failed runs) | CONTROLLED, Chrome | **44/44** |
| Dashboard consistency on the real Step 18 E2E database (all metrics, DB → API → dashboard) | none (no provider calls) | **54/54** |
| CV processing browser test (upload, validation, single/batch, Accept/Modify/Reject, failures, mobile) | CONTROLLED (fake model), Chrome | **47/47** |
| Sentiment browser test | CONTROLLED (fake model), Chrome | **29/29** |
| Backend test suite (`npm test`) | stubs | **313/313** |
| Typecheck, backend and frontend | — | PASS |
| Lint, backend (0 errors, 31 `console` warnings in CLI scripts) and frontend | — | PASS |
| Build, backend and frontend | — | PASS |
| Production bundle secret scan (`frontend/dist`) | — | No API key, JWT secret, `sk-` pattern or demo password |

The 64 `verify:ui` checks break down as:

- **49 layout and accessibility checks:**
  - the login page and every tab, for both roles, at 4 widths;
  - plus the mobile scroll region.
- **4 failed-login checks**, one per width.
- **2 role-tab checks.**
- **1 keyboard-focus check.**
- **1 run-count cards check** (Successful/Failed Runs = API).
- **4 CV checks:**
  - classified through the UI, with category, confidence and evidence;
  - the reason rule is visible;
  - REJECT without a reason is refused, with the error linked to the field;
  - the decision is stored.
- **1 batch partial-failure check:** the failed file is reported as failed, with its reason.
- **1 sentiment check:** the shown result equals the stored result.
- **1 logout check:** back to login, session cleared, still logged out after reload.

The same audit logic flagged defects 1–4 against the unmodified UI.

The CV and sentiment browser tests and the all-metrics dashboard comparison are scratch harnesses, not committed. The real-OpenAI E2E runner was not re-run, because no backend code changed and no model call was needed.

## Remaining UI limitations

- **Browser and device coverage.** Only Google Chrome (headless) at emulated widths. No Firefox, Safari, physical devices or touch input. No screen reader (NVDA/VoiceOver) was used; semantics were checked programmatically.
- **Partial ARIA patterns.** The decision radio group and the tab bar use buttons. Each is reachable with Tab, but arrow-key navigation (the full ARIA radio/tabs pattern) is not implemented. Tab labels are upper-case text, which some screen readers may spell out.
- **No charts.** The dashboard has stat cards and tables only. None were added; that would be a redesign and likely a new dependency.
- **Tables on phones.** Tables scroll sideways inside their card, with a hint; there is no stacked card layout.
- **Contrast check is approximate.** It is automated from computed colours. Gradient card backgrounds are approximated by the nearest solid background. It is not a full axe/WCAG audit.
- **Batch tracking.** A batch is tracked only in the browser tab that submitted it (`sessionStorage`).
- **Intermittent first run.** One intermittent failure was seen in the very first baseline run of the CV browser test: a Retry click timed out on a cold dev server. It did not reproduce in an isolated repro or in five further full runs (three before the changes, two after). The cause is not proven.
- **Baseline screenshots.** The baseline screenshots were accidentally overwritten during the step. The baseline *measurements* above come from the saved baseline log; screenshots were kept only for the final state.
