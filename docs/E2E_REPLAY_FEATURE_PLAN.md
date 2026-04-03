# QA Testing System — Unified Feature Plan

> Two testing modes, one recording workflow. Health checks catch broken pages. E2E replay tests real workflows. Both are powered by the same `learn` recordings.

---

## Table of Contents

1. [The Problem with Current Checks](#1-the-problem-with-current-checks)
2. [System Overview](#2-system-overview)
3. [Verification Strategy — Replacing Unreliable Checks](#3-verification-strategy--replacing-unreliable-checks)
4. [Recording Workflow — Learn Mode V2](#4-recording-workflow--learn-mode-v2)
5. [Health Check Runner — `run-test.js` V2](#5-health-check-runner--run-testjs-v2)
6. [E2E Replay Runner — `run-e2e.js`](#6-e2e-replay-runner--run-e2ejs)
7. [Data Model — What Gets Stored](#7-data-model--what-gets-stored)
8. [Event Collapsing Rules](#8-event-collapsing-rules)
9. [Selector Resilience](#9-selector-resilience)
10. [CLI Interface](#10-cli-interface)
11. [Architecture Diagram](#11-architecture-diagram)
12. [Current Implementation Status](#12-current-implementation-status)
13. [Implementation Phases](#13-implementation-phases)
14. [Open Questions](#14-open-questions)
15. [Comprehensive Usage Guide](#15-comprehensive-usage-guide)

---

## 1. The Problem with Current Checks

### Unreliable verify checks

These checks produce false positives and false negatives because they depend on variable DOM state:

| Check | Why it's unreliable |
|-------|-------------------|
| `element_appeared` (e.g., `tbody tr`) | Row count depends on data in the database. 0 rows on a fresh env doesn't mean broken. |
| `element_disappeared` | Elements may still exist but be hidden. Or a loading spinner may not have disappeared yet. |
| `element_count_changed` | Counts differ between environments, between runs, between data states. Not deterministic. |

**Example:** Health check says "FAIL: `tbody tr` expected to appear" — but the page is fine, there's just no call log data in the test environment. That's a false failure. The opposite is also true: the check passes because rows exist, but the page is actually showing stale/wrong data.

### What we actually want to know

| Question | Reliable way to answer |
|----------|----------------------|
| "Did the page load?" | HTTP status + no JS crash + page title/heading present |
| "Is the right page showing?" | URL matches + a unique text/heading exists on page |
| "Did my action work?" | After clicking "Save" → specific success toast text appeared, OR URL changed to expected route |
| "Is the form working?" | Fill + submit → specific outcome (redirect, toast, new element with known text) |
| "Did anything break?" | Zero uncaught JS errors + no error banners visible |

---

## 2. System Overview

Two independent runners, one shared recording source:

```
┌─────────────────────────────────────────────────────────┐
│                     learn.js V2                         │
│                                                         │
│  [r] Start recording a flow                             │
│  [Enter] Record step (health checkpoint + replay step)  │
│  [Enter] Record step                                    │
│  [Enter] Record step                                    │
│  [f] Finish flow → names it, tags it, saves it          │
│                                                         │
│  [r] Start another flow                                 │
│  ...                                                    │
│  [d] Done — save everything                             │
└────────────┬──────────────────────┬─────────────────────┘
             │                      │
             ▼                      ▼
   QA_FEATURE_MODEL.json    QA_RECORDED_FLOWS.json
   (per-route health data)  (step-by-step replay data)
             │                      │
             ▼                      ▼
      run-test.js              run-e2e.js
   (health check runner)    (E2E replay runner)
             │                      │
             ▼                      ▼
    "Pages load correctly"   "Workflows work correctly"
```

### Key principle: usable separately

- `run-test.js` works with just `QA_FEATURE_MODEL.json` — no flows needed
- `run-e2e.js` works with just `QA_RECORDED_FLOWS.json` — no model needed
- Together they form a complete QA pipeline
- `learn.js` produces both files from a single session

---

## 3. Verification Strategy — Replacing Unreliable Checks

### Tiered verification

Replace the current all-or-nothing element counting with a tiered system. Each tier is more reliable than the last:

```
Tier 1: Page Alive        — did it load at all?
Tier 2: Right Page        — is this the correct page?
Tier 3: Functional         — did the action produce the expected outcome?
Tier 4: Data Integrity     — is the data correct? (future, requires API)
```

### Tier 1: Page Alive (health check)

**Checks:**
- HTTP response was not an error (page didn't crash)
- No uncaught JS exceptions (`pageerror` event)
- Zero console errors (`console.error`)
- No visible error alerts (`[role='alert']` with error text, `.error`, `.text-red-500`)
- `document.title` is not empty or "Error"
- Page `readyState` is "complete"

**Reliability:** Very high. If this fails, something is genuinely broken.

```typescript
interface AliveCheck {
  type: "page_alive"
  // Checks: readyState, title, no JS exceptions, no console errors, no error alerts
  ignoreConsolePatterns?: string[]   // regex patterns for known noisy errors to ignore (e.g., ResizeObserver)
}
```

**Console error handling:**
- All `console.error` calls are captured
- Known benign errors (e.g., `ResizeObserver loop`, third-party script warnings) can be excluded via `ignoreConsolePatterns` in QA_INSTRUCTIONS.json
- Error alerts are detected by scanning for `[role='alert']`, `.error`, `.text-red-500` elements whose text contains "error", "failed", "exception"

### Tier 2: Right Page (health check)

**Checks:**
- URL pathname matches the expected route
- A **landmark element** exists on the page — a heading, a unique text, or a `data-testid`

**What is a landmark?** A single element that uniquely identifies this page. Not a table row count — a heading like `h1:has-text("Call Logs")` or `[data-page="dashboard"]`. Captured during `learn` by looking at what's unique to each page.

**Reliability:** High. A heading/title is stable across data states and environments.

```typescript
interface RightPageCheck {
  type: "page_identity"
  route: string                          // expected URL pathname
  landmark: string                       // selector for unique page element
  landmarkText?: string                  // expected text content (optional)
}
```

**How landmarks are captured during learn:**

When user records a step, the system captures:
1. `document.title`
2. First `h1` text on the page
3. First `h2` text on the page
4. Any `[data-testid]` or `[data-page]` attributes
5. The page's `<nav>` active link text

From these, pick the most specific/unique one as the landmark. User can override via `[n]` command.

### Tier 3: Functional (E2E replay only)

**Checks applied after an action (click, fill, submit):**

| Check | When to use | How it works |
|-------|------------|--------------|
| `url_is` | After navigation | Exact URL pathname match |
| `text_visible` | After action | Specific text string exists on page |
| `text_not_visible` | After delete/remove | Specific text string gone |
| `element_exists` | After action | Selector matches at least 1 element |
| `element_gone` | After close/dismiss | Selector matches 0 elements |
| `toast_contains` | After form submit | Toast/alert contains specific text |
| `no_js_errors` | Always | Zero uncaught JS exceptions since last step |
| `no_console_errors` | Always | Zero `console.error` calls since last step |
| `input_has_value` | After fill | Input field contains expected value |
| `element_attribute` | After toggle/check | Element attribute has expected value |
| `option_selected` | After select | Dropdown has expected value selected |

**Key difference from current checks:** These check for **specific expected outcomes**, not "did some count change." They're tied to what the user actually saw happen during recording.

```typescript
interface FunctionalCheck {
  type: "url_is" | "text_visible" | "text_not_visible" |
        "element_exists" | "element_gone" | "toast_contains" |
        "no_js_errors" | "no_console_errors" | "input_has_value" |
        "element_attribute" | "option_selected"
  value?: string       // expected text or URL
  selector?: string    // element selector
  attribute?: string   // for element_attribute (e.g., "aria-checked")
}
```

**How functional checks are captured during learn:**

When the user records a step (presses Enter), the system:
1. Compares URL before vs after → if changed, adds `url_is` check with the new pathname
2. Scans for toast/alert elements → if new toast appeared, captures its text as `toast_contains`
3. If a dialog opened/closed → adds `element_exists`/`element_gone` with the dialog selector
4. Always adds `no_js_errors`

The user can also manually add checks via a new `[v]` command (see Section 4).

### What gets dropped

These current check types are **removed** from the health check runner:

| Removed | Why |
|---------|-----|
| `element_count_changed` | Count changes are not deterministic across environments |
| `element_appeared` (count-based) | Replaced by `element_exists` (presence-based, not count-based) |
| `element_disappeared` (count-based) | Replaced by `element_gone` (absence-based) |
| `toast_appeared` (boolean) | Replaced by `toast_contains` (checks actual text) |

---

## 3b. Recording Interaction Types

The tracker (`window.__qaTracker`) captures raw DOM events. Here's how each interaction type gets recorded, collapsed, and replayed:

### Text Input

**What the tracker captures:**
```
click  { selector: "input[aria-label='Email']", tag: "input" }
input  { selector: "input[aria-label='Email']", value: "j", field: "Email" }
input  { selector: "input[aria-label='Email']", value: "jo", field: "Email" }
input  { selector: "input[aria-label='Email']", value: "john@mail.com", field: "Email" }
```

**After collapsing (Rule 1 + 2):**
```json
{ "type": "fill", "selector": "input[aria-label='Email']", "value": "john@mail.com", "field": "Email" }
```

**Replay:** `page.fill("input[aria-label='Email']", "john@mail.com")`

### Button Click

**What the tracker captures:**
```
click  { selector: "button.px-4.py-2", text: "Save Changes", tag: "button" }
```

**After collapsing (Rule 5 — prefer text):**
```json
{
  "type": "click",
  "selector": "button:has-text('Save Changes')",
  "selectorFallbacks": ["button.px-4.py-2"],
  "text": "Save Changes"
}
```

**Replay:** `page.click("button:has-text('Save Changes')")`

### Link / Navigation Click

**What the tracker captures:**
```
click      { selector: "a.nav-link", text: "Reports", tag: "a" }
navigation { url: "http://localhost:3000/home/reports" }
```

**After collapsing (Rule 4 + 5):**
```json
{ "type": "click", "selector": "a:has-text('Reports')", "text": "Reports" },
{ "type": "waitForURL", "value": "/home/reports" }
```

**Replay:** `page.click("a:has-text('Reports')")` → `page.waitForURL("**/home/reports")`

### Dropdown / Select

**What the tracker captures:**

For native `<select>` elements:
```
click  { selector: "select#timezone", tag: "select" }
input  { selector: "select#timezone", value: "America/New_York", field: "Timezone" }
```

**After collapsing:**
```json
{ "type": "select", "selector": "select#timezone", "value": "America/New_York", "field": "Timezone" }
```

**Replay:** `page.selectOption("select#timezone", "America/New_York")`

For custom dropdown components (e.g., Radix, Headless UI):
```
click  { selector: "button:has-text('Select practice')", tag: "button" }
click  { selector: "[role='option']:has-text('Dentrix Test')", tag: "div" }
```

**After collapsing:**
```json
{ "type": "click", "selector": "button:has-text('Select practice')", "text": "Select practice" },
{ "type": "click", "selector": "[role='option']:has-text('Dentrix Test')", "text": "Dentrix Test" }
```

**Replay:** Two clicks — open dropdown, then click option. This matches how the user actually interacted.

### Toggle / Checkbox / Radio

**What the tracker captures:**
```
click  { selector: "input[type='checkbox']#notifications", tag: "input" }
```

Or for custom toggle components:
```
click  { selector: "button[role='switch'][aria-label='Enable notifications']", tag: "button" }
```

**After collapsing:**
```json
{ "type": "click", "selector": "button[role='switch'][aria-label='Enable notifications']", "text": "" }
```

**Replay:** `page.click("button[role='switch'][aria-label='Enable notifications']")`

**State verification:** After toggling, the system captures the `aria-checked` attribute value to add a verify check:
```json
{ "type": "element_attribute", "selector": "[aria-label='Enable notifications']", "attribute": "aria-checked", "value": "true" }
```

### Date Picker

**What the tracker captures (typical calendar component):**
```
click  { selector: "button:has-text('03/16/2026')", tag: "button" }   ← open picker
click  { selector: "button:has-text('17')", tag: "button" }            ← select day
click  { selector: "button:has-text('8')", tag: "button" }             ← select something else
```

**After collapsing:**
```json
{ "type": "click", "selector": "button:has-text('03/16/2026')", "text": "03/16/2026" },
{ "type": "click", "selector": "button:has-text('17')", "text": "17" },
{ "type": "click", "selector": "button:has-text('8')", "text": "8" }
```

**Note:** Date picker clicks are stored literally. Dates are inherently variable — during replay, these specific date texts may not exist. Options:
- Mark date values as `$TODAY`, `$TOMORROW` etc. during recording
- Or accept that date-picker flows may need manual updating
- Future: detect calendar components and parameterize automatically

### Form Submission

**What the tracker captures:**
```
click  { selector: "button:has-text('Add Patient')", tag: "button" }
submit { selector: "form" }
```

**After collapsing (Rule 3):**
```json
{ "type": "click", "selector": "button:has-text('Add Patient')", "text": "Add Patient" }
```

Submit event is dropped — it's a side-effect of the button click.

### Tab / Accordion / Expandable

```
click  { selector: "button:has-text('Configurations')", tag: "button" }
```

**After collapsing:**
```json
{ "type": "click", "selector": "button:has-text('Configurations')", "text": "Configurations" }
```

Same as any button click. The verify check captures the outcome (e.g., new elements becoming visible).

### Hover (future enhancement)

Currently the tracker does NOT capture hover events. To add:
- Track `mouseenter` on elements with `:hover` CSS rules or `title` attributes
- Store as `{ "type": "hover", "selector": "..." }`
- Replay: `page.hover(selector)`

### Keyboard Shortcuts (future enhancement)

Currently not captured. To add:
- Track `keydown` events that aren't in input fields
- Store as `{ "type": "press", "key": "Escape" }` or `{ "type": "press", "key": "Control+S" }`
- Replay: `page.keyboard.press("Escape")`

---

## 3c. Multiple Health Checks in One Recording Session

A single learn session produces **one health checkpoint per [Enter] press**. You don't need separate sessions per page.

### Example: Recording health for 10 pages in one session

```
Status: Watching...

  Navigate to dashboard
[Enter]
  HEALTH: dashboard — landmark: h1 "Analytics Dashboard"   ← health check 1

  Navigate to call logs
[Enter]
  HEALTH: call_logs — landmark: h1 "Call Logs"              ← health check 2

  Navigate to reports
[Enter]
  HEALTH: reports — landmark: h1 "Reports"                  ← health check 3

  Navigate to voicemails
[Enter]
  HEALTH: voicemails — landmark: h1 "Voicemails"            ← health check 4

  Navigate to appointments
[Enter]
  HEALTH: appointments_v2 — landmark: h1 "Appointments"     ← health check 5

  Navigate to notifications
[Enter]
  HEALTH: notifications — landmark: h1 "Notifications"      ← health check 6

  Navigate to system health
[Enter]
  HEALTH: system_health — landmark: h1 "System Health"      ← health check 7

  Navigate to practice details
[Enter]
  HEALTH: practice_details — landmark: h1 "Practice Details" ← health check 8

  Navigate to providers
[Enter]
  HEALTH: providers — landmark: h1 "Providers"              ← health check 9

  Navigate to appointment types
[Enter]
  HEALTH: appointment_types — landmark: h1 "Appointment Types" ← health check 10

[d]

  Session complete.
  Health checks recorded: 10 features updated
  Model saved: QA_FEATURE_MODEL.json
```

Each `[Enter]` outside a flow (`[r]`...`[f]`) adds/updates the `health` block for that feature in the model.

### Mixing health checks and E2E flows in one session

You can record standalone health checks AND flows in the same session:

```
  Navigate to dashboard
[Enter]                          ← health check (standalone)
  HEALTH: dashboard

  Navigate to reports
[Enter]                          ← health check (standalone)
  HEALTH: reports

[r]                              ← START E2E FLOW
  Navigate to call logs
[Enter]                          ← flow step 1 + health check
  Step 1: call_logs.view

  Click filter button
  Select "Last 7 days"
[Enter]                          ← flow step 2 (no health — same page action)
  Step 2: call_logs.filter

  Click a call log row
  Dialog opens
[Enter]                          ← flow step 3 (no health — dialog interaction)
  Step 3: call_logs.view_detail

[f]                              ← FINISH FLOW
  Name: call_logs_filter_and_view
  Tags: regression

  Navigate to voicemails
[Enter]                          ← health check (standalone)
  HEALTH: voicemails

[d]                              ← DONE

  Session complete.
  Health checks: 4 features updated (dashboard, reports, call_logs, voicemails)
  Flows recorded: 1 (call_logs_filter_and_view, 3 steps)
```

### When does a step also record health?

| Situation | Records Health? | Records E2E Step? |
|-----------|:-:|:-:|
| `[Enter]` outside any flow | Yes | No |
| `[Enter]` inside flow, URL changed from previous step | Yes | Yes |
| `[Enter]` inside flow, same page action (filter, dialog, etc.) | No | Yes |

**Rule:** If the step caused a page navigation (URL pathname changed), it also captures health data for that page. Same-page interactions (filtering, opening dialogs, toggling) only record the E2E step.

---

## 4. Recording Workflow — Learn Mode V2

### New interactive commands

```
Commands:
  [r]      Start recording a new E2E flow
  [Enter]  Record this interaction as a step
  [n]      Name/label the current step
  [v]      Add a custom verify check to the last step
  [e]      Mark as edge case for the last step
  [s]      Skip — discard pending interactions
  [f]      Finish current flow (name it, tag it)
  [d]      Done — finish session, save everything
```

### Recording session example

```
Status: Watching... (press [r] to start recording, [d] to finish)

  You clicked: input [aria-label="Email Address"]
  You typed: "john@mail.com" in Enter your email
  You typed: (password) in Enter your password
  You clicked: button "Log In"
  Navigation: /home/call-logs

[r]  ← START RECORDING FLOW
  Recording started. Each [Enter] = one step in this flow.

[Enter]  ← RECORD STEP 1
  Step 1 RECORDED: authentication.login
    Route: /auth/sign-in → /home/call-logs
    Landmark: h1 "Call Logs"
    Actions: fill email, fill password, click "Log In"
    Verify: url_is(/home/call-logs), no_js_errors
    Health: page_alive, page_identity(/home/call-logs, h1 "Call Logs")

  You clicked: a "Analytics"
  Navigation: /home/dashboard

[Enter]  ← RECORD STEP 2
  Step 2 RECORDED: dashboard.view
    Route: /home/dashboard
    Landmark: h1 "Analytics Dashboard"
    Actions: click "Analytics"
    Verify: url_is(/home/dashboard), no_js_errors
    Health: page_alive, page_identity(/home/dashboard, h1 "Analytics Dashboard")

  You clicked: button "Date Range"
  You clicked: button "Last 30 Days"

[v]  ← ADD CUSTOM VERIFY CHECK
  What to verify?
    1. Text is visible on page
    2. Text is NOT visible
    3. Element exists (by selector)
    4. Element is gone
    5. URL is (exact path)
  Select [1-5]: 1
  Enter text to check for: Last 30 Days
  Added: text_visible("Last 30 Days")

[Enter]  ← RECORD STEP 3
  Step 3 RECORDED: dashboard.filter_date_range
    Route: /home/dashboard
    Actions: click "Date Range", click "Last 30 Days"
    Verify: text_visible("Last 30 Days"), no_js_errors

  You clicked: a "Reports"
  Navigation: /home/reports

[Enter]  ← RECORD STEP 4
  Step 4 RECORDED: reports.view
    Route: /home/reports
    Landmark: h1 "Reports"
    Actions: click "Reports"
    Verify: url_is(/home/reports), no_js_errors
    Health: page_alive, page_identity(/home/reports, h1 "Reports")

[f]  ← FINISH FLOW
  Name this flow (or Enter to auto-name): smoke_dashboard_reports
  Tags (comma-separated, or Enter to skip): smoke,daily

  Flow saved: smoke_dashboard_reports
    4 steps | tags: smoke, daily
    Routes: /auth/sign-in → /home/call-logs → /home/dashboard → /home/reports
```

### What each `[Enter]` captures

For both health check AND E2E replay:

| Data | Used by Health Check | Used by E2E Replay |
|------|:-------------------:|:-----------------:|
| Route (URL pathname) | Yes | Yes |
| Landmark (heading/unique element) | Yes | — |
| Page alive checks | Yes | Yes |
| No JS errors | Yes | Yes |
| Collapsed actions (fill, click, etc.) | — | Yes |
| Functional verify checks | — | Yes |
| Before/after screenshots | — | Yes |

### Steps outside a flow

If you press `[Enter]` without first pressing `[r]`, the step is recorded as a **standalone health checkpoint** — it updates the feature model (as today) but is NOT part of any E2E flow. This preserves backward compatibility.

```
  You clicked: a "Voicemails"
  Navigation: /home/voicemails

[Enter]  ← NOT IN A FLOW — health checkpoint only
  RECORDED: voicemails.view (health check only)
    Landmark: h1 "Voicemails"
    Health: page_alive, page_identity(/home/voicemails, h1 "Voicemails")
```

---

## 5. Health Check Runner — `run-test.js` V2

### What changes

Replace unreliable element-counting checks with Tier 1 + Tier 2 checks.

**Current behavior (V1):**
```
goto(/home/dashboard)
check: element_count_changed("tbody tr")     ← unreliable
check: element_appeared("table")             ← unreliable
check: element_count_changed("button:visible") ← unreliable
```

**New behavior (V2):**
```
goto(/home/dashboard)
check: page_alive                             ← reliable
check: page_identity("/home/dashboard", h1 "Analytics Dashboard")  ← reliable
check: no_js_errors                           ← reliable
```

### Feature model V2 schema changes

```json
{
  "features": {
    "dashboard": {
      "description": "Analytics dashboard page",
      "route": "/home/dashboard",
      "health": {
        "landmark": "h1",
        "landmarkText": "Analytics Dashboard",
        "expectedTitle": "Rondah - Dashboard"
      },
      "capabilities": {
        "view": {
          "interaction": "click a \"Analytics\"",
          "verify": {
            "url_is": { "type": "url_is", "value": "/home/dashboard" },
            "no_errors": { "type": "no_js_errors" }
          },
          "_confidence": "observed_2x",
          "_observed": 2
        }
      }
    }
  }
}
```

New `health` block per feature:
- `landmark` — CSS selector for the unique page identifier
- `landmarkText` — expected text content of the landmark (optional but recommended)
- `expectedTitle` — expected `document.title` (optional)

### Health check execution

```
For each feature in model:
  1. goto(feature.route)
  2. TIER 1 — Page Alive:
     - page.readyState === "complete"
     - No pageerror events fired
     - document.title is not empty / "Error" / "404"
  3. TIER 2 — Right Page:
     - URL pathname === feature.route
     - page.locator(feature.health.landmark) exists
     - If landmarkText: element text matches
  4. TIER 2b — No JS Errors:
     - Zero console errors since navigation
  5. Screenshot
  6. PASS/FAIL
```

### Backward compatibility

If the model has no `health` block (old format), fall back to current behavior (element counting). This way existing models still work, they just get the less reliable checks.

---

## 6. E2E Replay Runner — `run-e2e.js`

### Execution model

```
For each flow in QA_RECORDED_FLOWS.json (or filtered by --flow/--tag):
  For each step in flow.steps:
    1. Execute actions sequentially:
       - fill  → page.fill(selector, resolveVariable(value))
       - click → page.click(resolveSelector(action))
       - select → page.selectOption(selector, value)
       - hover → page.hover(selector)
       - press → page.press(selector, key)
       - waitForURL → page.waitForURL(path)
       - waitForSelector → page.waitForSelector(selector)

    2. Wait for page to settle:
       - If step has navigation → waitForURL + networkidle
       - Otherwise → short delay (500ms) for DOM updates

    3. Run verify checks:
       - url_is          → compare pathname
       - text_visible    → page.locator(`text=${value}`).isVisible()
       - text_not_visible → !(above)
       - element_exists  → page.locator(selector).count() > 0
       - element_gone    → page.locator(selector).count() === 0
       - toast_contains  → find toast element, check textContent includes value
       - no_js_errors    → consoleErrors.length === 0
       - input_has_value → page.inputValue(selector) === value

    4. Capture screenshot (pass or fail)

    5. On failure:
       - Try selector fallbacks (see Section 9)
       - If still fails: mark step failed, capture error screenshot
       - Option: --stop-on-fail to abort flow, or continue remaining steps
```

### Step result structure

```json
{
  "step": "step-2",
  "capability": "dashboard.view",
  "route": "/home/dashboard",
  "status": "passed",
  "actionsExecuted": 1,
  "checksRun": 2,
  "checksPassed": 2,
  "checksFailed": 0,
  "checks": [
    { "type": "url_is", "expected": "/home/dashboard", "actual": "/home/dashboard", "passed": true },
    { "type": "no_js_errors", "errorCount": 0, "passed": true }
  ],
  "duration": 1250,
  "screenshot": "screenshots/dashboard_view.png"
}
```

### Flow result structure

```json
{
  "flow": "smoke_dashboard_reports",
  "status": "passed",
  "stepsTotal": 4,
  "stepsPassed": 4,
  "stepsFailed": 0,
  "duration": 8500,
  "steps": [ /* step results */ ]
}
```

---

## 7. Data Model — What Gets Stored

### QA_RECORDED_FLOWS.json (new)

```json
{
  "version": "1.0",
  "meta": {
    "created_at": "2026-03-16T...",
    "last_updated": "2026-03-16T...",
    "session_count": 2,
    "flow_count": 3
  },
  "flows": {
    "smoke_dashboard_reports": {
      "name": "Smoke: Dashboard and Reports",
      "description": "Login, check dashboard, check reports",
      "tags": ["smoke", "daily"],
      "recorded_session": 2,
      "recorded_at": "2026-03-16T...",
      "steps": [
        {
          "id": "step-1",
          "name": "Login",
          "capability": "authentication.login",
          "routeBefore": "/auth/sign-in",
          "routeAfter": "/home/call-logs",
          "actions": [
            {
              "type": "fill",
              "selector": "input[aria-label='Email Address']",
              "selectorFallbacks": ["input[type='email']", "#email"],
              "value": "$EMAIL",
              "field": "Email Address"
            },
            {
              "type": "fill",
              "selector": "input[aria-label='Password']",
              "selectorFallbacks": ["input[type='password']", "#password"],
              "value": "$PASSWORD",
              "field": "Password"
            },
            {
              "type": "click",
              "selector": "button:has-text('Log In')",
              "selectorFallbacks": ["button[type='submit']"],
              "text": "Log In"
            },
            {
              "type": "waitForURL",
              "value": "/home/call-logs"
            }
          ],
          "verify": [
            { "type": "url_is", "value": "/home/call-logs" },
            { "type": "no_js_errors" }
          ]
        },
        {
          "id": "step-2",
          "name": "Navigate to Dashboard",
          "capability": "dashboard.view",
          "routeBefore": "/home/call-logs",
          "routeAfter": "/home/dashboard",
          "actions": [
            {
              "type": "click",
              "selector": "a:has-text('Analytics')",
              "selectorFallbacks": ["a[href='/home/dashboard']"],
              "text": "Analytics"
            },
            {
              "type": "waitForURL",
              "value": "/home/dashboard"
            }
          ],
          "verify": [
            { "type": "url_is", "value": "/home/dashboard" },
            { "type": "text_visible", "value": "Analytics Dashboard" },
            { "type": "no_js_errors" }
          ]
        },
        {
          "id": "step-3",
          "name": "Filter date range",
          "capability": "dashboard.filter_date_range",
          "routeBefore": "/home/dashboard",
          "routeAfter": "/home/dashboard",
          "actions": [
            {
              "type": "click",
              "selector": "button:has-text('Date Range')",
              "text": "Date Range"
            },
            {
              "type": "click",
              "selector": "button:has-text('Last 30 Days')",
              "text": "Last 30 Days"
            }
          ],
          "verify": [
            { "type": "text_visible", "value": "Last 30 Days" },
            { "type": "no_js_errors" }
          ]
        },
        {
          "id": "step-4",
          "name": "Navigate to Reports",
          "capability": "reports.view",
          "routeBefore": "/home/dashboard",
          "routeAfter": "/home/reports",
          "actions": [
            {
              "type": "click",
              "selector": "a:has-text('Reports')",
              "selectorFallbacks": ["a[href='/home/reports']"],
              "text": "Reports"
            },
            {
              "type": "waitForURL",
              "value": "/home/reports"
            }
          ],
          "verify": [
            { "type": "url_is", "value": "/home/reports" },
            { "type": "text_visible", "value": "Reports" },
            { "type": "no_js_errors" }
          ]
        }
      ]
    }
  }
}
```

### QA_FEATURE_MODEL.json V2 (enhanced)

Added `health` block per feature. Everything else stays the same.

```json
{
  "features": {
    "dashboard": {
      "description": "Analytics dashboard page",
      "route": "/home/dashboard",
      "health": {
        "landmark": "h1",
        "landmarkText": "Analytics Dashboard",
        "expectedTitle": "Rondah - Dashboard"
      },
      "capabilities": { }
    }
  }
}
```

### Relationship between the two files

```
QA_FEATURE_MODEL.json                QA_RECORDED_FLOWS.json
┌──────────────────────┐             ┌──────────────────────┐
│ features:            │             │ flows:               │
│   dashboard:         │             │   smoke_test:        │
│     route            │◄────────────│     step-2.capability│
│     health.landmark  │             │     step-2.verify    │
│     capabilities     │             │     step-2.actions   │
│   reports:           │             │     step-3.capability│
│     route            │◄────────────│     step-3.verify    │
│     health.landmark  │             │     step-3.actions   │
└──────────────────────┘             └──────────────────────┘
         │                                     │
    run-test.js                           run-e2e.js
 "Is each page OK?"               "Do workflows work?"
```

They reference each other via `capability` names (e.g., `dashboard.view`) but either can work alone.

---

## 8. Event Collapsing Rules

Raw events from learn are noisy. These rules clean them into replayable actions:

### Rule 1: Collapse Sequential Inputs → Single Fill

```
input { selector: "#email", value: "j" }
input { selector: "#email", value: "jo" }
input { selector: "#email", value: "john@mail.com" }
```
→
```json
{ "type": "fill", "selector": "#email", "value": "john@mail.com" }
```

Keep only the **last** input event per selector in a consecutive sequence.

### Rule 2: Remove Click-Before-Fill

```
click { selector: "input#email" }
input { selector: "#email", value: "john@mail.com" }
```
→
```json
{ "type": "fill", "selector": "#email", "value": "john@mail.com" }
```

Playwright `fill()` auto-focuses. The click is redundant.

### Rule 3: Remove Submit After Button Click

```
click { selector: "button:has-text('Log In')" }
submit { selector: "form" }
```
→
```json
{ "type": "click", "selector": "button:has-text('Log In')" }
```

Form submission is a side-effect of clicking the submit button.

### Rule 4: Convert Navigation to WaitForURL

```
navigation { url: "http://localhost:3000/home/dashboard" }
```
→
```json
{ "type": "waitForURL", "value": "/home/dashboard" }
```

Not an action to execute — a condition to wait for.

### Rule 5: Prefer Text-Based Selectors

```
click { selector: "a.nav-link.px-3.py-2.text-sm", text: "Analytics", tag: "a" }
```
→
```json
{
  "type": "click",
  "selector": "a:has-text('Analytics')",
  "selectorFallbacks": ["a.nav-link.px-3.py-2.text-sm", "a[href='/home/dashboard']"],
  "text": "Analytics"
}
```

Text selectors survive CSS class refactors. Store the original CSS selector as a fallback.

### Rule 6: Parameterize Credentials

- `fill` on a field containing "email"/"username" where value matches `--email` → `$EMAIL`
- `fill` on any password field → `$PASSWORD`
- Other input values → stored literally

### Rule 7: Generate Selector Fallbacks

For every action, store an ordered list of fallback selectors:

```
Priority:
  1. data-testid        → [data-testid="login-btn"]
  2. aria-label         → [aria-label="Submit"]
  3. text + tag         → button:has-text("Log In")
  4. id                 → #submit-btn
  5. role + text        → [role="button"]:has-text("Log In")
  6. href (for links)   → a[href="/home/dashboard"]
  7. Original CSS path  → button.px-4.py-2.bg-blue-500
```

During recording, capture all available identifiers for each element. Primary selector = most stable one. Fallbacks = the rest in priority order.

---

## 9. Selector Resilience

### During replay: fallback chain

```
Try primary selector (timeout: 3s)
  ↓ fail
Try fallback[0] (timeout: 2s)
  ↓ fail
Try fallback[1] (timeout: 2s)
  ↓ fail
Try text= selector from action.text (timeout: 2s)
  ↓ fail
Mark step as SELECTOR_BROKEN
```

### Selector health tracking

After each E2E run, record which selector succeeded per action:

```json
{
  "type": "click",
  "selector": "button:has-text('Log In')",
  "selectorFallbacks": ["button[type='submit']"],
  "_lastUsedSelector": "button:has-text('Log In')",
  "_selectorHealth": "stable"
}
```

`_selectorHealth` values:
- `stable` — primary selector works
- `fallback_used` — primary failed, fallback worked (warning: consider updating primary)
- `broken` — all selectors failed

### Auto-healing (Phase 4, future)

When a fallback succeeds:
1. Promote it to primary
2. Log the change
3. Save updated `QA_RECORDED_FLOWS.json`
4. Report: `"Selector healed: button.old-class → button:has-text('Submit')"`

---

## 10. CLI Interface

### learn.js V2 — Recording

```bash
# Record health checks + E2E flows
node scripts/learn.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD

# Health checks only (no flow recording, current behavior)
node scripts/learn.js --url $URL --no-flows

# Custom output paths
node scripts/learn.js --url $URL \
  --model ./QA_FEATURE_MODEL.json \
  --flows-out ./QA_RECORDED_FLOWS.json

# Resume crashed session
node scripts/learn.js --url $URL --resume

# View session history
node scripts/learn.js --history
```

### run-test.js V2 — Health Check

```bash
# Health check all features
node scripts/run-test.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD

# Health check specific features
node scripts/run-test.js \
  --url http://localhost:3000 \
  --features dashboard,reports

# Output
#   [1/15] dashboard — PASS (page_alive, page_identity, no_js_errors)
#   [2/15] reports — PASS (page_alive, page_identity, no_js_errors)
#   [3/15] voicemails — FAIL (page_identity: h1 "Voicemails" not found)
```

### run-e2e.js — E2E Replay

```bash
# Run all flows
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD

# Run specific flow
node scripts/run-e2e.js --url $URL --flow smoke_dashboard_reports

# Run flows by tag
node scripts/run-e2e.js --url $URL --tag smoke

# Watch mode
node scripts/run-e2e.js --url $URL --no-headless

# Stop on first failure
node scripts/run-e2e.js --url $URL --stop-on-fail

# Custom flows file
node scripts/run-e2e.js --url $URL --flows ./QA_RECORDED_FLOWS.json

# Output
#   Flow: smoke_dashboard_reports (4 steps)
#     Step 1: Login — PASS (2/2 checks)
#     Step 2: Navigate to Dashboard — PASS (3/3 checks)
#     Step 3: Filter date range — PASS (2/2 checks)
#     Step 4: Navigate to Reports — PASS (3/3 checks)
#   Result: 4/4 steps passed (8.5s)
```

### Combined pipeline

```bash
# CI pipeline: health first, then E2E
node scripts/run-test.js --url $URL --email $EMAIL --password $PASS \
  && node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --tag smoke
```

---

## 11. Architecture Diagram

```
                        ┌─────────────────────────┐
                        │       learn.js V2        │
                        │                          │
                        │  [r] start flow           │
                        │  [Enter] record step     │
                        │  [v] add verify check    │
                        │  [f] finish flow         │
                        │  [d] done                │
                        └─────┬──────────┬─────────┘
                              │          │
                   ┌──────────┘          └──────────┐
                   ▼                                ▼
        QA_FEATURE_MODEL.json            QA_RECORDED_FLOWS.json
        ┌──────────────────┐             ┌──────────────────────┐
        │ Per-feature:     │             │ Per-flow:            │
        │  route           │             │  name, tags          │
        │  health:         │             │  steps[]:            │
        │    landmark      │             │    actions[]         │
        │    landmarkText  │             │    verify[]          │
        │  capabilities    │             │    selectorFallbacks │
        └────────┬─────────┘             └──────────┬───────────┘
                 │                                  │
                 ▼                                  ▼
          run-test.js V2                      run-e2e.js
        ┌──────────────────┐             ┌──────────────────────┐
        │ For each feature:│             │ For each flow:       │
        │  1. goto(route)  │             │  For each step:      │
        │  2. page_alive   │             │   1. execute actions │
        │  3. page_identity│             │   2. wait for settle │
        │  4. no_js_errors │             │   3. run verify      │
        │  5. screenshot   │             │   4. screenshot      │
        └────────┬─────────┘             └──────────┬───────────┘
                 │                                  │
                 ▼                                  ▼
          qa-results/                         qa-results/
          health-report.html                  e2e-report.html
          health-summary.json                 e2e-summary.json
          screenshots/                        screenshots/

                    ┌──────────────────────┐
                    │   CI/CD Pipeline     │
                    │                      │
                    │  1. Health Check      │
                    │     ↓ pass?          │
                    │  2. E2E Replay       │
                    │     ↓ pass?          │
                    │  3. Deploy / Merge   │
                    └──────────────────────┘
```

---

## 12. Current Implementation Status

This section maps every feature in this plan against what already exists in the codebase.

### Files involved

| File | Status | Description |
|------|--------|-------------|
| `scripts/learn.js` | **EXISTS** | Interactive learn mode with event capture |
| `scripts/run-test.js` | **EXISTS** | Health check runner (V1 — element counting) |
| `scripts/run-e2e.js` | **NEEDS BUILDING** | E2E replay runner |
| `scripts/init.js` | **EXISTS** | Model generation from live scan |
| `scripts/migrate.js` | **EXISTS** | Legacy flows → feature model converter |
| `QA_FEATURE_MODEL.json` | **EXISTS** | Feature model (no `health` block yet) |
| `QA_RECORDED_FLOWS.json` | **NEEDS BUILDING** | Recorded E2E flows |
| `QA_INSTRUCTIONS.json` | **EXISTS** | Agent config (timeouts, exclusions) |

### learn.js — Command Status

| Command | Plan Description | Current Status | What Needs to Change |
|---------|-----------------|----------------|---------------------|
| `Enter` | Record step — health checkpoint (standalone) or E2E step (in flow) | **PARTIAL** — Records capability observation with inferred element-counting checks. No landmark capture, no health block, no flow context awareness. | Add landmark capture (`h1`, `h2`, `title`, `data-testid`). Write `health` block to model. Behavior must branch: outside flow → health only, inside flow → collapsed actions + verify + health if URL changed. |
| `n` | Name/label current step | **IMPLEMENTED** — Prompts or accepts inline name, stores as `userLabel` on last observation. | No change needed. Works for both health and flow steps. |
| `e` | Mark as edge case | **IMPLEMENTED** — Records observation with `isEdgeCase: true` and `edgeCaseOf` pointing to last capability. | No change needed. |
| `s` | Skip pending interactions | **IMPLEMENTED** — Clears `pendingEvents`, increments skip counter, resets snapshot. | No change needed. |
| `d` | Done — merge + save + exit | **PARTIAL** — Merges observations into `QA_FEATURE_MODEL.json`, saves session history, prints summary. | Also write `QA_RECORDED_FLOWS.json` if any flows were recorded during session. Add flow summary to output. |
| `r` | Start recording E2E flow | **NOT IMPLEMENTED** | New command. Set `recordingFlow = true`, initialize empty flow steps array, print "Recording started." |
| `f` | Finish current flow — name + tag | **NOT IMPLEMENTED** | New command. Prompt for flow name and tags. Finalize flow object. Set `recordingFlow = false`. |
| `v` | Add custom verify check | **NOT IMPLEMENTED** | New command. Prompt with menu (text_visible, text_not_visible, element_exists, element_gone, url_is). Attach check to last recorded step. |

### learn.js — Infrastructure Status

| Feature | Current Status | What Needs to Change |
|---------|----------------|---------------------|
| Event tracker (`window.__qaTracker`) | **IMPLEMENTED** — Captures click, input, submit, navigation events with selector, text, tag, value, field. Selector priority: data-testid > id > aria-label > text > CSS path. | No change to tracker itself. |
| Event polling (500ms) | **IMPLEMENTED** — Polls `window.__qaTracker.flush()` every 500ms, pushes to `pendingEvents`. | No change needed. |
| State capture (`captureState`) | **PARTIAL** — Captures `elementCounts` for MONITORED_SELECTORS + `visibleTexts` via TreeWalker + `consoleErrorCount`. | Add landmark capture: `h1` text, `h2` text, `document.title`, `data-testid`/`data-page` attributes. Add error alert detection. |
| State diff (`computeDiff`) | **IMPLEMENTED** — Compares URLs, element counts, visible texts, console errors. | No change needed (still used internally), but inferred checks should shift from count-based to presence/identity-based. |
| Inferred checks (`inferChecks`) | **IMPLEMENTED** — Infers `url_changed`, `element_appeared`, `element_disappeared`, `element_count_changed`, `toast_appeared`, `no_errors`. | Replace with new check types: `url_is` (not just "changed"), `text_visible`, `toast_contains` (with actual text), `no_js_errors`, `no_console_errors`. Drop count-based checks. |
| Event collapsing | **NOT IMPLEMENTED** — Raw events stored as-is. Every keystroke recorded separately. | Build 7 collapsing rules: sequential input → final fill, remove click-before-fill, remove submit-after-click, navigation → waitForURL, prefer text selectors, parameterize credentials, generate fallback selectors. |
| Selector fallback capture | **NOT IMPLEMENTED** — Only one selector per event. | During recording, capture all available identifiers (data-testid, aria-label, text, id, CSS) per element. Store primary + fallbacks array. |
| Merge into model | **IMPLEMENTED** — `mergeIntoModel()` upgrades capabilities, adds new ones, handles edge cases, progresses confidence. | Add `health` block writing per feature during merge. |
| Flow persistence | **NOT IMPLEMENTED** | Write `QA_RECORDED_FLOWS.json` on session finish. |
| Auto-save (30s) | **IMPLEMENTED** | Extend to also save in-progress flow state. |
| `--resume` | **IMPLEMENTED** | Extend to restore in-progress flow. |
| `--history` | **IMPLEMENTED** | No change needed. |

### run-test.js — Status

| Feature | Current Status | What Needs to Change |
|---------|----------------|---------------------|
| Navigate to each route | **IMPLEMENTED** | No change. |
| Authentication | **IMPLEMENTED** — Tries common login selectors. | No change. |
| Verify checks | **IMPLEMENTED (V1)** — Runs `url_changed`, `element_appeared`, `element_disappeared`, `element_count_changed`, `no_errors`, `toast_appeared` by comparing before/after element counts. | **Replace with V2 checks:** `page_alive` (readyState, title, no crash), `page_identity` (landmark exists, text matches), `no_js_errors`, `no_console_errors`, `no_error_alerts`. |
| Backward compat | N/A | If feature has `health` block → use V2 checks. If no `health` block → fall back to V1 element counting. |
| HTML report | **IMPLEMENTED** | Update to show V2 check types. |
| Screenshot per capability | **IMPLEMENTED** | No change. |
| `--suite smoke/full` | **IMPLEMENTED** | No change. |
| `--features` filter | **IMPLEMENTED** | No change. |
| `--no-headless` | **IMPLEMENTED** | No change. |

### run-e2e.js — Status

**Entirely new file. Nothing exists yet.**

### QA_FEATURE_MODEL.json — Schema Status

| Field | Current Status | What Needs to Change |
|-------|----------------|---------------------|
| `features.{name}.route` | **EXISTS** | No change. |
| `features.{name}.description` | **EXISTS** | No change. |
| `features.{name}.requires` | **EXISTS** | No change. |
| `features.{name}.capabilities` | **EXISTS** | No change. |
| `features.{name}.health` | **NOT EXISTS** | Add `health` block with `landmark`, `landmarkText`, `expectedTitle`. |
| `capabilities.{name}.verify` | **EXISTS** — Uses element counting types. | Migrate to new check types over time. Old format still works (backward compat). |
| `capabilities.{name}._confidence` | **EXISTS** | No change. |
| `capabilities.{name}._observed` | **EXISTS** | No change. |
| `shared.authenticated` | **EXISTS** | No change. |
| `meta` | **EXISTS** | No change. |

### Summary: Build Order

```
Step 1: Landmark capture in learn.js captureState()
        + health block writing in mergeIntoModel()
        + V2 checks in run-test.js
        → Reliable health checks working

Step 2: [r], [f], [v] commands in learn.js
        + Event collapsing engine
        + Selector fallback capture
        + QA_RECORDED_FLOWS.json output in [d] handler
        → Flow recording working

Step 3: run-e2e.js (new file)
        + Action executor + verify executor
        + Selector fallback chain
        + HTML report
        → E2E replay working
```

Steps 1 and 2 can be built in parallel. Step 3 depends on Step 2.

---

## 13. Implementation Phases

### Dependency Map

```
Phase 1A ──────┐
(landmarks)    │
               ├──→ Phase 1C (health runner V2)
Phase 1B ──────┘
(infer checks)

Phase 2A ──────┐
(flow state)   │
               ├──→ Phase 2C (flow persistence) ──→ Phase 3 (E2E runner)
Phase 2B ──────┘                                          │
(event collapse)                                          ├──→ Phase 4 (auto-heal)
                                                          └──→ Phase 5 (composition)
```

Phases 1 and 2 can be built in parallel. Phase 3 depends on 2C.

---

### Phase 1A: Landmark Capture in Learn

**Goal:** During recording, capture page identity data (headings, title, unique elements) for each page visited.

**Files:** `learn.js` (both opencode + opencode-dev)

| Task | What to do | Details |
|------|-----------|---------|
| 1A.1 | Extend `captureState()` function | Add landmark capture alongside existing element counts. Run `page.evaluate()` to extract: `document.title`, first `h1` textContent, first `h2` textContent, all `[data-testid]` values, all `[data-page]` values, active nav link text (`nav a.active` or `nav a[aria-current]`). |
| 1A.2 | Add `landmarks` field to state object | Return `{ ...existingState, landmarks: { title, h1, h2, dataTestIds[], dataPages[], activeNav } }` from `captureState()`. |
| 1A.3 | Pick best landmark automatically | Write `pickLandmark(landmarks)` function. Priority: `data-page` > `data-testid` > `h1` with text > `h2` with text > `title`. Returns `{ selector: string, text: string }`. |

**Input:** Existing `captureState()` that returns elementCounts + visibleTexts.
**Output:** `captureState()` now also returns `landmarks` object.

**Test:** Run learn, press Enter on a page. Console should print the detected landmark:
```
HEALTH: dashboard — landmark: h1 "Analytics Dashboard"
```

---

### Phase 1B: New Inferred Check Types

**Goal:** Replace unreliable element-counting checks with presence/identity-based checks.

**Files:** `learn.js` (both repos)

| Task | What to do | Details |
|------|-----------|---------|
| 1B.1 | Write new `inferChecksV2()` function | Alongside existing `inferChecks()`. New function returns: `url_is` (if URL changed — with the actual new pathname), `no_js_errors` (always), `no_console_errors` (always), `toast_contains` (if toast appeared — extract its actual text via `page.locator('.toast, [data-sonner-toast], [role="alert"]').textContent()`), `element_exists` (if dialog opened — `[role='dialog']`), `element_gone` (if dialog closed). |
| 1B.2 | Add error alert detection | In `captureState()`, scan for visible error elements: `[role='alert']` containing "error"/"failed", `.error`, `.text-red-500`. Store count and text as `errorAlerts[]`. |
| 1B.3 | Switch `[Enter]` handler to use `inferChecksV2()` | When recording, call `inferChecksV2()` instead of `inferChecks()`. Keep `inferChecks()` as fallback (backward compat during transition). |

**Input:** Existing `inferChecks()` that returns element_appeared/disappeared/count_changed.
**Output:** `inferChecksV2()` returning url_is, no_js_errors, no_console_errors, toast_contains, element_exists/gone.

**Test:** Run learn, navigate between pages, press Enter. Should see:
```
+ url_is(/home/dashboard)
+ no_js_errors
+ no_console_errors
```
NOT:
```
+ element_count_changed (tbody tr): 0 → 5
```

---

### Phase 1C: Health Check Runner V2

**Goal:** `run-test.js` uses landmark-based checks instead of element counting.

**Files:** `run-test.js` (both repos), `learn.js` merge function

| Task | What to do | Details |
|------|-----------|---------|
| 1C.1 | Write `health` block during model merge | In `mergeIntoModel()` (inside learn.js), when processing an observation: if URL changed (new page), write `feature.health = { landmark, landmarkText, expectedTitle }` using the landmark from `captureState()`. |
| 1C.2 | Write `runHealthChecks()` in run-test.js | New function that runs: (1) `page_alive`: readyState === "complete", title not empty/"Error"/"404", no `pageerror` events; (2) `no_console_errors`: zero console.error calls (filter out patterns from QA_INSTRUCTIONS known_issues); (3) `no_error_alerts`: no visible error alert elements; (4) `page_identity`: `page.locator(health.landmark)` exists, textContent matches `health.landmarkText`. |
| 1C.3 | Replace check logic in run-test.js | For each feature: if `feature.health` exists → call `runHealthChecks()`. If no `health` block → fall back to existing V1 `runCheck()`/`runStaticCheck()`. |
| 1C.4 | Update HTML report | Show V2 check names (page_alive, page_identity, etc.) instead of element_appeared. |

**Input:** Feature model with no `health` block.
**Output:** After one learn session, model has `health` blocks. `run-test.js` uses them for reliable checks.

**Test:**
1. Run learn, visit 5 pages pressing Enter each time → `QA_FEATURE_MODEL.json` should have `health` block on each feature.
2. Run `run-test.js` → should show `page_alive`, `page_identity`, `no_console_errors` checks (not element counting).
3. Run `run-test.js` on old model (no health block) → should fall back to V1 checks without errors.

**Milestone: Phase 1 complete.** Health checks are reliable. You can run `learn` → `run-test.js` and get meaningful pass/fail results.

---

### Phase 2A: Flow Recording State Machine

**Goal:** Add `[r]`, `[f]` commands to learn.js. Track whether we're inside a flow or not.

**Files:** `learn.js` (both repos)

| Task | What to do | Details |
|------|-----------|---------|
| 2A.1 | Add flow state variables | `let recordingFlow = false`, `let currentFlowSteps = []`, `let currentFlowStartTime = null`, `let recordedFlows = []`. |
| 2A.2 | Implement `[r]` command handler | Set `recordingFlow = true`, `currentFlowSteps = []`, `currentFlowStartTime = Date.now()`. Print "Recording started. Each [Enter] = one step in this flow." Reject if already recording (`"Already recording a flow. Press [f] to finish it first."`). |
| 2A.3 | Implement `[f]` command handler | Reject if not recording. Prompt for flow name (`rl.question`), prompt for tags (comma-separated). Build flow object: `{ name, tags, steps: currentFlowSteps, recorded_session, recorded_at }`. Push to `recordedFlows[]`. Reset `recordingFlow = false`, `currentFlowSteps = []`. Print summary. |
| 2A.4 | Branch `[Enter]` behavior | If `recordingFlow === true`: record as flow step (push to `currentFlowSteps`). Also record health if URL changed. If `recordingFlow === false`: record as standalone health checkpoint only (current behavior, enhanced with landmarks from Phase 1A). |
| 2A.5 | Update `[d]` handler | After merging model, also write `recordedFlows` to `QA_RECORDED_FLOWS.json` (if any flows recorded). Print flow summary alongside model summary. |
| 2A.6 | Update header/help text | Show all 8 commands: `[r]`, `[Enter]`, `[n]`, `[v]`, `[e]`, `[s]`, `[f]`, `[d]`. Update status line: "press [r] to start recording, [Enter] for health check, [d] to finish". |
| 2A.7 | Guard invalid command sequences | `[f]` without `[r]` → error. `[r]` while already recording → error. `[d]` while recording → ask to finish flow first or auto-finish. `[e]` inside flow → mark last step as edge case variant. |

**Input:** learn.js with 5 commands (Enter, n, e, s, d).
**Output:** learn.js with 8 commands (r, Enter, n, v, e, s, f, d). Flow state tracked.

**Test:** Run learn. Press `[r]`, do some actions, press Enter 3 times, press `[f]`, name the flow. Should print "Flow saved: X (3 steps)". Press `[d]`. Should see "Flows recorded: 1" in summary.

---

### Phase 2B: Event Collapsing Engine

**Goal:** Transform raw keystroke-level events into clean, replayable actions.

**Files:** `learn.js` (both repos) — new function `collapseEvents(events, config)`

| Task | What to do | Details |
|------|-----------|---------|
| 2B.1 | Write `collapseEvents()` function | Takes raw `TrackedEvent[]`, returns `CollapsedAction[]`. This is a pure function — no side effects, easy to unit test. |
| 2B.2 | Implement Rule 1: Collapse sequential inputs | Group consecutive `input` events on same selector. Keep only the last one. Convert to `{ type: "fill", selector, value, field }`. |
| 2B.3 | Implement Rule 2: Remove click-before-fill | If `click` on an input element is followed by `input` on same/similar selector, remove the click. |
| 2B.4 | Implement Rule 3: Remove submit-after-click | If `submit` follows a `click` on a button, remove the submit. |
| 2B.5 | Implement Rule 4: Navigation → waitForURL | Convert `navigation` events to `{ type: "waitForURL", value: pathname }`. |
| 2B.6 | Implement Rule 5: Prefer text selectors | For `click` events: if `event.text` exists and `event.tag` is known (a, button), rewrite selector to `tag:has-text('text')`. Store original CSS selector as fallback. |
| 2B.7 | Implement Rule 6: Parameterize credentials | If `fill` field contains "email"/"username" and value matches `config.email` → replace with `$EMAIL`. Password fields → `$PASSWORD`. |
| 2B.8 | Implement Rule 7: Generate selector fallbacks | For each action, build `selectorFallbacks[]`: data-testid, aria-label, text+tag, id, href, original CSS. Primary = most stable. |
| 2B.9 | Call `collapseEvents()` in `[Enter]` handler | When recording a flow step, collapse `pendingEvents` before storing. Store collapsed actions in the step object. |

**Input:** Raw events like `[click input, input "j", input "jo", input "john@mail.com", click button "Log In", submit form, navigation /home]`.
**Output:** Collapsed actions: `[fill email=$EMAIL, click "Log In", waitForURL /home]`.

**Test:** Write unit tests for `collapseEvents()`:
- 15 keystroke events on email → 1 fill action
- click input + keystrokes → 1 fill (no click)
- click button + submit → 1 click (no submit)
- click `a.nav-link.px-3` with text "Reports" → `a:has-text('Reports')` with CSS fallback
- email matching config → `$EMAIL`
- password field → `$PASSWORD`

---

### Phase 2C: Flow Persistence + [v] Command

**Goal:** Save recorded flows to `QA_RECORDED_FLOWS.json`. Add manual verify check command.

**Files:** `learn.js` (both repos)

| Task | What to do | Details |
|------|-----------|---------|
| 2C.1 | Define flow step schema | Each step: `{ id, name, capability, routeBefore, routeAfter, actions: CollapsedAction[], verify: FunctionalCheck[], selectorFallbacks per action }`. |
| 2C.2 | Build step object in `[Enter]` handler | When inside flow: run `collapseEvents()` on pendingEvents, run `inferChecksV2()` for verify array, capture routeBefore/routeAfter, auto-name from capability match or route. Push to `currentFlowSteps`. |
| 2C.3 | Implement `[v]` command | Show menu: (1) text_visible, (2) text_not_visible, (3) element_exists, (4) element_gone, (5) url_is, (6) toast_contains, (7) element_attribute. Prompt for value/selector based on selection. Attach check to last recorded step's verify array. Must have at least one recorded step. |
| 2C.4 | Write `QA_RECORDED_FLOWS.json` in `[d]` handler | Build full flows file: `{ version, meta, flows: { [name]: flowObject } }`. Merge with existing file if present (append new flows, don't overwrite). |
| 2C.5 | Handle duplicate flow names | If flow name already exists in file, append `_2`, `_3` etc. Or prompt user to overwrite. |
| 2C.6 | Extend auto-save to include flow state | Auto-save every 30s should also save `recordingFlow`, `currentFlowSteps`, `recordedFlows` to session file. `--resume` should restore them. |

**Input:** Phase 2A (flow state) + Phase 2B (collapsed events).
**Output:** `QA_RECORDED_FLOWS.json` written on session finish with properly structured flows.

**Test:**
1. Run learn. `[r]` → do login → `[Enter]` → navigate dashboard → `[Enter]` → `[v]` text_visible "Dashboard" → `[Enter]` → `[f]` name "test_flow" tags "smoke" → `[d]`.
2. Open `QA_RECORDED_FLOWS.json` — should have one flow with 3 steps, collapsed actions, verify checks, selector fallbacks.
3. Actions should be collapsed (no individual keystrokes), credentials parameterized.

**Milestone: Phase 2 complete.** Learn mode now records health checkpoints AND E2E flows. Both `QA_FEATURE_MODEL.json` and `QA_RECORDED_FLOWS.json` are produced.

---

### Phase 3A: E2E Runner — Core Action Executor

**Goal:** New `run-e2e.js` script that can read flows and execute actions.

**Files:** `scripts/run-e2e.js` (new file, both repos)

| Task | What to do | Details |
|------|-----------|---------|
| 3A.1 | Script scaffolding | CLI arg parsing (--url, --email, --password, --flows, --flow, --tag, --no-headless, --stop-on-fail, --timeout, --output-dir). Load `QA_RECORDED_FLOWS.json`. Filter flows by --flow or --tag. Launch Playwright browser. |
| 3A.2 | Variable resolver | `resolveValue(value, config)` — replaces `$EMAIL` → config.email, `$PASSWORD` → config.password. Future: custom variables via --var key=value. |
| 3A.3 | Selector resolver | `resolveSelector(action)` — tries primary selector with 3s timeout. On fail, iterates `selectorFallbacks` with 2s timeout each. On fail, tries `text=` selector from `action.text`. Returns working selector or throws. |
| 3A.4 | Action executor | `executeAction(page, action, config)` — switch on action.type: `fill` → `page.fill(selector, value)`, `click` → `page.click(selector)`, `select` → `page.selectOption(selector, value)`, `hover` → `page.hover(selector)`, `press` → `page.press(selector, key)`, `waitForURL` → `page.waitForURL('**' + value)`. |
| 3A.5 | Step executor | `executeStep(page, step, config)` — execute all actions in order, wait for page settle after (networkidle if URL changed, short delay otherwise). Return step result. |
| 3A.6 | Flow executor | `executeFlow(page, flow, config)` — fresh browser context per flow (clean cookies/state). Authenticate if first step is login. Execute each step. Collect results. Handle --stop-on-fail. |
| 3A.7 | Authentication | Same pattern as run-test.js — try common login selectors. Run before first step if flow doesn't start with explicit login. |

**Input:** `QA_RECORDED_FLOWS.json` from Phase 2C.
**Output:** Script that can execute recorded actions against a live app.

**Test:** Record a simple 2-step flow (login → navigate to dashboard). Run `node scripts/run-e2e.js --url http://localhost:3000 --email $EMAIL --password $PASS --flow test_flow`. Should see actions executing and navigating.

---

### Phase 3B: E2E Runner — Verify Checks

**Goal:** After each step's actions, run the verify checks and report pass/fail.

**Files:** `scripts/run-e2e.js`

| Task | What to do | Details |
|------|-----------|---------|
| 3B.1 | Write `runVerifyCheck(page, check)` | Switch on check.type: `url_is` → `new URL(page.url()).pathname === check.value`, `text_visible` → `page.locator(\`text=${check.value}\`).isVisible()`, `text_not_visible` → opposite, `element_exists` → `page.locator(check.selector).count() > 0`, `element_gone` → count === 0, `toast_contains` → find toast element and check textContent.includes(check.value), `no_js_errors` → captured pageerror count === 0, `no_console_errors` → captured console.error count === 0, `element_attribute` → `page.getAttribute(selector, attribute) === value`, `input_has_value` → `page.inputValue(selector) === value`, `option_selected` → check selected option text. |
| 3B.2 | Integrate into step executor | After executing actions + waiting, run all checks in `step.verify`. Collect results. Determine step pass/fail. |
| 3B.3 | Console error tracking | Track `console.error` and `pageerror` events per step (reset between steps). Pass count to verify checks. |
| 3B.4 | Screenshot per step | Capture screenshot after checks (pass or fail). Save to `output-dir/screenshots/`. On failure, capture full-page screenshot. |

**Input:** Step with verify array from Phase 2C.
**Output:** Per-step check results with pass/fail and detail messages.

**Test:** Run a flow that includes `text_visible("Analytics Dashboard")` check. Should PASS when on dashboard, FAIL when on wrong page.

---

### Phase 3C: E2E Runner — Reporting + Output

**Goal:** Generate summary JSON and HTML report, handle exit codes.

**Files:** `scripts/run-e2e.js`

| Task | What to do | Details |
|------|-----------|---------|
| 3C.1 | Build result data structure | Per-flow: `{ flow, status, stepsTotal, stepsPassed, stepsFailed, duration, steps[] }`. Per-step: `{ step, capability, route, status, actionsExecuted, checks[], duration, screenshot }`. |
| 3C.2 | Console output formatting | Print per-flow header, per-step results with check details, flow pass/fail summary. Final summary: flows run, passed, failed, total duration. |
| 3C.3 | Write `e2e-summary.json` | Full structured results to output dir. |
| 3C.4 | Generate `e2e-report.html` | Visual report showing each flow, each step, check results, screenshots. Similar style to existing run-test.js report. |
| 3C.5 | Exit codes | `process.exit(0)` if all flows pass, `process.exit(1)` if any fail. |

**Input:** All flow/step results from 3A + 3B.
**Output:** `qa-results/e2e-summary.json`, `qa-results/e2e-report.html`, screenshots.

**Test:** Run all flows. Open `qa-results/e2e-report.html` in browser. Should show each flow with steps, checks, screenshots.

**Milestone: Phase 3 complete.** Full E2E replay working. Record in learn → replay with run-e2e → get pass/fail report.

---

### Phase 4: Selector Auto-Healing (future)

**Goal:** When a primary selector breaks during replay, auto-fix it.

**Depends on:** Phase 3

| Task | File | Details |
|------|------|---------|
| 4.1 | `run-e2e.js` | Track which selector succeeded per action (primary, fallback[0], fallback[1], text). Store as `_lastUsedSelector` on the action. |
| 4.2 | `run-e2e.js` | After run, if any action used a fallback: promote fallback to primary, demote old primary to fallback. |
| 4.3 | `run-e2e.js` | Write updated selectors back to `QA_RECORDED_FLOWS.json` (opt-in via `--heal` flag). |
| 4.4 | `run-e2e.js` | Report selector health in console and HTML report: "2 selectors healed, 1 broken". |

---

### Phase 5: Flow Composition (future)

**Goal:** Flows can depend on other flows. Login flow is auto-prepended.

**Depends on:** Phase 3

| Task | File | Details |
|------|------|---------|
| 5.1 | Schema | Add `requires: ["login_flow"]` field to flow definition. |
| 5.2 | `run-e2e.js` | Before executing a flow, check `requires`. Find and execute required flows first. Skip if already run in this session. |
| 5.3 | `learn.js` | When finishing a flow with `[f]`: if first step is NOT on the login page, auto-add `requires: ["login"]` (or detect from shared.authenticated in model). |

---

### Implementation Order Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                     PHASE 1: HEALTH CHECKS                      │
│                                                                 │
│  1A: Landmark capture          ──┐                              │
│      (captureState + pickLandmark) │                             │
│                                  ├──→ 1C: run-test.js V2       │
│  1B: New inferred checks        ──┘    (page_alive,             │
│      (inferChecksV2)                    page_identity,          │
│                                         no_console_errors)      │
│                                                                 │
│  CAN TEST: learn → run-test.js with reliable checks            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     PHASE 2: FLOW RECORDING                     │
│  (can build in parallel with Phase 1)                           │
│                                                                 │
│  2A: Flow state machine        ──┐                              │
│      ([r], [f], Enter branching)  │                             │
│                                  ├──→ 2C: Flow persistence      │
│  2B: Event collapsing engine   ──┘    + [v] command            │
│      (collapseEvents, 7 rules)        + QA_RECORDED_FLOWS.json │
│                                                                 │
│  CAN TEST: learn → produces both model + flows files           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     PHASE 3: E2E RUNNER                         │
│  (depends on Phase 2C)                                          │
│                                                                 │
│  3A: Core executor             ──┐                              │
│      (actions, selectors,        │                              │
│       variables, auth)           ├──→ 3C: Reporting + output   │
│                                  │                              │
│  3B: Verify checks             ──┘                              │
│      (url_is, text_visible,                                     │
│       toast_contains, etc.)                                     │
│                                                                 │
│  CAN TEST: full pipeline — learn → run-test → run-e2e          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     FUTURE PHASES                               │
│                                                                 │
│  Phase 4: Selector auto-healing (depends on Phase 3)           │
│  Phase 5: Flow composition (depends on Phase 3)                │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Strategy

All changes are made in `opencode/scripts/` first (primary development), then synced to `opencode-dev/packages/opencode/src/scripts/`. After each phase, verify both repos have identical files:

```bash
diff opencode/scripts/learn.js opencode-dev/packages/opencode/src/scripts/learn.js
diff opencode/scripts/run-test.js opencode-dev/packages/opencode/src/scripts/run-test.js
diff opencode/scripts/run-e2e.js opencode-dev/packages/opencode/src/scripts/run-e2e.js
```

---

## 14. Open Questions

### Decided

1. **Should both runners be usable independently?** → **Yes.** Health check only needs the model. E2E only needs the flows file. Neither requires the other.

2. **Should steps outside a flow still work?** → **Yes.** Pressing Enter without `[r]` records a health checkpoint only (backward compatible with current learn behavior).

3. **Should we drop element_count_changed checks?** → **Yes** in V2, but keep backward compat: if model has no `health` block, use old checks.

### Open

4. **Should `run-e2e.js` update the feature model confidence?** If a capability's E2E flow passes, that's stronger evidence than a health check. Could auto-bump confidence. Downside: E2E runner modifying the model file could cause unexpected diffs.

5. **Should we capture baseline screenshots during learn for visual comparison?** Record what the page looked like when you pressed Enter, then compare pixel-by-pixel during replay. Pro: catches visual regressions. Con: brittle (dynamic content, timestamps, avatars).

6. **How to handle dynamic content in verify checks?** If user adds `text_visible("March 16, 2026")`, that will fail tomorrow. Options: warn during recording, support regex patterns, or only suggest stable text (headings, labels, not dates).

7. **Should flows support conditional steps?** e.g., "if dialog is open, close it first." Current design: no. All steps are sequential and unconditional. Conditional logic adds complexity and makes flows harder to read.

8. **What happens when a flow's first step is login but user is already authenticated?** Options: always start from a fresh browser context (clean), or detect auth state and skip login (faster but complex). Recommendation: fresh context per flow.

---

## 15. Comprehensive Usage Guide

This section walks through every real-world scenario with complete terminal examples.

---

### 15.1 First-Time Setup (New Project)

You have a running app and want QA coverage from scratch.

```bash
cd /Users/bones/Documents/rondah/Planning/opencode

# Set credentials
export TEST_EMAIL="john@mail.com"
export TEST_PASSWORD="your-password"
```

#### Step 1: Init — Generate skeleton model

```bash
node scripts/init.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --max-pages 30
```

**Terminal output:**
```
QA Agent -- Init
==================================================
Scanning http://localhost:3000...

Authenticating...
Authenticated. Current URL: http://localhost:3000/home/call-logs

Crawling pages (max: 30)...
  [1/30] /home/call-logs — patterns: data_table, search_filter, nav_sidebar
  [2/30] /home/dashboard — patterns: data_table, nav_sidebar
  [3/30] /home/reports — patterns: data_table, nav_sidebar
  [4/30] /home/voicemails — patterns: data_table, nav_sidebar
  [5/30] /home/appointments-v2 — patterns: nav_sidebar
  [6/30] /home/notifications — patterns: form_generic, nav_sidebar
  [7/30] /home/admin-hub/system-health — patterns: data_table, nav_sidebar
  [8/30] /home/configurations/practice-details — patterns: form_generic, nav_sidebar
  [9/30] /home/configurations/pms-connector — patterns: nav_sidebar
  [10/30] /home/configurations/providers — patterns: data_table, nav_sidebar
  ...
  [18/30] /home/configurations/calendar-hub — patterns: nav_sidebar

Scan complete: 18 pages, 6 patterns detected

Generated: ./QA_FEATURE_MODEL.json
  Features: 18
  Capabilities: 24
  Quality: SKELETON (all init confidence)

Generated: ./QA_INSTRUCTIONS.json
  Excluded routes: 0
  Known issues: 1 (ResizeObserver)
  Default timeout: 10000ms

Next: run "node scripts/learn.js" to improve the model with real observations.
```

**What you now have:**
```
opencode/
├── QA_FEATURE_MODEL.json    ← skeleton model (guessed capabilities)
├── QA_INSTRUCTIONS.json     ← agent config
```

#### Step 2: Learn — Record health checks for all pages

Open learn mode, visit every page, press Enter on each one.

```bash
node scripts/learn.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD
```

**Terminal session:**
```
============================================================
  QA Agent -- Learn Mode (Session #1)

  Loaded: ./QA_FEATURE_MODEL.json (18 features, 24 capabilities)
  Browser will open at http://localhost:3000

  Walk through your app. The agent is watching.

  Commands:
    [r]      Start recording a new E2E flow
    [Enter]  Record this interaction (health check or flow step)
    [n]      Name/label the current step
    [v]      Add a custom verify check
    [e]      Mark as edge case
    [s]      Skip — discard pending interactions
    [f]      Finish current flow (name it, tag it)
    [d]      Done — finish session, save everything

============================================================

Status: Watching... (press Enter to record, [r] to start a flow)

  You clicked: button "Log In"
  Navigation: /home/call-logs
```

Now you're logged in. Visit each page and press Enter:

```
  (Browser: navigate to Analytics/Dashboard)
  You clicked: a "Analytics"
  Navigation: /home/dashboard

[Enter]
  HEALTH: dashboard
    Route: /home/dashboard
    Landmark: h1 "Analytics Dashboard"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on Call Logs)
  You clicked: a "Call Logs"
  Navigation: /home/call-logs

[Enter]
  HEALTH: call_logs
    Route: /home/call-logs
    Landmark: h1 "Call Logs"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on Reports)
  You clicked: a "Reports"
  Navigation: /home/reports

[Enter]
  HEALTH: reports
    Route: /home/reports
    Landmark: h1 "Reports"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on Voicemails)
  You clicked: a "Voicemails"
  Navigation: /home/voicemails

[Enter]
  HEALTH: voicemails
    Route: /home/voicemails
    Landmark: h1 "Voicemails"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on Appointments)
  You clicked: a "Appointments"
  Navigation: /home/appointments-v2

[Enter]
  HEALTH: appointments_v2
    Route: /home/appointments-v2
    Landmark: h1 "Appointments"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on Notifications)
  You clicked: a "Notifications"
  Navigation: /home/notifications

[Enter]
  HEALTH: notifications
    Route: /home/notifications
    Landmark: h1 "Notifications"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Browser: click on System Health)
  You clicked: a "System Health"
  Navigation: /home/admin-hub/system-health

[Enter]
  HEALTH: system_health
    Route: /home/admin-hub/system-health
    Landmark: h1 "System Health"
    Page alive: OK
    Console errors: 0
    Error alerts: 0

  (Continue for all remaining config pages...)
  ...

[d]

  Finishing session...

============================================================
  Session complete.

  Health checks: 15 features updated with landmarks
  Flows recorded: 0
  Model saved: QA_FEATURE_MODEL.json
============================================================
```

#### Step 3: Run health check

```bash
node scripts/run-test.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD
```

**Terminal output:**
```
============================================================
  QA Agent -- Health Check
  Model: ./QA_FEATURE_MODEL.json (v1.0)
  URL: http://localhost:3000
  Features: 15
============================================================

Launching browser...
Authenticating...

[1/15] dashboard
  Route: /home/dashboard
  PASS  page_alive: readyState=complete, title="Rondah - Dashboard"
  PASS  no_console_errors: 0 errors
  PASS  no_error_alerts: 0 error elements
  PASS  page_identity: h1 "Analytics Dashboard" found
  -> PASSED (4/4 checks, 1.2s)

[2/15] call_logs
  Route: /home/call-logs
  PASS  page_alive: readyState=complete, title="Rondah - Call Logs"
  PASS  no_console_errors: 0 errors
  PASS  no_error_alerts: 0 error elements
  PASS  page_identity: h1 "Call Logs" found
  -> PASSED (4/4 checks, 0.9s)

[3/15] reports
  Route: /home/reports
  PASS  page_alive: readyState=complete, title="Rondah - Reports"
  PASS  no_console_errors: 0 errors
  PASS  no_error_alerts: 0 error elements
  PASS  page_identity: h1 "Reports" found
  -> PASSED (4/4 checks, 0.8s)

  ...

[12/15] pms_connector
  Route: /home/configurations/pms-connector
  PASS  page_alive: readyState=complete
  FAIL  no_console_errors: 1 error — "Failed to fetch connector status"
  PASS  no_error_alerts: 0 error elements
  PASS  page_identity: h1 "PMS Connector" found
  -> FAILED (3/4 checks, 1.1s)

  ...

============================================================
  Health Check Results
============================================================
  Total:    15
  Passed:   14
  Failed:   1
  Duration: 18.3s

  Failed:
    - pms_connector: no_console_errors — 1 error: "Failed to fetch connector status"

============================================================

Results: ./qa-results/summary.json
Report:  ./qa-results/report.html
```

You now have reliable health check coverage. The PMS Connector failure is a real console error — not a false positive from element counting.

---

### 15.2 Recording E2E Flows

Now record actual workflows. Start a learn session and use `[r]` to begin recording flows.

```bash
node scripts/learn.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD
```

#### Example A: Login → Dashboard → Filter (smoke flow)

```
Status: Watching...

  (Browser: type email, password, click Log In)
  You typed: "john@mail.com" in Enter your email
  You typed: (password) in Enter your password
  You clicked: button "Log In"
  Navigation: /home/call-logs

[r]                                     ← START RECORDING FLOW
  Recording started. Each [Enter] = one step.

[Enter]                                 ← STEP 1: login
  Step 1 RECORDED:
    Route: /auth/sign-in → /home/call-logs
    Actions (collapsed):
      1. fill input[aria-label='Email Address'] = $EMAIL
      2. fill input[aria-label='Password'] = $PASSWORD
      3. click button "Log In"
      4. waitForURL /home/call-logs
    Verify: url_is(/home/call-logs), no_js_errors, no_console_errors
    Health: page_alive, page_identity(/home/call-logs, h1 "Call Logs")

  (Browser: click Analytics in nav)
  You clicked: a "Analytics"
  Navigation: /home/dashboard

[Enter]                                 ← STEP 2: navigate to dashboard
  Step 2 RECORDED:
    Route: /home/call-logs → /home/dashboard
    Actions (collapsed):
      1. click a "Analytics"
      2. waitForURL /home/dashboard
    Verify: url_is(/home/dashboard), no_js_errors, no_console_errors
    Health: page_alive, page_identity(/home/dashboard, h1 "Analytics Dashboard")

  (Browser: click date range filter, select "Last 7 Days")
  You clicked: button "Date Range"
  You clicked: button "Last 7 Days"

[v]                                     ← ADD CUSTOM VERIFY CHECK
  What to verify?
    1. Text is visible on page
    2. Text is NOT visible
    3. Element exists (by selector)
    4. Element is gone
    5. URL is (exact path)
  Select [1-5]: 1
  Enter text to check for: Last 7 Days
  Added: text_visible("Last 7 Days")

[Enter]                                 ← STEP 3: filter dashboard
  Step 3 RECORDED:
    Route: /home/dashboard (same page)
    Actions (collapsed):
      1. click button "Date Range"
      2. click button "Last 7 Days"
    Verify: text_visible("Last 7 Days"), no_js_errors, no_console_errors

[f]                                     ← FINISH FLOW
  Name this flow (or Enter to auto-name): smoke_login_dashboard
  Tags (comma-separated, or Enter to skip): smoke,critical,daily

  Flow saved: smoke_login_dashboard
    3 steps | tags: smoke, critical, daily
    Routes: /auth/sign-in → /home/call-logs → /home/dashboard
```

#### Example B: CRUD Flow — Create, Edit, Delete Appointment Type

```
[r]                                     ← START RECORDING FLOW

  (Browser: already logged in from previous flow, navigate to Appointment Types)
  You clicked: a "Appointment Types"
  Navigation: /home/configurations/appointment-types

[Enter]                                 ← STEP 1: navigate to list
  Step 1 RECORDED:
    Route: /home/configurations/appointment-types
    Actions (collapsed):
      1. click a "Appointment Types"
      2. waitForURL /home/configurations/appointment-types
    Verify: url_is(/home/configurations/appointment-types), no_js_errors

  (Browser: click "Add New" button)
  You clicked: button "Add New"
  (Browser: dialog opens)
  (Browser: fill in form fields)
  You typed: "Test Cleaning" in Name
  You clicked: select#duration
  You typed: "30" → selected "30 minutes" from dropdown
  You clicked: button "Save"
  (Browser: toast appears "Appointment type created")

[v]
  Select [1-5]: 1
  Enter text to check for: Appointment type created
  Added: toast_contains("Appointment type created")

[v]
  Select [1-5]: 1
  Enter text to check for: Test Cleaning
  Added: text_visible("Test Cleaning")

[Enter]                                 ← STEP 2: create appointment type
  Step 2 RECORDED:
    Route: /home/configurations/appointment-types (same page)
    Actions (collapsed):
      1. click button "Add New"
      2. fill input[aria-label='Name'] = "Test Cleaning"
      3. select select#duration = "30"
      4. click button "Save"
    Verify:
      toast_contains("Appointment type created")
      text_visible("Test Cleaning")
      no_js_errors, no_console_errors

  (Browser: click edit icon on "Test Cleaning" row)
  You clicked: button[aria-label='Edit Test Cleaning']
  (Browser: dialog opens with form pre-filled)
  (Browser: change name)
  You typed: "Test Deep Cleaning" in Name
  You clicked: button "Save"
  (Browser: toast appears "Appointment type updated")

[v]
  Select [1-5]: 1
  Enter text to check for: Test Deep Cleaning
  Added: text_visible("Test Deep Cleaning")

[v]
  Select [1-5]: 2
  Enter text NOT visible: Test Cleaning
  Added: text_not_visible("Test Cleaning")

[Enter]                                 ← STEP 3: edit appointment type
  Step 3 RECORDED:
    Route: /home/configurations/appointment-types (same page)
    Actions (collapsed):
      1. click button[aria-label='Edit Test Cleaning']
      2. fill input[aria-label='Name'] = "Test Deep Cleaning"
      3. click button "Save"
    Verify:
      text_visible("Test Deep Cleaning")
      text_not_visible("Test Cleaning")
      no_js_errors, no_console_errors

  (Browser: click delete icon on "Test Deep Cleaning" row)
  You clicked: button[aria-label='Delete Test Deep Cleaning']
  (Browser: confirmation dialog appears)
  You clicked: button "Confirm"
  (Browser: toast appears "Appointment type deleted")

[v]
  Select [1-5]: 2
  Enter text NOT visible: Test Deep Cleaning
  Added: text_not_visible("Test Deep Cleaning")

[Enter]                                 ← STEP 4: delete appointment type
  Step 4 RECORDED:
    Route: /home/configurations/appointment-types (same page)
    Actions (collapsed):
      1. click button[aria-label='Delete Test Deep Cleaning']
      2. click button "Confirm"
    Verify:
      text_not_visible("Test Deep Cleaning")
      no_js_errors, no_console_errors

[f]                                     ← FINISH FLOW
  Name: crud_appointment_types
  Tags: regression,crud

  Flow saved: crud_appointment_types
    4 steps | tags: regression, crud
    Full CRUD: create → edit → delete
```

#### Example C: Toggle Settings & Form Submission

```
[r]                                     ← START RECORDING FLOW

  (Browser: navigate to Notifications settings)
  You clicked: a "Notifications"
  Navigation: /home/notifications

[Enter]                                 ← STEP 1: navigate
  Step 1 RECORDED:
    Route: /home/notifications
    Actions (collapsed):
      1. click a "Notifications"
      2. waitForURL /home/notifications

  (Browser: toggle email notifications ON)
  You clicked: button[role='switch'][aria-label='Email Notifications']

[v]
  Select [1-5]: 3
  Enter selector: [aria-label='Email Notifications']
  Added: element_attribute([aria-label='Email Notifications'], aria-checked, "true")

[Enter]                                 ← STEP 2: toggle
  Step 2 RECORDED:
    Route: /home/notifications (same page)
    Actions (collapsed):
      1. click button[role='switch'][aria-label='Email Notifications']
    Verify:
      element_attribute([aria-label='Email Notifications'], aria-checked="true")
      no_js_errors

  (Browser: change notification frequency dropdown)
  You clicked: button "Select frequency"
  You clicked: [role='option'] "Daily Digest"

[v]
  Select [1-5]: 1
  Enter text to check for: Daily Digest
  Added: text_visible("Daily Digest")

[Enter]                                 ← STEP 3: select option
  Step 3 RECORDED:
    Route: /home/notifications (same page)
    Actions (collapsed):
      1. click button "Select frequency"
      2. click [role='option'] "Daily Digest"
    Verify:
      text_visible("Daily Digest")
      no_js_errors

  (Browser: click Save)
  You clicked: button "Save Changes"
  (Browser: toast "Settings saved")

[v]
  Select [1-5]: 1
  Enter text to check for: Settings saved
  Added: toast_contains("Settings saved")

[Enter]                                 ← STEP 4: save form
  Step 4 RECORDED:
    Route: /home/notifications (same page)
    Actions (collapsed):
      1. click button "Save Changes"
    Verify:
      toast_contains("Settings saved")
      no_js_errors, no_console_errors

[f]
  Name: notification_settings_update
  Tags: regression,settings

  Flow saved: notification_settings_update
    4 steps | tags: regression, settings
```

#### Example D: Search and Filter

```
[r]

  (Browser: on Call Logs page)
  (Browser: type in search box)
  You typed: "John Smith" in Search calls
  (Browser: results filter in real-time)

[v]
  Select [1-5]: 1
  Enter text to check for: John Smith
  Added: text_visible("John Smith")

[Enter]                                 ← STEP 1: search
  Step 1 RECORDED:
    Route: /home/call-logs (same page)
    Actions (collapsed):
      1. fill input[aria-label='Search calls'] = "John Smith"
    Verify:
      text_visible("John Smith")
      no_js_errors

  (Browser: click status filter dropdown, select "Completed")
  You clicked: button "Status"
  You clicked: [role='option'] "Completed"

[v]
  Select [1-5]: 1
  Enter text to check for: Completed
  Added: text_visible("Completed")

[Enter]                                 ← STEP 2: filter by status
  Step 2 RECORDED:
    Route: /home/call-logs (same page)
    Actions (collapsed):
      1. click button "Status"
      2. click [role='option'] "Completed"
    Verify:
      text_visible("Completed")
      no_js_errors

  (Browser: click "Clear Filters" button)
  You clicked: button "Clear Filters"

[v]
  Select [1-5]: 2
  Enter text NOT visible: Completed
  Added: text_not_visible("Completed")

[Enter]                                 ← STEP 3: clear filters
  Step 3 RECORDED:
    Route: /home/call-logs (same page)
    Actions (collapsed):
      1. click button "Clear Filters"
    Verify:
      text_not_visible("Completed")
      no_js_errors

[f]
  Name: call_logs_search_filter
  Tags: regression,search

  Flow saved: call_logs_search_filter
    3 steps | tags: regression, search
```

#### Example E: Mixed Session — Health Checks + E2E Flow

One session that does both:

```
Status: Watching...

  (Login happens)
  Navigation: /home/call-logs

  === RECORD HEALTH CHECKS (no [r] — standalone) ===

  You clicked: a "Analytics"
  Navigation: /home/dashboard
[Enter]
  HEALTH: dashboard — h1 "Analytics Dashboard"

  You clicked: a "Reports"
  Navigation: /home/reports
[Enter]
  HEALTH: reports — h1 "Reports"

  You clicked: a "Voicemails"
  Navigation: /home/voicemails
[Enter]
  HEALTH: voicemails — h1 "Voicemails"

  You clicked: a "System Health"
  Navigation: /home/admin-hub/system-health
[Enter]
  HEALTH: system_health — h1 "System Health"

  You clicked: a "Practice Details"
  Navigation: /home/configurations/practice-details
[Enter]
  HEALTH: practice_details — h1 "Practice Details"

  You clicked: a "Providers"
  Navigation: /home/configurations/providers
[Enter]
  HEALTH: providers — h1 "Providers"

  You clicked: a "Appointment Types"
  Navigation: /home/configurations/appointment-types
[Enter]
  HEALTH: appointment_types — h1 "Appointment Types"

  === NOW RECORD AN E2E FLOW ===

[r]

  You clicked: button "Add New"
  You typed: "Temp Type" in Name
  You clicked: button "Save"

[v]
  Select: 1
  Text: Temp Type
  Added: text_visible("Temp Type")

[Enter]
  Step 1: create appointment type

  You clicked: button[aria-label='Delete Temp Type']
  You clicked: button "Confirm"

[v]
  Select: 2
  Text: Temp Type
  Added: text_not_visible("Temp Type")

[Enter]
  Step 2: delete appointment type

[f]
  Name: quick_crud_appointment_type
  Tags: smoke,crud

[d]

============================================================
  Session complete.

  Health checks: 7 features updated
  Flows recorded: 1 (quick_crud_appointment_type, 2 steps)
  Model saved: QA_FEATURE_MODEL.json
  Flows saved: QA_RECORDED_FLOWS.json
============================================================
```

---

### 15.3 Running E2E Replay Tests

After recording flows, replay them against any environment.

#### Run all flows

```bash
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD
```

**Terminal output:**
```
============================================================
  QA Agent -- E2E Replay
  Flows: ./QA_RECORDED_FLOWS.json (4 flows, 14 steps)
  URL: http://localhost:3000
============================================================

Launching browser...

Flow 1/4: smoke_login_dashboard (3 steps) [smoke, critical, daily]
  Step 1: Login
    fill input[aria-label='Email Address'] = "john@mail.com"
    fill input[aria-label='Password'] = "***"
    click button "Log In"
    waitForURL /home/call-logs
    PASS  url_is: /home/call-logs
    PASS  no_js_errors: 0 errors
    PASS  no_console_errors: 0 errors
    -> PASSED (1.8s)

  Step 2: Navigate to Dashboard
    click a "Analytics"
    waitForURL /home/dashboard
    PASS  url_is: /home/dashboard
    PASS  no_js_errors: 0 errors
    PASS  no_console_errors: 0 errors
    -> PASSED (0.9s)

  Step 3: Filter Dashboard
    click button "Date Range"
    click button "Last 7 Days"
    PASS  text_visible: "Last 7 Days" found
    PASS  no_js_errors: 0 errors
    PASS  no_console_errors: 0 errors
    -> PASSED (0.6s)

  Flow PASSED: 3/3 steps (3.3s)

Flow 2/4: crud_appointment_types (4 steps) [regression, crud]
  Step 1: Navigate to list
    click a "Appointment Types"
    waitForURL /home/configurations/appointment-types
    PASS  url_is: /home/configurations/appointment-types
    -> PASSED (0.8s)

  Step 2: Create appointment type
    click button "Add New"
    fill input[aria-label='Name'] = "Test Cleaning"
    select select#duration = "30"
    click button "Save"
    PASS  toast_contains: "Appointment type created"
    PASS  text_visible: "Test Cleaning" found
    PASS  no_js_errors: 0 errors
    -> PASSED (2.1s)

  Step 3: Edit appointment type
    click button[aria-label='Edit Test Cleaning']
    fill input[aria-label='Name'] = "Test Deep Cleaning"
    click button "Save"
    PASS  text_visible: "Test Deep Cleaning" found
    PASS  text_not_visible: "Test Cleaning" confirmed gone
    -> PASSED (1.5s)

  Step 4: Delete appointment type
    click button[aria-label='Delete Test Deep Cleaning']
    click button "Confirm"
    PASS  text_not_visible: "Test Deep Cleaning" confirmed gone
    -> PASSED (1.2s)

  Flow PASSED: 4/4 steps (5.6s)

Flow 3/4: notification_settings_update (4 steps) [regression, settings]
  Step 1: Navigate
    click a "Notifications"
    waitForURL /home/notifications
    -> PASSED (0.7s)

  Step 2: Toggle email notifications
    click button[role='switch'][aria-label='Email Notifications']
    PASS  element_attribute: aria-checked = "true"
    -> PASSED (0.4s)

  Step 3: Select frequency
    click button "Select frequency"
    click [role='option'] "Daily Digest"
    PASS  text_visible: "Daily Digest" found
    -> PASSED (0.5s)

  Step 4: Save settings
    click button "Save Changes"
    PASS  toast_contains: "Settings saved"
    -> PASSED (0.8s)

  Flow PASSED: 4/4 steps (2.4s)

Flow 4/4: call_logs_search_filter (3 steps) [regression, search]
  Step 1: Search
    fill input[aria-label='Search calls'] = "John Smith"
    PASS  text_visible: "John Smith" found
    -> PASSED (0.9s)

  Step 2: Filter by status
    click button "Status"
    click [role='option'] "Completed"
    PASS  text_visible: "Completed" found
    -> PASSED (0.6s)

  Step 3: Clear filters
    click button "Clear Filters"
    FAIL  text_not_visible: "Completed" still visible on page
    -> FAILED (0.5s)

  Flow FAILED: 2/3 steps passed (2.0s)

============================================================
  E2E Replay Results
============================================================
  Flows:    4
  Passed:   3
  Failed:   1
  Steps:    14 total, 13 passed, 1 failed
  Duration: 13.3s

  Failed:
    - call_logs_search_filter > Step 3 (Clear filters):
      text_not_visible("Completed") — text still visible
      Screenshot: qa-results/screenshots/call_logs_search_filter_step3_error.png

============================================================

Results: ./qa-results/e2e-summary.json
Report:  ./qa-results/e2e-report.html
```

#### Run by tag

```bash
# Only smoke flows (fast — for every PR)
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --tag smoke

# Output:
#   Running 1 flow tagged "smoke"
#   Flow 1/1: smoke_login_dashboard (3 steps)
#     ...
#   PASSED (3.3s)
```

```bash
# Only regression flows (thorough — pre-release)
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --tag regression

# Output:
#   Running 3 flows tagged "regression"
#   ...
```

#### Run a specific flow

```bash
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --flow crud_appointment_types
```

#### Watch it run (non-headless)

```bash
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --no-headless

# Browser window opens and you can watch every click, fill, and navigation
# Useful for debugging failing flows
```

#### Stop on first failure

```bash
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --stop-on-fail

# Stops at first failed step, leaves browser open (if --no-headless)
# Useful for debugging
```

---

### 15.4 Running the Full Pipeline

#### Local development (after code change)

```bash
# 1. Quick health check — did I break any pages? (~20s)
node scripts/run-test.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD

# 2. If healthy, run smoke E2E — do core workflows still work? (~5s)
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --tag smoke

# 3. Before merging, run full regression E2E (~30s)
node scripts/run-e2e.js \
  --url http://localhost:3000 \
  --email $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --tag regression
```

#### One-liner for CI

```bash
# Health check + smoke E2E — exit 1 on any failure
node scripts/run-test.js --url $URL --email $EMAIL --password $PASS \
  && node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --tag smoke
```

#### Against staging / preview deploy

```bash
# Same commands, different URL
node scripts/run-test.js --url https://staging.rondah.com --email $EMAIL --password $PASS
node scripts/run-e2e.js --url https://staging.rondah.com --email $EMAIL --password $PASS
```

---

### 15.5 Managing Flows

#### View recorded flows

```bash
cat QA_RECORDED_FLOWS.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for name, flow in data['flows'].items():
    tags = ', '.join(flow.get('tags', []))
    steps = len(flow['steps'])
    print(f\"  {name} ({steps} steps) [{tags}]\")
"
```

Output:
```
  smoke_login_dashboard (3 steps) [smoke, critical, daily]
  crud_appointment_types (4 steps) [regression, crud]
  notification_settings_update (4 steps) [regression, settings]
  call_logs_search_filter (3 steps) [regression, search]
```

#### Edit flows manually

The JSON is human-editable. Common edits:

**Change a selector:**
```json
// Before
{ "type": "click", "selector": "button.bg-blue-500.px-4", "text": "Save" }

// After (more resilient)
{ "type": "click", "selector": "button:has-text('Save')", "text": "Save" }
```

**Add a verify check to a step:**
```json
"verify": [
  { "type": "url_is", "value": "/home/dashboard" },
  { "type": "text_visible", "value": "Welcome back" },
  { "type": "no_js_errors" }
]
```

**Change tags:**
```json
"tags": ["smoke", "critical", "daily", "ci"]
```

**Remove a step:** Delete the step object from the `steps` array.

**Reorder steps:** Move step objects in the `steps` array.

#### Delete a flow

Remove the flow key from `flows` in the JSON file.

#### Re-record a flow

Run learn again with `[r]`. The new flow gets a new name. Delete the old one from the JSON if you want to replace it.

---

### 15.6 Handling Failures

#### Health check failure: console error

```
[5/15] pms_connector
  FAIL  no_console_errors: 1 error — "Failed to fetch connector status"
```

**Options:**
1. Fix the actual bug (the API is failing)
2. If it's a known issue, add to ignore list in `QA_INSTRUCTIONS.json`:
```json
{
  "known_issues": [
    {
      "pattern": "Failed to fetch connector status",
      "severity": "low",
      "reason": "PMS connector not configured in test env"
    }
  ]
}
```

#### Health check failure: landmark not found

```
[8/15] practice_details
  FAIL  page_identity: h1 "Practice Details" not found
```

**Possible causes:**
- Page heading was renamed → re-run learn to update landmark
- Page is behind a loading spinner → increase timeout
- Page requires additional permissions → check auth

#### E2E failure: selector broken

```
Step 2: Create appointment type
  click button "Add New"
  SELECTOR_BROKEN: button[aria-label='Edit Test Cleaning'] — not found
  Fallback tried: button:has-text('Edit Test Cleaning') — not found
  -> FAILED
```

**Fix:** The UI changed. Options:
1. Re-record the flow
2. Edit the selector in `QA_RECORDED_FLOWS.json`
3. Add `data-testid` attributes to your app components (most stable solution)

#### E2E failure: text check failed

```
Step 3: Clear filters
  FAIL  text_not_visible: "Completed" still visible on page
```

**Possible causes:**
- The clear button didn't work (real bug)
- The check is too fast — text disappears after animation → add wait
- "Completed" appears elsewhere on the page → use more specific text

---

### 15.7 CI/CD Integration Examples

#### GitHub Actions: Health + E2E on PR preview

```yaml
name: QA Tests
on:
  deployment_status:

jobs:
  qa:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx playwright install chromium

      - name: Health Check
        run: |
          node scripts/run-test.js \
            --url ${{ github.event.deployment_status.target_url }} \
            --email ${{ secrets.TEST_EMAIL }} \
            --password ${{ secrets.TEST_PASSWORD }} \
            --output-dir ./qa-results/health

      - name: E2E Smoke
        run: |
          node scripts/run-e2e.js \
            --url ${{ github.event.deployment_status.target_url }} \
            --email ${{ secrets.TEST_EMAIL }} \
            --password ${{ secrets.TEST_PASSWORD }} \
            --tag smoke \
            --output-dir ./qa-results/e2e

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-results
          path: qa-results/
```

#### GitHub Actions: Full regression on staging deploy

```yaml
name: Staging Regression
on:
  push:
    branches: [staging]

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx playwright install chromium

      - name: Health Check
        run: |
          node scripts/run-test.js \
            --url ${{ secrets.STAGING_URL }} \
            --email ${{ secrets.TEST_EMAIL }} \
            --password ${{ secrets.TEST_PASSWORD }}

      - name: Full Regression E2E
        run: |
          node scripts/run-e2e.js \
            --url ${{ secrets.STAGING_URL }} \
            --email ${{ secrets.TEST_EMAIL }} \
            --password ${{ secrets.TEST_PASSWORD }} \
            --tag regression

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: regression-results
          path: qa-results/
```

---

### 15.8 Suggested Flow Library for Rondah

Based on the app's pages, here are recommended flows to record:

#### Smoke Flows (run on every PR, ~10s each)

| Flow Name | Steps | What it tests |
|-----------|-------|---------------|
| `smoke_login_dashboard` | Login → Dashboard | Auth works, dashboard loads |
| `smoke_navigate_all` | Visit each main nav page | All pages load |
| `smoke_practice_switch` | Switch between practices | Practice selector works |

#### Regression Flows (run pre-release, ~30s each)

| Flow Name | Steps | What it tests |
|-----------|-------|---------------|
| `crud_appointment_types` | Create → Edit → Delete type | Full CRUD |
| `call_logs_search_filter` | Search → Filter → Clear | Search/filter system |
| `notification_settings_update` | Toggle → Select → Save | Settings persistence |
| `system_health_run_tests` | Navigate → Run tests → View results | Admin functions |
| `pms_resources_sync` | Navigate → Sync → Verify | PMS integration |

#### Edge Case Flows (run weekly)

| Flow Name | Steps | What it tests |
|-----------|-------|---------------|
| `login_invalid_credentials` | Bad password → error shown | Auth error handling |
| `empty_form_submission` | Submit empty form → validation errors | Form validation |
| `rapid_navigation` | Quick nav between pages | No race conditions |

---

### 15.9 Cheat Sheet

```bash
# ── SETUP ──
node scripts/init.js --url $URL --email $EMAIL --password $PASS   # skeleton model
node scripts/learn.js --url $URL --email $EMAIL --password $PASS   # record

# ── DURING LEARN ──
# [Enter]  = health checkpoint (standalone)
# [r]      = start E2E flow
# [Enter]  = record flow step
# [v]      = add verify check
# [f]      = finish flow, name + tag it
# [d]      = done, save everything

# ── HEALTH CHECK ──
node scripts/run-test.js --url $URL --email $EMAIL --password $PASS

# ── E2E REPLAY ──
node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS              # all flows
node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --tag smoke  # by tag
node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --flow NAME  # specific
node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --no-headless # watch

# ── PIPELINE ──
node scripts/run-test.js --url $URL --email $EMAIL --password $PASS \
  && node scripts/run-e2e.js --url $URL --email $EMAIL --password $PASS --tag smoke

# ── VIEW RESULTS ──
open qa-results/report.html        # health check report
open qa-results/e2e-report.html    # E2E replay report
```
