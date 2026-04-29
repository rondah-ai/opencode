# Rondar — Usage Guide

> Complete guide to using Rondar, the AI-powered QA testing agent.
> Learns your app by watching you use it, then runs health checks and replays E2E flows automatically.

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
- [Init — Scan Your App](#init--scan-your-app)
- [Learn — Teach the Agent](#learn--teach-the-agent)
- [Test — Run Health Checks](#test--run-health-checks)
- [E2E — Replay Recorded Flows](#e2e--replay-recorded-flows)
- [Auto-Healing](#auto-healing)
- [Bootstrap Setup](#bootstrap-setup)
- [CI/CD Integration](#cicd-integration)
- [Data Files](#data-files)
- [Environment Variables](#environment-variables)

---

## Installation

**Prerequisites:** Node.js >= 18

```bash
# 1. Configure npm for GitHub Packages
echo '@rondah-ai:registry=https://npm.pkg.github.com' >> .npmrc
echo '//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN' >> .npmrc

# 2. Install
npm install @rondah-ai/rondar --save-dev

# 3. Install Playwright browsers
npx playwright install chromium
```

---

## Setup

Create a `.env` file:

```env
TEST_EMAIL="test@example.com"
TEST_PASSWORD="secret123"
QA_PREVIEW_URL="http://localhost:3000"
```

All scripts auto-load `.env` from the working directory.

---

## Init — Scan Your App

Crawls your app, discovers routes, recognizes UI patterns, and generates a feature model with route-level health checks.

### Basic Usage

```bash
# Using npm scripts
npm run init -- --url http://localhost:3000 --email test@x.com --password secret

# Direct
node scripts/init.js --url http://localhost:3000 --email test@x.com --password secret
```

### With Bootstrap (for apps needing setup)

If your app requires practice/org/workspace selection after login:

```bash
# Record setup once (opens visible browser)
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless

# Future runs reuse saved bootstrap automatically
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456
```

During bootstrap recording:
1. Sign in, select practice/org, dismiss prompts in the browser
2. Watch for `Recorded N bootstrap events...` in terminal
3. Press `d` when the app is ready for scanning

### What Init Generates

**`QA_FEATURE_MODEL.json`** — Every discovered route gets:
- A `health` block with checks: `url_is`, `no_js_errors`, `no_console_errors`, `no_error_alerts`
- A `landmark` for page identity (data-page > data-testid > h1 > h2 > title)
- Pattern-based capabilities (e.g., `view_list` for data tables)

**`QA_INSTRUCTIONS.json`** — Global settings: viewport, timeouts, custom selectors.

### Init Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `$QA_PREVIEW_URL` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--max-pages` | Max pages to crawl | `20` |
| `--record-bootstrap` | Record setup steps before scanning | `false` |
| `--use-bootstrap` | Force replay of saved bootstrap | `false` |
| `--no-bootstrap` | Skip saved bootstrap for this run | `false` |
| `--no-headless` | Show browser window | headless |
| `--exclude` | Comma-separated route prefixes to skip | — |
| `--timeout` | Navigation timeout (ms) | `30000` |

### Example: Full Init With Bootstrap

```bash
# First time — record bootstrap setup
npm run init -- \
  --url http://localhost:3000 \
  --email john@mail.com \
  --password 123456 \
  --record-bootstrap \
  --no-headless

# Subsequent runs — reuses bootstrap, scans headlessly
npm run init -- \
  --url http://localhost:3000 \
  --email john@mail.com \
  --password 123456
```

---

## Learn — Teach the Agent

Opens a visible browser, watches your interactions, and records capabilities and E2E flows.

### Basic Usage

```bash
npm run learn -- --url http://localhost:3000 --email test@x.com --password secret
```

### Interactive Commands

| Key | Action |
|-----|--------|
| `Enter` | Record health checkpoint (or flow step if recording) |
| `r` | Start recording an E2E flow |
| `f` | Finish flow — validates, then save/fix/discard |
| `v` | Add verify check to last flow step |
| `x` | Auto-dismiss blocking overlay/modal/dropdown |
| `k` | Keep pending auto-split as one step |
| `n` | Name last capability |
| `e` | Record edge case |
| `s` | Skip / discard pending events |
| `d` | Done — finish session and save |

### Recording an E2E Flow — Step by Step

```
1. Press [r] to start recording
2. Do something in the browser (e.g., click "Reports" link)
3. Press [Enter] to capture the step
4. If a dropdown/modal stays open, press [x] to dismiss
5. If auto-split is suggested, press [Enter] to accept or [k] to keep as one
6. Repeat for each meaningful interaction
7. Press [v] to add verify checks (e.g., "Success toast appeared")
8. Press [f] to finish — agent validates by replaying in a headless browser
9. Choose: [f] apply fixes, [s] save anyway, [d] discard
```

### Example: Recording a Login Flow

```
> r
  FLOW RECORDING STARTED

  (sign in with email/password in the browser)

> [Enter]
  FLOW STEP 1: type in email field, type in password field, click "Log In"
    Route: /auth/sign-in
    → fill input[type="email"] "$EMAIL"
    → fill input[type="password"] "$PASSWORD"
    → click button:has-text('Log In')

  (page navigates to /home/call-logs)

> [Enter]
  FLOW STEP 2: navigate to /home/call-logs
    Route: /home/call-logs
    → waitForURL /home/call-logs
    landmark: h1 "Call Logs"

> f
  Name this flow: login process

  Validating "login process"... (replaying 2 steps)
  ✓ Validation PASSED

  FLOW SAVED: "login process" (2 steps)
```

### Example: Recording With Overlay Handling

```
> [Enter]
  ⚠ WARNING: dropdown is still open ("Select practice")
    This will block clicks in the next step.
    → Close it in the browser, then press [Enter]
    → Or press [x] to auto-dismiss and continue
    → Or press [Enter] again to record anyway

> x
  ✓ Overlay dismissed. Press [Enter] to record step.
```

### Example: Auto-Split on Navigation Boundaries

```
> [Enter]
  Auto-splitting into 3 steps (navigation boundaries detected):
    Step 2: click "Reports", navigate to /home/reports → /home/reports
    Step 3: click "Voicemails", navigate to /home/voicemails → /home/voicemails
    Step 4: click "Notifications" → /home/notifications

    Press [Enter] to accept split  |  [k] to keep as single step
```

### What Gets Recorded

- Clicks on buttons, links, tabs, menu items
- Text input (passwords masked, credentials parameterized as `$EMAIL`/`$PASSWORD`)
- Dropdown/select options (by position, not value — works across environments)
- Form submissions
- Page navigations

### Guardrails

- Warns if an overlay/modal is still open before committing a step
- Warns on unusually large steps (>8 actions)
- Auto-splits navigation-heavy batches
- Validates flows before saving (headless replay)
- Saves interrupted flows as drafts on unexpected close

---

## Test — Run Health Checks

Navigates to every feature route and runs health checks from `QA_FEATURE_MODEL.json`.

### Basic Usage

```bash
# Smoke test (default)
npm run test -- --url http://localhost:3000 --email test@x.com --password secret

# Full test (all capabilities)
npm run test:full -- --url http://localhost:3000 --email test@x.com --password secret

# Test specific features
npm run test -- --url http://localhost:3000 --features dashboard,reports
```

### Health Checks

| Check | What it verifies | Failure Category |
|-------|-----------------|-----------------|
| `url_is` | URL matches expected route | — |
| `no_js_errors` | No uncaught JavaScript errors | `hydration_error` or `runtime_error` |
| `no_console_errors` | No console.error() output | `console_error` |
| `no_error_alerts` | No visible error banners | — |
| `no_request_failures` | No failed API requests (fetch/xhr) | `request_failure` |
| `landmark_visible` | Page identity element present | — |

### Example Output

```
[1/10] call_logs._health
  Route: /home/call-logs
  PASS [url_is] URL matches: /home/call-logs
  PASS [no_js_errors] No JS errors
  PASS [no_console_errors] No console errors
  PASS [no_error_alerts] No error alerts visible
  PASS [landmark] Title contains "Rondah AI Console"
  -> PASSED (5/5 checks)

[4/10] system_health._health
  Route: /home/admin-hub/system-health
  PASS [url_is] URL matches: /home/admin-hub/system-health
  FAIL [no_js_errors] [hydration_error] Hydration error: server HTML didn't match client
  PASS [no_console_errors] No console errors
  -> FAILED (4/5 checks)

Failure categories:
  hydration_error: 1
  console_error: 2
```

### Test Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `$QA_PREVIEW_URL` |
| `--suite` | `smoke` or `full` | `smoke` |
| `--features` | Comma-separated feature names | all |
| `--no-headless` | Show browser | headless |
| `--include-init` | Run unlearned skeleton capabilities | `false` |
| `--timeout` | Navigation timeout (ms) | `10000` |

### Output

- `qa-results/summary.json` — Structured results with failure categories
- `qa-results/report.html` — Visual report
- `qa-results/screenshots/` — Per-feature screenshots

---

## E2E — Replay Recorded Flows

Replays recorded flows from `QA_RECORDED_FLOWS.json` against a live app.

### Basic Usage

```bash
# Run all flows
npm run e2e -- --url http://localhost:3000 --email john@mail.com --password 123456

# Run a specific flow
npm run e2e -- --flow "login process"

# Visible replay for debugging
npm run e2e -- --url http://localhost:3000 --no-headless

# Demo mode (slow visible replay)
npm run e2e -- --url http://localhost:3000 --demo

# Stop on first failure
npm run e2e -- --stop-on-fail
```

### E2E Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--flow` | Run specific flow by name | all |
| `--tag` | Run flows with specific tag | all |
| `--heal` | Auto-fix broken selectors | `false` |
| `--stop-on-fail` | Stop after first failure | `false` |
| `--no-headless` | Show browser | headless |
| `--slow-mo` | Slow actions by N ms | `0` |
| `--step-delay` | Pause after each action by N ms | `0` |
| `--demo` | Visible slow replay preset | `false` |
| `--var` | Custom variable `key=value` | — |

### Replay Behavior

- Dismisses blocking overlays before each step automatically
- Retries clicks intercepted by overlays (Escape → backdrop click → force click)
- Waits for network and animations to settle between steps
- Warns when replaying flows with known validation issues

### Verify Checks in Flows

| Check | What it verifies |
|-------|-----------------|
| `text_visible` | Specific text visible on page |
| `toast_contains` | Toast contains expected text |
| `url_is` | URL matches expected path |
| `landmark_visible` | Page identity element present |
| `element_exists` | Element is present |
| `element_gone` | Element was removed |

---

## Auto-Healing

When a selector breaks (e.g., dynamic IDs change between deploys), the runner automatically finds the element using fuzzy matching.

### Healing Strategy Chain

```
Primary selector fails
  → Try fallback selectors
    → Try text-based selector
      → Fuzzy heal: tag+text, role+text, aria-label, field name, href, data-testid
```

| Strategy | Example |
|----------|---------|
| Tag + text | `button:has-text("Save")` |
| Role + text | `[role="button"]:has-text("Save")` |
| Aria-label | `[aria-label="Submit form"]` |
| Field name | `input[name="email"]` |
| Href | `a[href="/dashboard"]` |
| Data-testid | `[data-testid="submit-btn"]` |

### Persisting Healed Selectors

```bash
# Run with --heal to save fixes back to QA_RECORDED_FLOWS.json
npm run e2e:heal -- --url http://localhost:3000

# What happens:
# 1. Broken selector detected during replay
# 2. Fuzzy match finds working alternative
# 3. --heal flag promotes healed selector to primary
# 4. Old broken selector demoted to fallback
# 5. Next run uses fixed selector directly
```

### Selector Health Report

Every run shows:

```
Selectors:
  Total:    12
  Primary:  9 (original selector worked)
  Fallback: 1 (used fallback/text)
  Healed:   2 (fuzzy match found)
  Failed:   0 (nothing worked)
```

---

## Bootstrap Setup

For apps that need setup beyond login (practice selection, org switching, onboarding dismissal):

### Record Bootstrap Once

```bash
npm run init -- --url http://localhost:3000 \
  --email john@mail.com --password 123456 \
  --record-bootstrap --no-headless
```

1. Browser opens to your app
2. Sign in, select practice, dismiss prompts
3. Press `d` when ready

Saves to `QA_INIT_BOOTSTRAP.json`. All subsequent init/test/e2e runs replay it automatically.

### Bootstrap Behavior

- Pre-login steps (auth) are **critical** — failures abort
- Post-login steps (practice selection, prompt dismissal) are **best-effort** — failures are logged but don't abort
- Bootstrap is replayed in a fresh browser context (no stale session state)

### Override Bootstrap

```bash
# Force replay even if file exists
npm run init -- --use-bootstrap

# Skip bootstrap for one run
npm run init -- --no-bootstrap

# Use a different bootstrap file
npm run init -- --bootstrap-file ./custom-bootstrap.json
```

---

## CI/CD Integration

### GitHub Actions

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
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install
        run: npm install @rondah-ai/rondar --save-dev && npx playwright install --with-deps chromium

      - name: Health Checks
        env:
          QA_PREVIEW_URL: ${{ env.PREVIEW_URL }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
        run: node node_modules/@rondah-ai/rondar/scripts/run-test.js --url "$QA_PREVIEW_URL" --suite smoke

      - name: E2E Flows
        env:
          QA_PREVIEW_URL: ${{ env.PREVIEW_URL }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
        run: node node_modules/@rondah-ai/rondar/scripts/run-e2e.js --url "$QA_PREVIEW_URL" --heal

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-results
          path: qa-results/
```

---

## Data Files

| File | Created By | Used By | Description |
|------|-----------|---------|-------------|
| `QA_FEATURE_MODEL.json` | init, learn | run-test | Routes, capabilities, health blocks, landmarks |
| `QA_RECORDED_FLOWS.json` | learn | run-e2e | E2E flows with actions and verify checks |
| `QA_INSTRUCTIONS.json` | init | run-test | Viewport, timeouts, auth config, custom selectors |
| `QA_INIT_BOOTSTRAP.json` | init (record) | init, run-test | Bootstrap setup steps for auth + environment |
| `qa-results/` | run-test, run-e2e | — | Reports, screenshots, JSON summaries |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `QA_PREVIEW_URL` | Target URL to test |
| `TEST_EMAIL` | Test account email |
| `TEST_PASSWORD` | Test account password |

Credentials are auto-parameterized as `$EMAIL`/`$PASSWORD` in recorded flows so they work across environments.



NPM_TOKEN=your_new_token npm publish --access public
