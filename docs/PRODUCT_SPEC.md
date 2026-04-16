# Rondar - Product Specification

**Package:** `@rondah-ai/rondar`
**Version:** 2.8.0
**Date:** April 2, 2026

---

## 1. Overview

Rondar is an AI-powered automated QA testing agent for web applications. It learns how your app works by watching real user interactions, then automatically generates and replays end-to-end tests. The agent can discover routes, recognize UI patterns, record user workflows, run health checks, replay E2E flows, and auto-heal broken selectors when the UI changes.

Rondar is designed to work with any web application — traditional server-rendered apps and modern SPAs alike — and integrates with CI/CD pipelines for continuous quality assurance.

---

## 2. Problem Statement

Manual QA testing is slow, error-prone, and doesn't scale. Writing and maintaining E2E tests requires significant developer effort, and tests break frequently as UIs evolve. Common pain points include:

- **Selector brittleness:** Tests break when CSS classes, IDs, or DOM structure change.
- **Overlay/modal interference:** Popups, modals, cookie banners, and dropdowns block test actions unpredictably.
- **Bootstrap complexity:** Logging in, dismissing onboarding flows, and reaching a testable state requires fragile setup scripts.
- **Empty state false positives:** Health checks pass on pages that loaded but have no data.
- **No learning from users:** Test authors must manually identify what to test and how.

---

## 3. Core Pipeline

Rondar implements a 5-step QA automation pipeline:

### 3.1 INIT — Discover & Model

```
npx rondar init --url <app-url> --email <email> --password <password>
```

- Crawls the application and discovers all navigable routes.
- Recognizes UI patterns on each route (auth forms, data tables, CRUD pages, navigation, search/filter, form dialogs).
- Generates a **Feature Model** (`QA_FEATURE_MODEL.json`) containing routes, detected patterns, capabilities, and health check blocks.
- Optionally records a **bootstrap sequence** (`--record-bootstrap`) for login and initial setup steps that must run before any test.

**Output:** `QA_FEATURE_MODEL.json`, optionally `QA_INIT_BOOTSTRAP.json`

### 3.2 LEARN — Watch & Record

```
npx rondar learn --url <app-url>
```

- Opens a headed browser session for the user to interact with the app.
- Injects an event tracker (`window.__qaTracker`) that captures clicks, text input, dropdown selections, form submissions, and navigations.
- The user drives the app through real workflows while the agent records every interaction.
- Recorded interactions are split into steps at navigation boundaries.
- Users can name capabilities, mark edge cases, add verify checks, and dismiss blocking overlays via keyboard commands.
- On save, each flow is **instantly validated** by headless replay to catch issues before they're committed.

**Interactive Commands:**

| Key | Action |
|-----|--------|
| `Enter` | Record health checkpoint / commit flow step |
| `r` | Start recording an E2E flow |
| `f` | Finish flow recording (validates, then saves or discards) |
| `v` | Add a verify check to the last step |
| `x` | Dismiss any blocking overlay/modal/dropdown |
| `k` | Keep pending auto-split events as one step |
| `n` | Name the last recorded capability |
| `e` | Record an edge case for last capability |
| `s` | Skip/discard pending events |
| `d` | Done — finish session and save all |

**Output:** `QA_RECORDED_FLOWS.json`

### 3.3 TEST — Health Checks

```
npx rondar test --url <app-url>
```

- Navigates to every discovered route in the feature model.
- Runs a suite of health checks per route:
  - `url_is` — URL matches expected route
  - `no_js_errors` — No uncaught JavaScript errors (including hydration errors)
  - `no_console_errors` — No `console.error()` calls
  - `no_error_alerts` — No visible error banners or alert elements
  - `no_request_failures` — No failed network requests (fetch/XHR)
  - `landmark_visible` — Page identity element is present (`data-page`, `data-testid`, `h1`, `h2`, or `title`)
- Captures a screenshot of each route.
- Replays bootstrap sequence first if one exists.

**Output:** `qa-results/summary.json`, `qa-results/report.html`, `qa-results/screenshots/`

**Exit code:** `0` if all checks pass, `1` if any fail.

### 3.4 E2E — Replay Recorded Flows

```
npx rondar e2e --url <app-url>
```

- Replays every recorded flow from `QA_RECORDED_FLOWS.json`.
- Before each step, detects and dismisses blocking overlays (modals, dropdowns, cookie banners).
- Retries failed actions with configurable retry logic.
- Runs verify checks at each step to confirm expected outcomes.
- Supports `--heal` flag to auto-fix broken selectors and write them back to the flows file.

**Output:** Console report with pass/fail per flow, selector health summary.

### 3.5 HEAL — Auto-Fix Broken Selectors

When the `--heal` flag is passed to the E2E runner, Rondar attempts to fix broken selectors using a cascading strategy:

1. Try the primary selector
2. Try stored fallback selectors (from previous heals)
3. Try text-based selector (`button:has-text("Save")`)
4. Try role + text (`[role="button"]:has-text("Save")`)
5. Try aria-label extraction
6. Try field name matching (for inputs)
7. Try href matching (for links)
8. Try data-testid prefix matching

When a selector heals successfully, the working selector is promoted to primary and the broken one is demoted to fallbacks. The next run uses the fixed selector directly.

---

## 4. Key Features

### 4.1 Overlay / Modal / Dropdown Detection & Dismissal

Rondar detects three categories of blocking UI elements:

- **Overlays:** Fixed/absolute-positioned elements covering 80%+ of the viewport with z-index > 0.
- **Modals:** Elements with `[role="dialog"]`, `dialog[open]`, or `[aria-modal="true"]` with visible backdrop.
- **Dropdowns:** Elements with `[aria-expanded="true"]` or `[data-state="open"]` with visible backdrop.

**Dismissal strategy (up to 3 attempts):**
1. Press `Escape` key
2. Click the backdrop element
3. Repeat

This runs automatically before every E2E step, during flow validation, and is available as a manual command (`x`) during learn sessions.

### 4.2 Bootstrap Record & Replay

Bootstrap captures the login and initial setup sequence that must complete before testing begins.

- **Recording:** Uses a separate browser context (discarded after save) to keep the main session clean.
- **Replay:** Runs on a fresh context every time (no stale cookies or state).
- **Pre-navigation steps** (e.g., entering credentials, clicking login) are **critical** — any failure aborts the run.
- **Post-navigation steps** (e.g., dismissing onboarding prompts, selecting an org) are **best-effort** — failures are logged but don't abort.
- Auto-skips redundant click-before-fill patterns.

### 4.3 Instant Flow Validation

When a user finishes recording a flow in learn mode, Rondar immediately replays it in a headless browser to verify it works:

- Launches headless browser and authenticates (or replays bootstrap).
- Replays each step, checking for blocking overlays before each action.
- Returns a result: `{ valid, issues, fixes }`.
- If overlay issues are detected, auto-generates `INSERT_DISMISS` fix actions at the correct positions.
- The user can accept fixes or discard the flow.

### 4.4 Navigation-Boundary Step Splitting

Recorded interactions are automatically split into logical steps at navigation boundaries:

- Explicit navigation events (pushState, popstate)
- SPA transitions detected via URL changes
- Each split group gets its own snapshot, route, and landmark reference

### 4.5 UI Pattern Recognition

During init, Rondar recognizes common UI patterns on each route:

| Pattern | Description |
|---------|-------------|
| `auth_form` | Email/password login forms |
| `data_table` | Tables with headers and data rows |
| `crud_page` | Create/Read/Update/Delete interfaces |
| `nav_sidebar` | Navigation sidebars and menus |
| `search_filter` | Search inputs with filter/apply controls |
| `form_dialog` | Modal forms (create, edit) |

Each pattern defines recognition signals, minimum match thresholds, smoke checks, regression scenarios, and extraction selectors.

### 4.6 Variable Substitution

Recorded actions support variable tokens that are resolved at replay time:

- `$EMAIL` — Replaced with the configured test email
- `$PASSWORD` — Replaced with the configured test password
- Custom variables via `--var key=value` CLI flags

This keeps credentials out of recorded flows and makes flows portable across environments.

### 4.7 Error Categorization

Health checks categorize errors into distinct types:

- `console_errors` — `console.error()` calls
- `jsErrors` — Uncaught JavaScript exceptions (including hydration errors detected via regex)
- `requestFailures` — Failed network requests (fetch/XHR only)
- `errorAlerts` — Visible error banners in the DOM

---

## 5. AI Integration

Rondar includes 13 tool definitions for integration with Claude AI as an agent:

| Tool | Purpose |
|------|---------|
| `map_site` | Crawl app, detect patterns, run smoke checks |
| `compose_test` | Compose tests from pattern matches |
| `execute_flow` | Execute recorded flows with full lifecycle |
| `load_qa_context` | Load feature model into AI context |
| `resolve_selector` | Resolve failing selectors via fuzzy healing |
| `browser_navigate` | Navigate to a URL |
| `browser_interact` | Click, fill, select, submit actions |
| `scan_page` | Detailed page analysis |
| `verify_behavior` | Verify expected outcomes |
| `visual_regression` | Visual diff detection |
| `screenshot` | Capture page screenshots |
| `accessibility_check` | Accessibility violations check |
| `generate_qa_report` | Generate HTML reports |

These tools enable Claude to act as an autonomous QA agent — crawling apps, composing tests, executing flows, and generating reports without human intervention.

---

## 6. Data Files

| File | Created By | Consumed By | Description |
|------|-----------|-------------|-------------|
| `QA_FEATURE_MODEL.json` | `init` | `test`, `e2e`, `learn` | Feature map with routes, patterns, capabilities, health blocks |
| `QA_RECORDED_FLOWS.json` | `learn` | `e2e` | E2E flows with actions, verify checks, selector health |
| `QA_INIT_BOOTSTRAP.json` | `init --record-bootstrap` | `init`, `test`, `learn` | Bootstrap setup steps (login, org selection) |
| `QA_INSTRUCTIONS.json` | `init` | AI tools | AI instructions for capability testing |

---

## 7. Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js >= 18 (CommonJS) |
| Browser Automation | Playwright 1.57.0 |
| Schema Validation | Zod 4.1.8 |
| AI Integration | Anthropic Claude SDK 0.20.0 |
| Package Registry | GitHub Packages (`@rondah-ai/rondar`) |

---

## 8. Environment Configuration

Environment variables (auto-loaded from `.env`):

```
TEST_EMAIL       — Login email for the application under test
TEST_PASSWORD    — Login password
QA_PREVIEW_URL   — Base URL of the application
ANTHROPIC_API_KEY — API key for AI-enhanced modes
```

---

## 9. CI/CD Integration

Rondar is designed to run in CI pipelines:

```yaml
# Example GitHub Actions workflow
- npx rondar test --url $QA_PREVIEW_URL    # Health checks
- npx rondar e2e --url $QA_PREVIEW_URL --heal  # E2E with auto-heal
```

- Exit code 0/1 for pass/fail gating.
- HTML report and screenshots uploaded as artifacts.
- `--heal` writes fixed selectors back so the next commit includes repairs.

---

## 10. Expected End Result

The completed Rondar product delivers:

1. **Zero-config route discovery** — Point at any web app and get a complete feature model with routes, patterns, and health checks in minutes.

2. **Record-once, replay-forever E2E tests** — Non-technical users record flows by using the app normally. Flows are validated instantly and replay reliably.

3. **Self-healing test suite** — When the UI changes, selectors auto-heal using fuzzy matching strategies. No manual test maintenance required for common UI refactors.

4. **Overlay-resilient automation** — Modals, popups, cookie banners, and dropdowns are automatically detected and dismissed. Tests don't break because of an unexpected overlay.

5. **Portable bootstrap sequences** — Login and setup flows are recorded once and replayed on fresh browser contexts. No hardcoded cookies or session hacks.

6. **Continuous health monitoring** — Every route is checked for JS errors, console errors, failed requests, missing landmarks, and error alerts on every run.

7. **AI-powered autonomous testing** — Claude can use Rondar's tool suite to independently crawl, test, and report on application quality without human guidance.

8. **CI/CD-native** — Drop into any pipeline with a single command. Get structured results, HTML reports, and proper exit codes for quality gating.

The vision is a QA system that **learns from humans, tests like a machine, and heals itself** — eliminating the maintenance burden of traditional E2E test suites while providing comprehensive, reliable coverage.
