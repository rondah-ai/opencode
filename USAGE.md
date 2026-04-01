# Rondar — Usage Guide

Rondar is a QA testing agent by [Rondah](https://github.com/rondah-ai). It learns your web app by watching you use it, then runs health checks and replays E2E flows automatically — with self-healing selectors that survive UI changes.

```
INIT  →  LEARN  →  TEST  →  E2E  →  HEAL
scan     watch     check    replay   auto-fix
your     you use   every    recorded broken
app      the app   page     flows    selectors
```

---

## Table of Contents

- [Installation](#installation)
- [Setup](#setup)
- [Step 1: Init — Scan Your App](#step-1-init--scan-your-app)
- [Step 2: Learn — Teach the Agent](#step-2-learn--teach-the-agent)
- [Step 3: Test — Run Health Checks](#step-3-test--run-health-checks)
- [Step 4: E2E — Replay Recorded Flows](#step-4-e2e--replay-recorded-flows)
- [Auto-Healing](#auto-healing)
- [CI/CD Integration](#cicd-integration)
- [CLI Reference](#cli-reference)
- [Data Files](#data-files)
- [Environment Variables](#environment-variables)
- [Migrating from Legacy Format](#migrating-from-legacy-format)

---

## Installation

### Prerequisites

- Node.js >= 18
- A `.npmrc` file configured for GitHub Packages

**1. Configure npm to use GitHub Packages for `@rondah-ai` scope:**

Create or update `.npmrc` in your project root (or `~/.npmrc` globally):

```
@rondah-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

> Your token needs the `read:packages` scope. Generate one at [GitHub Settings > Tokens](https://github.com/settings/tokens).

**2. Install Rondar:**

```bash
npm install @rondah-ai/rondar --save-dev
```

**3. Install Playwright browsers:**

```bash
npx playwright install chromium
```

---

## Setup

Create a `.env` file in your project root with your test credentials:

```env
TEST_EMAIL="your-test-account@example.com"
TEST_PASSWORD="your-test-password"
QA_PREVIEW_URL="http://localhost:3000"
```

All Rondar scripts auto-load `.env` from the working directory — no extra dependencies needed.

> **Tip:** Add `.env`, `qa-results/`, and `.qa-learn-session.json` to your `.gitignore`.

---

## Step 1: Init — Scan Your App

Init crawls your app, discovers routes, recognizes UI patterns (forms, tables, CRUD pages, search, auth), and generates a feature model.

```bash
node node_modules/@rondah-ai/rondar/scripts/init.js --url http://localhost:3000
```

With explicit credentials (overrides `.env`):

```bash
node node_modules/@rondah-ai/rondar/scripts/init.js \
  --url http://localhost:3000 \
  --email test@example.com \
  --password secret123
```

### What it does

1. Launches a browser and navigates to your app
2. Authenticates if credentials are provided
3. BFS-crawls all internal links (up to `--max-pages`)
4. On each page, matches UI patterns against signal-based rules
5. Maps patterns to capabilities (e.g., a `crud_page` gets `view_list`, `create`, `edit`, `delete`)
6. Writes `QA_FEATURE_MODEL.json` and `QA_INSTRUCTIONS.json`

### UI patterns recognized

| Pattern | What it detects | Capabilities generated |
|---------|----------------|----------------------|
| `auth_form` | Email + password inputs + submit button | `login`, `login_invalid` |
| `data_table` | Table/grid + column headers + rows | `view_list`, `sort`, `pagination` |
| `crud_page` | Add/Create button + table + edit button | `view_list`, `create`, `edit`, `delete` |
| `search_filter` | Search input + search/filter button | `search`, `clear_search` |
| `form_generic` | Form + labels + inputs + submit | `submit_form`, `submit_invalid` |
| `nav_sidebar` | Nav element + links | _(structural — used for crawling, not capabilities)_ |
| `modal_dialog` | `[role="dialog"]` | _(structural)_ |
| `toast_notification` | `[role="alert"]` / `[role="status"]` | _(structural)_ |

### Init flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL (required) | `$QA_PREVIEW_URL` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--max-pages` | Max pages to crawl | `20` |
| `--output-dir` | Output directory | `.` |
| `--exclude` | Comma-separated route prefixes to skip | — |
| `--instructions` | Generate only `QA_INSTRUCTIONS.json` | `false` |
| `--headless` | Run headless (`false` to show browser) | `true` |
| `--timeout` | Navigation timeout (ms) | `30000` |

### Output

- **`QA_FEATURE_MODEL.json`** — Feature map with routes, capabilities, and verify checks. This is a _skeleton_ — interactions are guesses based on patterns, not observed behavior.
- **`QA_INSTRUCTIONS.json`** — Global settings: viewport, timeouts, known issues, custom selectors, excluded routes.

### After init

1. Open `QA_FEATURE_MODEL.json` and review the features
2. Fill in any `"TODO"` values in `test_data` fields
3. Proceed to **Learn** to upgrade from skeleton to observed confidence

---

## Step 2: Learn — Teach the Agent

Learn opens a **visible browser** and watches you use the app. It records your interactions and upgrades the feature model from "skeleton" to "observed" confidence. You can also record full E2E flows for replay.

```bash
node node_modules/@rondah-ai/rondar/scripts/learn.js --url http://localhost:3000
```

Resume a previous session:

```bash
node node_modules/@rondah-ai/rondar/scripts/learn.js --url http://localhost:3000 --resume
```

View session history:

```bash
node node_modules/@rondah-ai/rondar/scripts/learn.js --history
```

### How a learn session works

1. Browser opens (visible, not headless)
2. Agent authenticates if credentials are provided
3. An event tracker is injected into the page — it silently records every click, input, dropdown selection, form submission, and navigation
4. You use the app normally in the browser
5. Back in the terminal, you use keyboard commands to tell the agent what to do with the recorded interactions
6. Session state is auto-saved every 30 seconds to `.qa-learn-session.json`

### Keyboard commands

There are two modes: **health checkpoint mode** (default) and **flow recording mode** (after pressing `r`).

#### `Enter` — Record checkpoint / flow step

**In health checkpoint mode** (default):

Pressing `Enter` takes the pending interactions and creates a **health observation** for the current page:

1. Captures the page state (URL, element counts, landmarks, console errors)
2. Computes a diff from the previous snapshot
3. Auto-infers verify checks (see [Auto-inferred checks](#auto-inferred-verify-checks))
4. Picks the best landmark for the page (h1 text, `data-page`, `data-testid`)
5. Tries to match the observation against an existing capability in the feature model
6. Displays: `RECORDED: matches dashboard.view (will upgrade)` or `new capability`

This is how the agent learns what each page looks like and upgrades capability confidence from `"skeleton"` to `"observed_1x"`, `"observed_2x"`, etc.

**In flow recording mode** (after pressing `r`):

Pressing `Enter` captures the pending interactions as a **flow step**:

1. Checks whether a blocking overlay, modal, or dropdown is still open
2. Warns if the step is unusually large
3. Detects navigation boundaries and may preview an automatic split
4. Collapses raw events into playable actions (`click`, `fill`, `select`, `waitForURL`)
5. Snapshots the current page state
6. Adds the step to the flow being recorded
7. Displays the actions that were captured

```
FLOW STEP 2: click a "Reports", navigate to /home/reports
  Route: /home/reports
  -> click a:has-text('Reports')
  -> waitForURL /home/reports
  landmark: h1 "Reports"
  (press [v] to add verify checks, [Enter] for next step)
```

If no interactions are pending, it prints `(no interactions to record)`.

#### `x` — Auto-dismiss blocking overlay

If a dropdown, modal, or backdrop is still open, press `x` to have the recorder try:

1. `Escape`
2. Clicking the backdrop overlay

Example:

```text
⚠ WARNING: dropdown is still open ("Select practice")
  This will block clicks in the next step.
  → Close it in the browser, then press [Enter]
  → Or press [x] to auto-dismiss and continue

[x]
✓ Overlay dismissed. Press [Enter] to record step.
```

This is useful when you opened a menu for exploration but do not want that open state to break the next step.

#### `k` — Keep pending auto-split as one step

If Rondar detects multiple navigation boundaries in one pending batch, it previews an auto-split before committing:

```text
Auto-splitting into 3 steps (navigation boundaries detected):
  Step 2: click a "Reports", navigate to /home/reports → /home/reports
  Step 3: click a "Voicemails", navigate to /home/voicemails → /home/voicemails
  Step 4: click a "Notifications", navigate to /home/notifications → /home/notifications

Press [Enter] to accept split  |  [k] to keep as single step
```

Press `k` if you intentionally want to keep the full batch as one step:

```text
[k]
Keeping as single step. Press [Enter] to commit.
```

#### `r` — Start recording an E2E flow

Starts a new E2E flow recording session:

1. Sets the flow's `startRoute` to the current page URL
2. Captures the initial page state
3. Clears any pending events
4. From this point, `Enter` creates flow steps instead of health checkpoints

```
FLOW RECORDING STARTED
  Start route: /home/call-logs
  Perform actions in the browser, press [Enter] after each step...
```

You cannot nest recordings — pressing `r` while already recording has no effect.

#### `f` — Finish E2E flow recording

Finishes the current flow recording:

1. Prompts you to name the flow: `Name this flow: ` (defaults to `flow_{N}`)
2. Replays the flow in a fresh headless browser for validation
3. If validation passes, saves the flow
4. If validation fails and an auto-fix is available, lets you:
   - apply fixes and save
   - save with known issues
   - discard
5. Returns to health checkpoint mode

```
Name this flow: login and navigate
Validating "login and navigate"... (replaying 3 steps)
✓ Validation PASSED
FLOW SAVED: "login and navigate" (3 steps)
```

The flow is written to `QA_RECORDED_FLOWS.json` when the session ends.

Validation example with auto-fix:

```text
Name this flow: wimsical
Validating "wimsical"... (replaying 3 steps)
✗ Validation FAILED — 1 issue(s):
  Step 2: Blocking UI left open from previous step

Auto-fix available:
  → Insert "press Escape" before Step 2

Apply fixes [f], save anyway [s], or discard [d]?
```

#### `v` — Add verify check to last flow step

Adds verification checks to the most recently recorded flow step. This tells the E2E runner what to assert after replaying the step.

**How it works:**

1. Captures the current page state
2. Compares it against the step's `stateAfter` snapshot
3. Auto-infers checks based on what changed (toasts, URL, dialogs, landmarks)
4. Adds each check to the step's `verify[]` array

```
VERIFY CHECKS added to step 2:
  + landmark_visible (h1): h1 = "Reports"
  + no_js_errors: No JavaScript errors
  + url_is: URL = /home/reports
```

You can also add explicit text verification: `v "Success"` adds a `text_visible` check for that string.

#### `n` — Name the last capability

Sets a human-readable label on the last recorded observation so it matches the right capability in the feature model.

```
Name this capability: view_reports
Named: view_reports
```

#### `e` — Record edge case

Records the current pending events as an **edge case** variant of the last recorded capability. Useful for testing error states, empty states, boundary conditions, etc.

```
EDGE CASE recorded for: authentication.login
  (3 events captured)
```

#### `s` — Skip / discard pending events

Discards all pending events without recording them. Use this if you did something you don't want the agent to learn.

```
Skipped 5 pending events
```

#### `d` — Done / finish session

Saves everything and exits:

1. If a flow is being recorded, auto-finishes it with the name `flow_{N}`
2. Merges all observations into the feature model (`QA_FEATURE_MODEL.json`)
3. Saves recorded flows to `QA_RECORDED_FLOWS.json`
4. Archives session history to `.qa-learn-history/`
5. Cleans up the session file

If the process is interrupted unexpectedly while a flow is in progress, Rondar saves a draft flow with:

- a `_draft_flow_{N}` name
- `_validationStatus: "skipped"`
- the current recorded steps

This protects in-progress work during interrupted closes or terminal shutdown.

### Recording an E2E flow: full walkthrough

Here is the complete sequence for recording a flow:

```
1. Start the learn session
   $ node scripts/learn.js --url http://localhost:3000

2. The browser opens. Use it to navigate/authenticate if needed.

3. Press [r] in the terminal to start recording
   → "FLOW RECORDING STARTED — Start route: /home/call-logs"

4. In the browser: click "Select practice", pick a practice from the dropdown

5. Press [Enter] in the terminal to capture this as Step 1
   → "FLOW STEP 1: click button 'Select practice', select option 1 in Suggestions"

6. In the browser: click "Reports" in the sidebar

7. Press [Enter] in the terminal to capture Step 2
   → "FLOW STEP 2: click a 'Reports', navigate to /home/reports"

8. Press [v] to add verify checks for Step 2
   → "VERIFY: landmark_visible h1 'Reports', url_is /home/reports"

9. In the browser: click "Voicemails", then "Notifications"

10. Press [Enter] to capture Step 3
    → "FLOW STEP 3: click a 'Voicemails', navigate to /home/voicemails, ..."

11. Press [f] to finish the flow
    → "Name this flow: " → type "smoke navigation"
    → "FLOW SAVED: 'smoke navigation' (3 steps)"

12. Press [d] to end the session
    → Model and flows saved
```

### Example: record safely when a dropdown stays open

```text
1. Press [r]
2. In the browser, click "Select practice" and browse tabs
3. Press [Enter]

⚠ WARNING: dropdown is still open ("Select practice")
  This will block clicks in the next step.

4. Press [x]
   → Overlay dismissed

5. Press [Enter] again
   → Step is recorded without carrying the open overlay into the next step
```

### Example: accept or reject an automatic split

```text
1. Press [r]
2. In the browser, click Reports → Voicemails → Notifications
3. Press [Enter]

Auto-splitting into 3 steps (navigation boundaries detected):
  Step 1: click a "Reports", navigate to /home/reports
  Step 2: click a "Voicemails", navigate to /home/voicemails
  Step 3: click a "Notifications", navigate to /home/notifications

4a. Press [Enter] to accept the split
or
4b. Press [k] to keep it as one combined step
```

### What the agent tracks automatically

The event tracker (injected into the browser page) captures:

| Event | What's recorded |
|-------|----------------|
| **Click** | Selector, visible text, tag, `data-testid`, `aria-label`, `href`, URL |
| **Text input** | Selector, value (passwords masked as `***`), field name/placeholder |
| **Dropdown selection** | Selector, option text, value, position (1-indexed), trigger element selector/text |
| **Form submission** | Form selector, URL |
| **Navigation** | New URL (from `history.pushState` or `popstate`) |

### How events are collapsed into actions

When you press `Enter`, raw events are normalized by `collapseEvents()`:

- **Consecutive typing** on the same field → single `fill` action with the final value
- **Click before fill** on the same input → removed (redundant focus click)
- **Submit after click** → deduplicated (the click already triggers submit)
- **Click on button/link** → uses text-based selector: `button:has-text('Save')`
- **Dropdown select** → absorbs the preceding trigger click into `triggerSelector`
- **Navigation event** → `waitForURL /path`

**Credential parameterization** (automatic):
- If the typed value matches `config.email` → stored as `$EMAIL`
- If the field is a password field → stored as `$PASSWORD`

This makes recorded flows portable across environments.

### Selector strategy

The tracker generates selectors in this priority order:

1. `[data-testid="..."]` — most stable
2. `#id` — if not a dynamic ID (skips `#radix-*`, `#rc-*`, `#headlessui-*`, etc.)
3. `[aria-label="..."]` — accessible label
4. `button:has-text("...")` / `a:has-text("...")` — visible text for buttons/links
5. `input[name="..."]` — form field name
6. CSS path fallback — `div > div.class > button` (least stable, used as last resort)

Each action also stores `selectorFallbacks[]` — alternative selectors the E2E runner can try if the primary breaks.

### Auto-inferred verify checks

When you press `Enter` or `v`, the agent auto-detects:

| Check | When inferred |
|-------|--------------|
| `no_js_errors` | Always |
| `no_console_errors` | Always |
| `no_error_alerts` | When no visible error alerts found on page |
| `url_is` | When the URL changed since last snapshot |
| `landmark_visible` | When an h1, `data-page`, or `data-testid` is found |
| `toast_contains` | When text matching "success/saved/created/updated/deleted/sent/added/removed" detected |
| `element_exists` | When a `[role="dialog"]` appeared |
| `element_gone` | When a `[role="dialog"]` disappeared |

### Learn flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL (required) | `$QA_PREVIEW_URL` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--model` | Feature model path | `./QA_FEATURE_MODEL.json` |
| `--resume` | Resume a previous interrupted session | `false` |
| `--history` | Show past session logs and exit | `false` |
| `--timeout` | Navigation timeout (ms) | `30000` |

---

## Step 3: Test — Run Health Checks

Test navigates to every feature page and verifies it loads correctly using landmark-based checks.

```bash
# Smoke test — navigation-only capabilities
node node_modules/@rondah-ai/rondar/scripts/run-test.js --url http://localhost:3000

# Full test — all capabilities
node node_modules/@rondah-ai/rondar/scripts/run-test.js --url http://localhost:3000 --suite full

# Test specific features only
node node_modules/@rondah-ai/rondar/scripts/run-test.js --url http://localhost:3000 --features dashboard,reports

# Show the browser while testing
node node_modules/@rondah-ai/rondar/scripts/run-test.js --url http://localhost:3000 --no-headless
```

### How it works

1. Loads `QA_FEATURE_MODEL.json`
2. Builds a test plan:
   - Authentication first (if feature exists)
   - For each feature: run `health` block checks, then capability checks
   - `smoke` suite: only view/navigation capabilities
   - `full` suite: all capabilities
3. Launches a headless browser (or visible with `--no-headless`)
4. For each step: navigates to the route, captures element state, runs verify checks
5. Generates results in `qa-results/`

### Health checks

| Check | What it verifies |
|-------|-----------------|
| `no_js_errors` | No uncaught JavaScript errors on the page |
| `no_console_errors` | No `console.error` output |
| `no_error_alerts` | No visible error banners/alerts (scans `[role="alert"]`, `.error`, `.text-red-500`) |
| `url_is` | Current URL pathname matches expected route |
| `landmark_visible` | Page identity element is present and contains expected text |
| `element_exists` | Specific selector matches at least one element |
| `element_gone` | Specific selector matches zero elements |
| `toast_contains` | Toast notification contains expected text |

### Monitored element selectors

The runner tracks element counts before and after navigation to detect changes:

```
tbody tr, table, thead th, form, input:visible, button:visible,
[role='dialog'], [role='alert'], [role='alertdialog'],
.toast, [data-sonner-toast], .error, .text-red-500, nav a
```

### Test flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `$QA_PREVIEW_URL` or `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--model` | Feature model path | `./QA_FEATURE_MODEL.json` |
| `--suite` | `smoke` or `full` | `smoke` |
| `--features` | Comma-separated feature names | all |
| `--output-dir` | Results directory | `./qa-results` |
| `--no-headless` | Show browser window | headless |
| `--timeout` | Navigation timeout (ms) | `10000` |

### Output

- `qa-results/summary.json` — Structured test results
- `qa-results/report.html` — Visual HTML report with color-coded pass/fail cards
- `qa-results/screenshots/` — Per-feature screenshots

Exit code `0` if all pass, `1` if any fail.

---

## Step 4: E2E — Replay Recorded Flows

E2E replays the flows you recorded during Learn sessions against a live app. Each flow runs in a fresh browser context (clean cookies/state).

```bash
# Run all recorded flows
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000

# Run a specific flow by name (substring match)
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --flow "login flow"

# Run flows tagged as "smoke"
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --tag smoke

# Stop on first failure, show browser
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --stop-on-fail --no-headless

# Slow visible replay so humans can follow along
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --no-headless --slow-mo 200 --step-delay 500

# Demo preset for readable visible replay
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --demo

# Auto-heal broken selectors and save fixes
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --heal

# Pass custom variables for parameterized flows
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --var PATIENT_NAME="John Doe"

# Full example with all flags
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js \
  --url http://localhost:3000 \
  --heal \
  --email john@mail.com \
  --password 123456 \
  --stop-on-fail \
  --no-headless \
  --flow "login process"
```

### How replay works

For each flow:

1. Opens fresh browser context (clean state)
2. Navigates to the flow's `startRoute`
3. Auto-authenticates (unless the flow itself contains login actions — detected automatically)
4. Checks for blocking overlays before each step and tries to dismiss them
5. Replays each step's actions in order:
   - `fill` — fills input field with resolved value
   - `click` — clicks element
   - `select` — opens dropdown trigger, waits for options, picks by position (handles both native `<select>` and custom Radix/headless dropdowns)
   - `hover` — hovers element
   - `press` — keyboard press
   - `waitForURL` — waits for navigation to complete
   - `submit` — clicks submit button
6. If a click is intercepted by an overlay, tries dismiss + retry once
7. Optionally slows browser actions with `--slow-mo`
8. Optionally pauses after every action with `--step-delay`
9. Waits for network idle and animations to settle
10. Runs verify checks
11. Takes screenshot per step (full page on failure)

Example recovery during replay:

```text
Step 2: click a "Reports", navigate to /home/reports
  ↳ overlay detected before step, dismissing...
  ↳ overlay dismissed
  ok click a:has-text('Reports')
  ok waitForURL "/home/reports"
  PASS [url_is] URL: /home/reports
```

### Variable resolution

All string values in flow actions are resolved before use:

| Variable | Resolved to |
|----------|------------|
| `$EMAIL` | `--email` flag or `$TEST_EMAIL` env var |
| `$PASSWORD` | `--password` flag or `$TEST_PASSWORD` env var |
| `$CUSTOM` | `--var CUSTOM=value` from CLI |

### Verify checks

| Check | What it verifies |
|-------|-----------------|
| `text_visible` | Specific text string is visible on the page |
| `toast_contains` | Toast notification (`.toast`, `[data-sonner-toast]`, `[role="alert"]`) contains text |
| `url_is` | Current URL pathname matches expected value |
| `landmark_visible` | Page identity element (h1, `data-page`, title) is present with expected text |
| `element_exists` | Selector finds at least one element |
| `element_gone` | Selector finds zero elements (e.g., dialog closed) |
| `no_js_errors` | No uncaught JavaScript errors during the step |
| `no_console_errors` | No `console.error` output during the step |
| `no_error_alerts` | No visible error alert/banner elements |

### E2E flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `$QA_PREVIEW_URL` or `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--flows` | Flows file path | `./QA_RECORDED_FLOWS.json` |
| `--flow` | Run specific flow by name (substring match) | all |
| `--tag` | Run flows with specific tag | all |
| `--output-dir` | Results directory | `./qa-results` |
| `--no-headless` | Show browser window | headless |
| `--stop-on-fail` | Stop after first failure | `false` |
| `--heal` | Auto-fix broken selectors and save to flows file | `false` |
| `--timeout` | Action timeout (ms) | `10000` |
| `--slow-mo` | Slow every Playwright browser action by N ms | `0` |
| `--step-delay` | Pause after each recorded action by N ms | `0` |
| `--demo` | Visible replay preset (`--no-headless --slow-mo 250 --step-delay 600`) | `false` |
| `--var` | Custom variable as `key=value` (repeatable) | — |

### Output

- `qa-results/e2e-summary.json` — Structured results with per-flow, per-step, per-action detail and selector health
- `qa-results/e2e-report.html` — Visual HTML report with step breakdown, heal indicators, and screenshots
- `qa-results/screenshots/` — Per-step screenshots

If a saved flow has known validation issues, the runner prints a warning before replay:

```text
⚠ Flow "wimsical" has known validation issues:
  - OVERLAY_BLOCKING at step 2
```

Exit code `0` if all flows pass, `1` if any fail.

### Recommended visible replay presets

Use these when you want to actually watch what the browser is doing:

```bash
# Balanced human-readable replay
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js \
  --url http://localhost:3000 \
  --no-headless \
  --slow-mo 200 \
  --step-delay 500

# Very slow demo mode for walkthroughs or debugging
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js \
  --url http://localhost:3000 \
  --demo
```

Guidance:

- `--slow-mo` slows low-level browser actions such as clicks, fills, and navigations.
- `--step-delay` adds a visible pause after each recorded action.
- `--demo` is a convenience preset for non-headless runs when the default replay feels too fast to follow.

---

## Auto-Healing

When a recorded selector breaks (e.g., dynamic IDs change between deploys), the E2E runner automatically tries to find the element using a multi-layer resolution strategy:

```
1. Primary selector (skip if dynamic ID like #radix-*)
   ↓ fails
2. Fallback selectors (from selectorFallbacks[])
   ↓ all fail
3. Text-based selector (text="Button Text")
   ↓ fails
4. Fuzzy healing strategies:
   a. Tag + text:     button:has-text("Save")
   b. Role + text:    [role="button"]:has-text("Save")
   c. Aria-label:     [aria-label="Close dialog"]
   d. Field name:     input[placeholder*="email" i]
   e. Href:           a[href="/reports"]
   f. Data-testid:    [data-testid*="submit"]
   ↓ all fail
5. Failed — action errors out
```

### Dynamic ID detection

Selectors starting with these patterns are automatically skipped (they change every page load):

```
#radix-*  #rc-*  #headlessui-*  #downshift-*  #mui-*  #:*
```

### Persisting healed selectors

Run with `--heal` to write fixes back to `QA_RECORDED_FLOWS.json`:

```bash
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url http://localhost:3000 --heal
```

What `--heal` does:
1. Promotes the healed selector to `selector` (primary)
2. Demotes the old broken selector to `selectorFallbacks[]`
3. Adds `_healedAt` timestamp and `_healedFrom` original selector
4. Writes the updated flows file

The next run uses the fixed selector directly — no healing needed.

### Selector health report

Every E2E run prints a selector health summary:

```
Selectors:
  Total:    12
  Primary:  9  (original selector worked)
  Fallback: 1  (used fallback/text)
  Healed:   2  (fuzzy match found)
  Failed:   0  (nothing worked)

Healed selectors:
  "login flow" step 3:
    #radix-_r_1b_ -> button:has-text('Select practice') [healed]
```

The HTML report also shows color-coded heal tags on each action.

---

## CI/CD Integration

### GitHub Actions example

```yaml
name: QA Tests

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  qa-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://npm.pkg.github.com'
          scope: '@rondah-ai'

      - name: Install dependencies
        run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Install Playwright
        run: npx playwright install --with-deps chromium

      - name: Run Health Checks
        env:
          QA_PREVIEW_URL: ${{ env.PREVIEW_URL }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
        run: |
          node node_modules/@rondah-ai/rondar/scripts/run-test.js \
            --url "$QA_PREVIEW_URL" \
            --suite smoke

      - name: Run E2E Flows
        env:
          QA_PREVIEW_URL: ${{ env.PREVIEW_URL }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
        run: |
          node node_modules/@rondah-ai/rondar/scripts/run-e2e.js \
            --url "$QA_PREVIEW_URL" \
            --heal

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-results
          path: qa-results/
```

### PR comment generation

Generate a formatted PR comment from test results:

```bash
node node_modules/@rondah-ai/rondar/scripts/generate-pr-comment.js \
  --results ./qa-results/summary.json \
  --preview-url "$PREVIEW_URL" \
  --pr-number 42
```

---

## CLI Reference

Rondar installs a `rondar` CLI binary:

```bash
# Show help
npx rondar --help

# Show version
npx rondar --version

# Run tests (standalone mode)
npx rondar test --url http://localhost:3000 --suite smoke

# Run tests (hybrid mode with AI fallback — requires ANTHROPIC_API_KEY)
npx rondar test --url http://localhost:3000 --suite smoke --mode hybrid
```

### CLI options

```
USAGE:
  rondar test [options]

OPTIONS:
  --url <url>              URL to test (required)
  --suite <suite>          Test suite: smoke, regression, critical (default: smoke)
  --mode <mode>            Execution mode: standalone, hybrid (default: standalone)
  --anchor-points <path>   Path to QA_ANCHOR_POINTS.json (legacy)
  --flows <path>           Path to QA_FLOWS.json (legacy)
  --output-dir <path>      Output directory for results (default: ./qa-results)
```

---

## Data Files

| File | Created by | Used by | Commit to git? |
|------|-----------|---------|----------------|
| `QA_FEATURE_MODEL.json` | init, learn | run-test | Yes |
| `QA_RECORDED_FLOWS.json` | learn | run-e2e | Yes |
| `QA_INSTRUCTIONS.json` | init | agent | Yes |
| `.qa-learn-session.json` | learn (auto-save) | learn (`--resume`) | No |
| `.qa-learn-history/` | learn (session end) | learn (`--history`) | No |
| `qa-results/` | run-test, run-e2e | Reports & artifacts | No |

### QA_FEATURE_MODEL.json structure

```json
{
  "version": "1.0",
  "meta": {
    "generated_by": "init",
    "learn_sessions": 2,
    "confidence": "observed"
  },
  "features": {
    "dashboard": {
      "description": "Main dashboard",
      "route": "/home/dashboard",
      "requires": ["authenticated"],
      "health": {
        "route": "/home/dashboard",
        "landmark": { "selector": "h1", "text": "Dashboard" },
        "checks": [
          { "type": "no_js_errors" },
          { "type": "url_is", "value": "/home/dashboard" },
          { "type": "landmark_visible", "selector": "h1", "text": "Dashboard" }
        ]
      },
      "capabilities": {
        "view_list": {
          "interaction": "navigate to page",
          "expected": ["table with records visible"],
          "verify": { "table_visible": { "type": "custom_selector_visible", "selector": "table" } },
          "_confidence": "observed_2x"
        }
      }
    }
  },
  "shared": {
    "authenticated": {
      "how": "fill email and password, submit",
      "route": "/auth/sign-in"
    }
  }
}
```

### QA_RECORDED_FLOWS.json structure

```json
{
  "version": "1.0",
  "flows": [
    {
      "name": "login and navigate",
      "startRoute": "/auth/sign-in",
      "steps": [
        {
          "stepNumber": 1,
          "route": "/home/call-logs",
          "description": "fill email, fill password, click Log In",
          "actions": [
            {
              "type": "fill",
              "selector": "[aria-label=\"Email Address\"]",
              "value": "$EMAIL",
              "field": "Enter your email",
              "selectorFallbacks": ["[aria-label=\"Email Address\"]"]
            },
            {
              "type": "fill",
              "selector": "[aria-label=\"Password\"]",
              "value": "$PASSWORD",
              "field": "Enter your password"
            },
            {
              "type": "click",
              "selector": "button:has-text('Log In')",
              "text": "Log In",
              "selectorFallbacks": ["button:has-text('Log In')", "button[type=\"submit\"]"]
            },
            {
              "type": "waitForURL",
              "value": "/home/call-logs"
            }
          ],
          "verify": [
            { "type": "url_is", "value": "/home/call-logs" },
            { "type": "landmark_visible", "selector": "title", "text": "Console" }
          ]
        }
      ],
      "stepCount": 1,
      "recordedAt": "2026-03-24T..."
    }
  ]
}
```

---

## Environment Variables

All scripts auto-load `.env` from the current working directory at startup. No `dotenv` dependency needed.

| Variable | Used by | Description |
|----------|---------|-------------|
| `QA_PREVIEW_URL` | All scripts | Target URL (alternative to `--url` flag) |
| `TEST_EMAIL` | All scripts | Test account email |
| `TEST_PASSWORD` | All scripts | Test account password |
| `ANTHROPIC_API_KEY` | CLI hybrid mode | API key for AI-enhanced testing |

### Credential parameterization

Credentials in `.env` are used for E2E flow parameterization:
- Email values typed during Learn are automatically replaced with `$EMAIL`
- Password field values are replaced with `$PASSWORD`

This means flows work across environments — staging, preview, CI — without editing the flows file.

---

## Migrating from Legacy Format

If you have old `QA_ANCHOR_POINTS.json` and `QA_FLOWS.json` files from v1, convert them to the new format:

```bash
node node_modules/@rondah-ai/rondar/scripts/migrate.js

# Or with custom paths
node node_modules/@rondah-ai/rondar/scripts/migrate.js \
  --flows ./QA_FLOWS.json \
  --anchors ./QA_ANCHOR_POINTS.json \
  --output ./QA_FEATURE_MODEL.json
```

### Migration flags

| Flag | Description | Default |
|------|-------------|---------|
| `--flows` | Legacy flows file | `./QA_FLOWS.json` |
| `--anchors` | Legacy anchor points file | `./QA_ANCHOR_POINTS.json` |
| `--output` | Output feature model path | `./QA_FEATURE_MODEL.json` |

After migration:

1. Review the generated `QA_FEATURE_MODEL.json`
2. Fill in any `"TODO"` test data values
3. Run `learn` sessions to upgrade confidence from `"migrated"` to `"observed"`
4. Record new E2E flows with `learn` (the old flow format is not compatible with `run-e2e.js`)

---

## Quick Reference

```bash
# Install
npm install @rondah-ai/rondar --save-dev
npx playwright install chromium

# Setup
echo 'TEST_EMAIL="test@example.com"' >> .env
echo 'TEST_PASSWORD="secret"' >> .env
echo 'QA_PREVIEW_URL="http://localhost:3000"' >> .env

# 1. Init — scan app, generate feature model
node node_modules/@rondah-ai/rondar/scripts/init.js

# 2. Learn — open browser, record interactions and E2E flows
node node_modules/@rondah-ai/rondar/scripts/learn.js
#   [r]     → start recording E2E flow
#   [Enter] → capture step (health checkpoint or flow step)
#   [v]     → add verify checks to last step
#   [f]     → finish and name the flow
#   [n]     → name the last capability
#   [e]     → record edge case
#   [s]     → skip/discard pending events
#   [d]     → done, save and exit

# 3. Test — health check every page
node node_modules/@rondah-ai/rondar/scripts/run-test.js --suite smoke

# 4. E2E — replay recorded flows
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js

# 5. E2E with auto-heal — fix broken selectors
node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --heal
```

---

**Rondar** is built by [Rondah](https://github.com/rondah-ai). MIT License.
