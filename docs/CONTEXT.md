# Rondar — Context Document

> **@rondah-ai/rondar** v2.0.1 — AI-powered automated QA testing agent for web apps.
> Learns your app by watching you use it, then runs health checks and replays E2E flows automatically.

---

## What Is Rondar?

Rondar is a **zero-config QA testing agent** that works in 5 phases:

```
INIT → LEARN → TEST → E2E → HEAL
```

Instead of writing test scripts by hand, you:
1. Point Rondar at your app — it scans and maps every page automatically
2. Use your app in a browser while Rondar watches and records
3. Run health checks and replay recorded flows on demand
4. When UI changes break selectors, Rondar auto-heals them

---

## Tech Stack

| Component       | Technology               |
|-----------------|--------------------------|
| Runtime         | Node.js ≥ 18             |
| Browser engine  | Playwright               |
| Schema/validation | Zod                    |
| AI (optional)   | Anthropic Claude SDK     |
| Language        | JavaScript (scripts) + TypeScript (tools/qa modules) |

---

## Project Structure

```
opencode/
├── bin/qa-agent.js              # CLI entry point (rondar command)
├── index.js                     # Module entry (requires bin/qa-agent.js)
│
├── scripts/                     # Main executable scripts
│   ├── init.js                  # Phase 1: Scan app → build feature model
│   ├── learn.js                 # Phase 2: Watch user → record flows
│   ├── run-test.js              # Phase 3: Run health checks
│   ├── run-e2e.js               # Phase 4+5: Replay flows + auto-heal
│   ├── run-qa-ci.js             # CI mode runner
│   ├── run-qa-ci-hybrid.cjs     # Hybrid CI mode (AI + deterministic)
│   ├── run-qa-ai-only.cjs       # AI-only mode
│   ├── migrate.js               # Legacy file migration
│   └── generate-pr-comment.js   # PR comment from results
│
├── qa/                          # Core QA logic (TypeScript)
│   ├── feature-model.ts         # Zod schema for features, loader
│   ├── patterns.ts              # UI pattern recognition (auth, tables, CRUD)
│   ├── interaction-tracker.ts   # Browser event capture (clicks, typing)
│   ├── model-generator.ts       # Builds feature model from crawl
│   ├── model-merger.ts          # Merges learn sessions into model
│   ├── session-recorder.ts      # Records E2E flows
│   ├── state-snapshot.ts        # Page state snapshots
│   └── instructions.ts          # QA config management
│
├── browser/
│   └── manager.ts               # Playwright browser lifecycle
│
├── tools/                       # AI agent tools (28 TypeScript files)
│   ├── scan_page.ts             # Page scanning + pattern detection
│   ├── browser_interact.ts      # Click, type, select
│   ├── browser_navigate.ts      # Navigation
│   ├── execute_flow.ts          # Flow execution engine
│   ├── compose_test.ts          # Dynamic test composition
│   ├── resolve_selector.ts      # Description → CSS selector
│   ├── verify_behavior.ts       # Assertion checks
│   ├── accessibility_check.ts   # WCAG checks
│   ├── visual_regression.ts     # Visual diff
│   ├── generate_qa_report.ts    # HTML report generation
│   ├── load_qa_context.ts       # Load anchor points + flows
│   ├── screenshot.ts            # Screenshot capture
│   ├── map_site.ts              # Site route mapper
│   └── *.txt                    # Tool descriptions for AI
│
├── hybrid/                      # Hybrid mode support
│   ├── knowledge-manager.ts     # Learned solutions + patterns
│   └── types.ts                 # Type definitions
│
├── QA_FEATURE_MODEL.json        # Generated app blueprint
├── QA_RECORDED_FLOWS.json       # Recorded E2E flows
├── QA_INSTRUCTIONS.json         # QA execution config
├── qa-results/                  # Test output (reports, screenshots)
└── .qa-learn-history/           # Session history
```

---

## The 5 Phases Explained

### Phase 1: INIT — Scan & Map

Crawls your live app, recognizes UI patterns, generates a feature model.

```bash
# Basic scan
npm run init -- --url http://localhost:3000 --email test@x.com --password pass123

# With options
npm run init -- --url http://localhost:3000 --max-pages 30 --exclude "/admin,/debug"

# Instructions-only (regenerate config without rescanning)
npm run init -- --url http://localhost:3000 --instructions
```

**What it produces** — `QA_FEATURE_MODEL.json`:
```json
{
  "version": "1.0",
  "meta": {
    "generated_by": "init",
    "learn_sessions": 10,
    "confidence": "skeleton"
  },
  "features": {
    "authentication": {
      "description": "User login and session management",
      "route": "/auth/forgot-password",
      "capabilities": {
        "login": {
          "interaction": "fill email and password fields, click submit",
          "expected": ["redirect away from login page", "navigation or dashboard visible"],
          "verify": {
            "redirected": { "type": "url_changed" },
            "no_errors": { "type": "no_errors" }
          }
        },
        "login_invalid": {
          "interaction": "fill invalid credentials, click submit",
          "expected": ["error message appears", "stays on login page"],
          "verify": {
            "error_shown": {
              "type": "element_appeared",
              "selector": "[role='alert'], .text-red-500, .error"
            }
          },
          "test_data": {
            "email": "invalid@example.com",
            "password": "wrongpassword"
          }
        }
      }
    },
    "call_logs": {
      "description": "call logs page",
      "route": "/home/call-logs",
      "capabilities": { ... }
    }
  }
}
```

**Pattern Recognition** — Rondar auto-detects these UI patterns:
- Authentication forms (login, signup, forgot password)
- Data tables with rows/columns
- CRUD pages (create, read, update, delete)
- Navigation sidebars
- Form layouts

---

### Phase 2: LEARN — Watch & Record

Opens a visible browser. You use the app normally. Rondar watches and records everything.

```bash
# Start a learn session
npm run learn -- --url http://localhost:3000 --email test@x.com --password pass123

# Resume a previous session
npm run learn -- --url http://localhost:3000 --resume

# View session history
npm run learn -- --history
```

**During a session:**
- A browser opens and you interact with your app
- Press `r` to start recording a named flow (e.g., "login process")
- Press `f` to finish the current flow
- Rondar captures clicks, typing, form submissions, navigation
- Credentials are auto-parameterized as `$EMAIL` / `$PASSWORD` for portability

**What it produces** — `QA_RECORDED_FLOWS.json`:
```json
{
  "version": "1.0",
  "flows": [
    {
      "name": "smoke",
      "startRoute": "/home/call-logs",
      "steps": [
        {
          "stepNumber": 1,
          "route": "/home/reports",
          "description": "click button 'Select practice', select option, click 'Reports'",
          "actions": [
            {
              "type": "select",
              "selector": "div > div.overflow-hidden > div",
              "triggerSelector": "button:has-text('Select practice')",
              "triggerText": "Select practice",
              "position": 1,
              "value": "Dentrix Test Practice",
              "selectorFallbacks": [
                "div:has-text('Dentrix Test Practice')"
              ]
            },
            {
              "type": "click",
              "selector": "a:has-text('Reports')",
              "text": "Reports",
              "selectorFallbacks": [
                "a[href=\"/home/reports\"]"
              ]
            },
            {
              "type": "waitForURL",
              "value": "/home/reports"
            }
          ],
          "landmark": {
            "selector": "h1",
            "text": "Reports"
          },
          "stateAfter": {
            "url": "http://localhost:3000/home/reports",
            "elementCounts": { "tbody tr": 1, "table": 1, "button:visible": 27 }
          }
        }
      ]
    }
  ]
}
```

**Key concepts in recorded flows:**
- **Actions**: `click`, `type`, `select`, `waitForURL`, `scroll`
- **Landmarks**: Page identity markers (h1 text, data-testid)
- **selectorFallbacks**: Alternative selectors if primary breaks
- **stateAfter**: Snapshot of page state after the step

---

### Phase 3: TEST — Health Checks

Navigates to every feature route and runs automated checks.

```bash
# Smoke tests (navigation-only, fast)
npm run test:smoke

# Full tests (all capabilities)
npm run test:full

# With options
npm run test -- --url http://localhost:3000 --suite full --output-dir ./results
```

**Health checks performed per page:**
| Check              | What it verifies                           |
|--------------------|--------------------------------------------|
| `no_js_errors`     | No uncaught JavaScript exceptions          |
| `no_console_errors`| No `console.error()` messages              |
| `no_error_alerts`  | No visible error alerts on page            |
| `url_is`           | Page loaded at the expected URL            |
| `landmark_visible` | Key page element (h1, heading) is visible  |

**Output** → `qa-results/summary.json` + `qa-results/report.html`

---

### Phase 4: E2E — Replay Flows

Replays recorded flows step-by-step with outcome verification.

```bash
# Run all E2E flows
npm run e2e

# Run a specific flow
npm run e2e -- --flow login_flow

# Run flows tagged "smoke"
npm run e2e -- --tag smoke

# Stop on first failure
npm run e2e -- --stop-on-fail

# Pass custom variables
npm run e2e -- --var EMAIL=admin@test.com --var PASSWORD=secret

# Visible browser (non-headless)
npm run e2e -- --no-headless
```

---

### Phase 5: HEAL — Self-Healing Selectors

When selectors break due to UI changes, Rondar auto-fixes them.

```bash
# Run E2E with auto-healing enabled
npm run e2e:heal
```

**6 healing strategies** (tried in order):
1. **Tag + visible text** — `button:has-text('Submit')`
2. **ARIA role + text** — `[role='button']:has-text('Submit')`
3. **aria-label** — `[aria-label='Submit form']`
4. **Field name** — `input[name='email']`
5. **Link href** — `a[href='/dashboard']`
6. **data-testid** — `[data-testid='submit-btn']`

When healing succeeds, the healed selector is promoted to primary in `QA_RECORDED_FLOWS.json` for future runs.

---

## Configuration

### QA_INSTRUCTIONS.json

Controls execution behavior:

```json
{
  "version": "1.0",
  "global": {
    "viewport": { "width": 1920, "height": 1080 },
    "defaultTimeout": 10000,
    "waitAfterAction": 500,
    "toastTimeout": 5000,
    "screenshotsOn": ["failure", "capability_complete"],
    "customSelectors": {
      "toast": "[data-sonner-toast], [role='status'], [role='alert']"
    }
  },
  "scope": {
    "exclude_routes": [],
    "exclude_capabilities": [],
    "include_only": null,
    "max_pages": 20
  },
  "auth": {
    "strategy": "form",
    "session_duration": "30m",
    "reauth_on_redirect": true,
    "mfa": false
  }
}
```

### Environment Variables (.env)

```
QA_PREVIEW_URL=http://localhost:3000
TEST_EMAIL=test@example.com
TEST_PASSWORD=password123
```

---

## AI Tools (for Hybrid/AI Modes)

The `tools/` directory contains 28 TypeScript tools callable by AI agents. Each tool has a `.ts` implementation and a `.txt` description file.

| Tool | Purpose |
|------|---------|
| `scan_page` | Navigate to URL, detect patterns, run smoke checks |
| `browser_interact` | Click, type, select, submit — direct browser control |
| `browser_navigate` | Navigate to URLs |
| `execute_flow` | Run recorded flows (step-based or capability mode) |
| `compose_test` | Generate test scenarios dynamically |
| `resolve_selector` | Convert natural language → CSS selector |
| `verify_behavior` | Run assertions (element visible, text contains, URL matches) |
| `map_site` | Crawl and map all routes |
| `load_qa_context` | Load anchor points and recorded flows |
| `generate_qa_report` | Generate HTML test reports |
| `accessibility_check` | WCAG accessibility checks |
| `visual_regression` | Screenshot comparison for visual diffs |
| `screenshot` | Capture page screenshots |

**Example tool definition** (`scan_page.ts`):
```typescript
export const ScanPageTool = Tool.define("scan_page", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to scan"),
    waitFor: z.enum(["load", "domcontentloaded", "networkidle"]).default("networkidle"),
    screenshot: z.boolean().default(false),
    runSmoke: z.boolean().default(false),
    timeout: z.number().default(30000),
  }),
  async execute(params, ctx) { ... }
})
```

---

## CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/qa.yml
- name: Run QA Tests
  run: npm run test:smoke
  env:
    QA_PREVIEW_URL: ${{ secrets.PREVIEW_URL }}
    TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
    TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}

- name: Run E2E with Healing
  run: npm run e2e:heal

- name: Generate PR Comment
  run: node scripts/generate-pr-comment.js
```

### Exit Codes
- `0` — All tests passed
- `1` — One or more tests failed

---

## Quick Start Example

```bash
# 1. Install
npm install @rondah-ai/rondar

# 2. Set credentials
echo 'QA_PREVIEW_URL=http://localhost:3000' >> .env
echo 'TEST_EMAIL=test@example.com' >> .env
echo 'TEST_PASSWORD=secret' >> .env

# 3. Scan your app (generates feature model)
npm run init

# 4. Record E2E flows (opens browser, you interact)
npm run learn

# 5. Run health checks
npm run test:smoke

# 6. Replay recorded flows
npm run e2e

# 7. Auto-heal broken selectors after UI changes
npm run e2e:heal
```

---

## Key Data Files

| File | Generated By | Purpose |
|------|-------------|---------|
| `QA_FEATURE_MODEL.json` | `init` + `learn` | App blueprint — routes, capabilities, verification rules |
| `QA_RECORDED_FLOWS.json` | `learn` | Step-by-step E2E flows with actions and selectors |
| `QA_INSTRUCTIONS.json` | `init` | Execution config (timeouts, viewport, auth strategy) |
| `qa-results/summary.json` | `test` | Health check results |
| `qa-results/report.html` | `test` | Visual HTML report |
| `qa-results/e2e-summary.json` | `e2e` | E2E replay results |
| `qa-results/e2e-report.html` | `e2e` | Visual E2E report |
| `.qa-learn-history/` | `learn` | Historical session data |

---

## Core Concepts Glossary

| Term | Meaning |
|------|---------|
| **Feature** | A page/section of your app (e.g., "authentication", "call_logs") |
| **Capability** | Something a feature can do (e.g., "login", "create_appointment") |
| **Route** | URL path for a feature (e.g., `/home/reports`) |
| **Flow** | A recorded sequence of user interactions (steps) |
| **Step** | One unit in a flow (navigate, click, type, verify) |
| **Action** | A single browser interaction (`click`, `type`, `select`, `waitForURL`) |
| **Landmark** | A page identity marker (h1 text, data-testid) used to verify you're on the right page |
| **Selector** | CSS selector targeting a page element |
| **selectorFallbacks** | Backup selectors tried if primary fails |
| **Healing** | Auto-fixing broken selectors using fuzzy matching |
| **Pattern** | A recognized UI pattern (auth form, data table, CRUD) |
| **Smoke check** | Quick health check (no errors, correct URL, landmark visible) |
| **Feature model** | JSON blueprint of your app's features, routes, and capabilities |
| **Confidence** | How certain the model is (`init` = auto-generated, `learned` = human-verified) |
