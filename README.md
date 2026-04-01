# Rondar

AI-powered testing agent for web applications. Learns your app by watching you use it, then runs health checks and replays E2E flows automatically.

## How It Works

```
1. INIT    → Scans your app, builds a feature model
2. LEARN   → You use the app, agent watches and records
3. TEST    → Health checks every page (landmark-based)
4. E2E     → Replays recorded workflows end-to-end
5. HEAL    → Auto-fixes broken selectors when UI changes
```

## Installation

### Via npm (GitHub Packages)

```bash
npm install @rondah-ai/rondar --save-dev
```

### Via Direct Copy

```bash
cp -r rondar /path/to/your-repo/.rondar
cd /path/to/your-repo/.rondar
npm install
```

## Quick Start

```bash
# Set up credentials (all scripts auto-load .env)
echo 'TEST_EMAIL="test@x.com"' >> .env
echo 'TEST_PASSWORD="secret"' >> .env
echo 'QA_PREVIEW_URL="http://localhost:3000"' >> .env

# 1. Initialize — scan your app and build the feature model
node scripts/init.js

# 2. Learn — open browser, use your app, agent records capabilities and E2E flows
node scripts/learn.js

# 3. Health check — verify every page loads correctly
node scripts/run-test.js

# 4. E2E replay — replay recorded flows
node scripts/run-e2e.js

# 5. Auto-heal — fix broken selectors after UI changes
node scripts/run-e2e.js --heal
```

## Scripts

### `init.js` — Initialize Feature Model

Crawls your app, discovers routes, and builds `QA_FEATURE_MODEL.json`.

```bash
node scripts/init.js --url http://localhost:3000 --email test@x.com --password secret
```

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--output` | Model output path | `./QA_FEATURE_MODEL.json` |
| `--max-pages` | Max pages to crawl | `50` |

### `learn.js` — Interactive Learning Session

Opens a browser, watches your interactions, and records capabilities and E2E flows.

```bash
node scripts/learn.js --url http://localhost:3000 --email test@x.com --password secret
```

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--model` | Feature model path | `./QA_FEATURE_MODEL.json` |
| `--resume` | Resume previous session | `false` |

**Interactive Commands:**

| Key | Action |
|-----|--------|
| `Enter` | Record health checkpoint (or flow step if recording) |
| `r` | Start recording an E2E flow |
| `f` | Finish E2E flow, validate it, then save/discard |
| `v` | Add verify check to last flow step |
| `x` | Auto-dismiss blocking overlay/modal/dropdown |
| `k` | Keep a pending auto-split as one step |
| `n` | Name the last recorded capability |
| `e` | Record edge case for last capability |
| `s` | Skip / discard pending events |
| `d` | Done — finish session and save |

**Recording E2E Flows:**

```
1. Press [r] to start recording
2. Perform actions in the browser
3. Press [Enter] after each meaningful step
4. If a dropdown/modal stays open, use [x] to dismiss it before the next step
5. If navigation boundaries are detected, press [Enter] to accept auto-split or [k] to keep as one step
6. Press [v] to add verify checks (e.g., "Success" toast appeared)
7. Press [f] to finish, validate, and save the flow
```

Flows are saved to `QA_RECORDED_FLOWS.json`.

**Recorder Guardrails:**
- Warns if a blocking overlay, modal, or dropdown is still open before committing a step
- Warns on unusually large steps
- Auto-splits navigation-heavy batches into smaller steps
- Saves interrupted in-progress flows as draft entries on unexpected close

**Flow Validation:**
- Replays the flow in a fresh headless browser when you press `f`
- If validation fails, you can apply fixes, save with known issues, or discard
- Validation issues are tagged in the flow JSON and shown by the E2E runner later

**What the agent tracks:**
- Clicks on buttons, links, tabs, menu items
- Text input in fields (passwords are masked)
- Dropdown/select option selections (by position, not value — works across environments)
- Form submissions
- Page navigations

Credentials are auto-parameterized as `$EMAIL`/`$PASSWORD` so flows are portable.

### `run-test.js` — Health Check Runner

Navigates to every feature route and verifies pages load correctly using landmark-based checks.

```bash
# Smoke test (navigation-only capabilities)
node scripts/run-test.js --url http://localhost:3000 --email test@x.com --password secret

# Full test (all capabilities)
node scripts/run-test.js --url http://localhost:3000 --suite full

# Test specific features
node scripts/run-test.js --url http://localhost:3000 --features dashboard,reports
```

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--model` | Feature model path | `./QA_FEATURE_MODEL.json` |
| `--suite` | `smoke` or `full` | `smoke` |
| `--features` | Comma-separated feature names | all |
| `--output-dir` | Results directory | `./qa-results` |
| `--no-headless` | Show browser window | headless |
| `--timeout` | Navigation timeout (ms) | `10000` |

**Health Checks (V2):**

| Check | What it verifies |
|-------|-----------------|
| `no_js_errors` | No uncaught JavaScript errors |
| `no_console_errors` | No console.error output |
| `no_error_alerts` | No visible error banners/alerts |
| `url_is` | URL matches expected route |
| `landmark_visible` | Page identity element present (h1, data-testid, etc.) |

**Output:**
- `qa-results/summary.json` — Structured results
- `qa-results/report.html` — Visual report
- `qa-results/screenshots/` — Per-feature screenshots

Exit code: `0` if all pass, `1` if any fail.

### `run-e2e.js` — E2E Replay Runner

Replays recorded E2E flows against a live app and verifies outcomes.

```bash
# Run all recorded flows
node scripts/run-e2e.js --url http://localhost:3000 --email john@mail.com --password 123456

# Run a specific flow
node scripts/run-e2e.js --url http://localhost:3000 --flow login_flow

# Stop on first failure, show browser
node scripts/run-e2e.js --url http://localhost:3000 --stop-on-fail --no-headless

# Slow visible replay so humans can follow it
node scripts/run-e2e.js --url http://localhost:3000 --no-headless --slow-mo 200 --step-delay 500

# Demo preset for readable visible replay
node scripts/run-e2e.js --url http://localhost:3000 --demo

# Auto-heal broken selectors and save fixes
node scripts/run-e2e.js --url http://localhost:3000 --heal

# Custom variables
node scripts/run-e2e.js --url http://localhost:3000 --var PATIENT_NAME="John Doe"

# all 
node scripts/run-e2e.js --url http://localhost:3000 --heal --email john@mail.com --password 123456 --stop-on-fail --no-headless --flow "login process"

```

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | App URL | `http://localhost:3000` |
| `--email` | Login email | `$TEST_EMAIL` |
| `--password` | Login password | `$TEST_PASSWORD` |
| `--flows` | Flows file path | `./QA_RECORDED_FLOWS.json` |
| `--flow` | Run specific flow by name | all |
| `--tag` | Run flows with specific tag | all |
| `--output-dir` | Results directory | `./qa-results` |
| `--no-headless` | Show browser window | headless |
| `--stop-on-fail` | Stop after first failure | `false` |
| `--heal` | Auto-fix broken selectors and save to flows file | `false` |
| `--timeout` | Action timeout (ms) | `10000` |
| `--slow-mo` | Slow every Playwright browser action by N ms | `0` |
| `--step-delay` | Pause after each recorded action by N ms | `0` |
| `--demo` | Visible replay preset (`--no-headless --slow-mo 250 --step-delay 600`) | `false` |
| `--var` | Custom variable `key=value` | — |

**Verify Checks:**

| Check | What it verifies |
|-------|-----------------|
| `text_visible` | Specific text is visible on page |
| `toast_contains` | Success/error toast contains text |
| `url_is` | URL changed to expected path |
| `landmark_visible` | Page identity element present |
| `element_exists` | Element is present (e.g., dialog opened) |
| `element_gone` | Element removed (e.g., dialog closed) |
| `no_js_errors` | No JavaScript errors |
| `no_console_errors` | No console errors |
| `no_error_alerts` | No error alerts visible |

**Replay Behavior:**
- Dismisses blocking overlays before each step when possible
- Retries intercepted clicks after dismissal
- Waits for network and animations to settle between steps
- Warns when replaying flows previously saved with known validation issues

**Visible Replay Presets:**
```bash
node scripts/run-e2e.js --url http://localhost:3000 --no-headless --slow-mo 200 --step-delay 500
node scripts/run-e2e.js --url http://localhost:3000 --demo
```

**Selector Auto-Healing:**

When a recorded selector breaks (e.g., dynamic IDs change between deploys), the runner automatically tries to find the element using fuzzy matching:

```
Primary selector fails
  → Try fallback selectors
    → Try text-based selector
      → Fuzzy heal: tag+text, role+text, aria-label, field name, href, data-testid
```

| Strategy | How it finds the element |
|----------|------------------------|
| Tag + text | `button:has-text("Save")` — same tag and visible text |
| Role + text | `[role="button"]:has-text("Save")` — ARIA role with text |
| Aria-label | Extracts aria-label from broken selector, searches for it |
| Field name | For inputs: matches by placeholder, name, or aria-label |
| Href | For links: matches by href attribute |
| Data-testid | Partial match on data-testid prefix |

The `--heal` flag writes working selectors back to `QA_RECORDED_FLOWS.json`:
- Promotes the healed selector to primary
- Demotes the old broken selector to fallbacks
- Next run uses the fixed selector directly

**Selector Health Report:**

Every run shows a selector health summary:

```
  Selectors:
    Total:    12
    Primary:  9 (original selector worked)
    Fallback: 1 (used fallback/text)
    Healed:   2 (fuzzy match found)
    Failed:   0 (nothing worked)

  Healed selectors:
    "login flow" step 3:
      #radix-_r_1b_ -> button:has-text('Select practice') [healed]
```

The HTML report also shows a Selector Health section with color-coded cards and per-action heal tags.

**Output:**
- `qa-results/e2e-summary.json` — Structured results with selector health data
- `qa-results/e2e-report.html` — Visual report with flow/step breakdown and heal indicators
- `qa-results/screenshots/` — Per-step screenshots

Exit code: `0` if all flows pass, `1` if any fail.

### `migrate.js` — Migrate Legacy Files

Converts old `QA_ANCHOR_POINTS.json` + `QA_FLOWS.json` into the new `QA_FEATURE_MODEL.json` format.

```bash
node scripts/migrate.js
```

## Data Files

| File | Created by | Used by | Description |
|------|-----------|---------|-------------|
| `QA_FEATURE_MODEL.json` | init, learn | run-test | Feature map with routes, capabilities, health blocks |
| `QA_RECORDED_FLOWS.json` | learn | run-e2e | Recorded E2E flows with actions and verify checks |

## GitHub Actions

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

      - name: Install QA Agent
        run: npm install @rondah-ai/rondar --save-dev

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

## Environment Variables

All scripts auto-load a `.env` file from the working directory. No need to pass `--email`/`--password` flags if they're in `.env`.

**`.env` example:**

```env
TEST_EMAIL="test@example.com"
TEST_PASSWORD="secret123"
QA_PREVIEW_URL="http://localhost:3000"
```

| Variable | Description |
|----------|-------------|
| `QA_PREVIEW_URL` | Target URL to test |
| `TEST_EMAIL` | Test account email |
| `TEST_PASSWORD` | Test account password |

Credentials in `.env` are also used for E2E flow parameterization — email and password values are automatically replaced with `$EMAIL` and `$PASSWORD` in recorded flows so they work across environments.

## Publishing

Published as `@rondah-ai/rondar` to GitHub Packages.

```bash
# Bump version
npm version patch  # or minor/major

# Publish (requires GITHUB_PKG_TOKEN)
export $(grep GITHUB_PKG_TOKEN .env | xargs) && npm publish

# Or push to auto-publish via GitHub Actions
git push origin main --tags
```

See the [CI/CD Deployment Guide](CICD_DEPLOYMENT_GUIDE.md) for full details.

### What Gets Published

```
node_modules/@rondah-ai/rondar/
├── bin/rondar.js                ← CLI entry point
├── index.js                     ← Main module entry
├── scripts/
│   ├── init.js                  ← Feature model generator
│   ├── learn.js                 ← Interactive learning + E2E recording
│   ├── migrate.js               ← Legacy file migration
│   ├── run-test.js              ← Health check runner
│   └── run-e2e.js               ← E2E replay runner (with auto-healing)
├── tools/                       ← Tool definitions
├── package.json
└── README.md
```

## License

MIT
