# Smart QA Agent — Implementation Execution Plan

> Final implementation document. Covers what to build, in what order, which files to touch, how to test each phase, and what "done" looks like at every step.

Reference docs:
- [SMART_QA_AGENT.md](SMART_QA_AGENT.md) — High-level vision
- [SMART_QA_ENGINEERING_SPEC.md](SMART_QA_ENGINEERING_SPEC.md) — Technical spec
- [QA_STRATEGY.md](QA_STRATEGY.md) — Broader QA strategy

---

## Table of Contents

1. [Legacy System: How It Works Today](#legacy-system-how-it-works-today)
2. [Smart System: How It Will Work](#smart-system-how-it-will-work)
3. [Side-by-Side: Legacy vs Smart](#side-by-side-legacy-vs-smart)
4. [Repos & How They Relate](#repos--how-they-relate)
5. [Pre-Implementation Decisions](#pre-implementation-decisions)
6. [Phase 0: Pattern Library](#phase-0-pattern-library)
7. [Phase 1: scan_page Tool](#phase-1-scan_page-tool)
8. [Phase 2: map_site Tool](#phase-2-map_site-tool)
9. [Phase 3: verify_behavior Tool](#phase-3-verify_behavior-tool)
10. [Phase 4: Feature Model & Loader](#phase-4-feature-model--loader)
11. [Phase 5: Intent Composer (compose_test v2)](#phase-5-intent-composer-compose_test-v2)
12. [Phase 6: Knowledge Evolution](#phase-6-knowledge-evolution)
13. [QA Instructions File (QA_INSTRUCTIONS.json)](#qa-instructions-file-qa_instructionsjson)
14. [Generating Config Files](#generating-config-files)
15. [Publishing & Consumer Updates](#publishing--consumer-updates)
16. [Testing Strategy Per Phase](#testing-strategy-per-phase)
17. [Risk Register](#risk-register)

---

## Legacy System: How It Works Today

The current QA agent is a **prompt-construction + AI screenshot loop**. Here's the full chain:

### What you have to write (manually, per app)

```
qa-agent/
├── QA_ANCHOR_POINTS.json        ← 75 lines of CSS selectors, organized by feature
├── QA_FLOWS.json                ← 858 lines of step-by-step test definitions
├── configs/
│   ├── local.env.json           ← URL + credentials per environment
│   ├── staging.env.json
│   └── production.env.json
└── scenarios/
    ├── smoke-test.md            ← Markdown scenario files (alternative to flows)
    ├── call-logs-deep.md
    ├── auth-edge-cases.md
    └── ... (8 scenario files)
```

**Every test you want to run requires you to hand-write one of:**
- A flow in `QA_FLOWS.json` — step-by-step JSON with action/target/value/fallback per step
- A scenario in `scenarios/*.md` — freeform markdown instructions

**Every selector you use requires you to maintain:**
- An entry in `QA_ANCHOR_POINTS.json` — CSS selectors organized by feature area

### How a test runs (legacy)

```
1. You run: ./run-flows.sh local smoke

2. Shell script reads:
   - configs/local.env.json → gets BASE_URL, EMAIL, PASSWORD
   - QA_FLOWS.json → resolves the "smoke" test suite → gets ordered flow IDs
   - QA_ANCHOR_POINTS.json → gets all CSS selectors

3. Shell script BUILDS A MASSIVE PROMPT by:
   - Embedding ALL anchor points as JSON in the prompt
   - Resolving every flow in the suite to its steps
   - Appending instructions ("use these selectors", "take screenshots", etc.)

4. This prompt gets passed to:
   node node_modules/@rondah-ai/qa-agent/scripts/run-qa-ai-only.cjs \
     --url "$BASE_URL" --prompt "$PROMPT" --email "$EMAIL" --password "$PASSWORD"

5. run-qa-ai-only.cjs runs a SCREENSHOT→CLAUDE→ACTION loop:
   a. Takes a screenshot of the current page
   b. Sends screenshot + prompt + conversation history to Claude Sonnet 4.5
   c. Claude returns JSON: { type: "click", selector: "button[type='submit']" }
   d. Playwright executes the action
   e. Repeat up to 50 steps
   f. Claude eventually returns { type: "complete" }

6. Output: HTML report + JSON summary in qa-results/
```

### What this means in practice

- **Adding a new page to test**: Write 30-50 lines of JSON flow steps + update anchor points
- **Selector breaks**: AI sees the screenshot and guesses a new selector — sometimes right, sometimes wrong
- **Verification**: `verify` steps check `exists` or `visible` — binary. No before/after comparison.
- **Cost**: Every test run sends 10-50 screenshots to Claude API. A smoke run costs ~$0.50-2.00.
- **Speed**: Screenshot loop takes 15-30 seconds per flow (network round-trips to Claude API)
- **Reliability**: AI may interpret the same page differently across runs. Non-deterministic.
- **Debugging failures**: You get a screenshot and Claude's reasoning text. No structured data about what changed.

### Alternative path: scenario runner

```
./run-qa.sh local scenarios/call-logs-deep.md
```

Same as above, but instead of structured JSON flows, you write freeform markdown:
```markdown
## Test Call Logs
1. Login with {email} / {password}
2. Navigate to /home/call-logs
3. Verify the call logs table is visible
4. Click on the first row...
```

Same AI loop underneath. Same limitations.

---

## Smart System: How It Will Work

### What you have to write (once, or not at all)

**For smoke testing: NOTHING.**
```bash
npx qa-agent test --url https://app.example.com --email test@x.com --password pass123 --suite smoke
```

The agent crawls the site, recognizes patterns, runs smoke checks. Zero config files needed.

**For smoke testing with app-specific quirks: ONE optional file.**
```bash
npx qa-agent test --url https://app.example.com --suite smoke --instructions ./QA_INSTRUCTIONS.json
```

Instructions tell the agent things it can't infer: "skip billing page", "toasts take 3s", "ignore ResizeObserver errors". Structured JSON, not freeform prompts.

**For regression testing: ONE required file, ONE optional.**
```
qa-agent/
├── QA_FEATURE_MODEL.json        ← Describes features as capabilities (NOT step-by-step)
├── QA_INSTRUCTIONS.json         ← Optional: timing, scope, known issues, agent hints
└── configs/
    └── local.env.json           ← URL + credentials (same as before)
```

No more `QA_ANCHOR_POINTS.json`. No more `QA_FLOWS.json`. No more scenario markdown files. No more maintaining CSS selectors by hand.

### How a smoke test runs (smart)

```
1. You run: npx qa-agent test --url https://app.rondah.com --suite smoke \
             --email test@x.com --password pass123

2. Agent calls map_site tool:
   a. Navigates to login page
   b. Recognizes auth_form pattern (email input + password input + submit)
   c. Fills credentials, submits, waits for redirect
   d. BFS crawl from post-login page:
      - /home/dashboard → finds: nav_sidebar, card_grid
      - /home/call-logs → finds: nav_sidebar, data_table, search_filter, crud_page
      - /home/appointments → finds: nav_sidebar, data_table, crud_page
      - /home/configurations → finds: nav_sidebar, form_generic
      - ... (continues until maxPages reached)
   e. Per page, per pattern, runs smoke checks:
      - data_table: "table renders" ✓, "has header row" ✓, "has data or empty state" ✓
      - crud_page: "add button visible and clickable" ✓
      - nav_sidebar: "all nav links visible" ✓
      - etc.

3. Output:
   - Site model JSON (every page, its patterns, its links)
   - Smoke report (42 checks, 41 passed, 1 failed: "pagination not found on call-logs")
   - Screenshots per page

4. NO Claude API calls for smoke checks. All pattern matching and checks are
   deterministic Playwright queries. Cost: $0.00 for verification.
   (Claude is only used if you go beyond smoke into AI-driven interaction.)
```

### How a regression test runs (smart)

```
1. You run: npx qa-agent test --url https://app.rondah.com --suite regression \
             --feature call_logs --email test@x.com --password pass123

2. Agent calls load_qa_context → loads QA_FEATURE_MODEL.json

3. Agent calls compose_test("regression test call_logs"):
   a. Looks up call_logs in feature model
   b. Resolves dependencies: authenticated → call_logs.view_list → call_logs.filter →
      call_logs.view_detail → call_logs.search
   c. Returns ordered execution plan with checks per capability

4. Agent executes the plan:

   For authenticated:
     - Navigate to /auth/sign-in
     - scan_page → recognizes auth_form
     - Fill email, password, submit (AI-driven interaction)
     - verify_behavior: url_changed (away from /login), no_errors ✓

   For call_logs.view_list:
     - Navigate to /home/call-logs
     - scan_page → recognizes data_table, crud_page, search_filter
     - verify_behavior: element_appeared("tbody tr"), no_errors ✓

   For call_logs.filter:
     - verify_behavior capture_before (row count = 25)
     - AI clicks filter, selects criteria, applies
     - verify_behavior: element_count_changed("tbody tr") → 25→8 ✓
                        element_appeared(".filter-chip") ✓
                        no_errors ✓
     - Cleanup: clear filter

   For call_logs.view_detail:
     - verify_behavior capture_before
     - AI clicks first row
     - verify_behavior: url_changed ✓, text_appeared("Call Details") ✓
     - Navigate back

5. Output:
   - Structured report: 4 capabilities tested, 12 checks, 11 passed, 1 failed
   - Each check shows before/after values (debuggable)
   - Screenshots at key moments
```

### How the feature model differs from QA_FLOWS.json

**Legacy QA_FLOWS.json** — tells the agent exactly what to click:
```json
{
  "steps": [
    { "action": "navigate", "target": "/auth/sign-in" },
    { "action": "waitFor", "target": "input[type='email']", "state": "visible" },
    { "action": "fill", "target": "input[type='email']", "value": "{email}", "clearFirst": true },
    { "action": "fill", "target": "input[type='password']", "value": "{password}" },
    { "action": "click", "target": "button[type='submit']" },
    { "action": "waitFor", "target": "url", "condition": "contains:/home/" },
    { "action": "verify", "target": "nav", "state": "visible" }
  ]
}
```
7 steps. Hardcoded selectors. Breaks when DOM changes. No behavioral verification.

**Smart QA_FEATURE_MODEL.json** — tells the agent what success looks like:
```json
{
  "authentication": {
    "route": "/auth/sign-in",
    "requires": [],
    "capabilities": {
      "login": {
        "interaction": "fill email and password, submit the form",
        "expected": ["redirected to dashboard", "navigation sidebar visible"],
        "verify": {
          "url_changed": { "type": "url_changed" },
          "nav_visible": { "type": "custom_selector_visible", "selector": "nav" },
          "no_errors": { "type": "no_errors" }
        }
      }
    }
  }
}
```
No selectors. Agent finds them via pattern recognition. Verification checks are deterministic. Interaction is natural language — agent figures out the how.

---

## Side-by-Side: Legacy vs Smart

### Files you maintain

| | Legacy | Smart |
|---|--------|-------|
| **Smoke test** | QA_FLOWS.json (~200 lines for smoke suite) + QA_ANCHOR_POINTS.json (75 lines) | Nothing. Zero files. Optionally QA_INSTRUCTIONS.json for quirks. |
| **Regression** | QA_FLOWS.json (858 lines) + QA_ANCHOR_POINTS.json + scenarios/*.md | QA_FEATURE_MODEL.json (~100-150 lines) + optional QA_INSTRUCTIONS.json |
| **New page** | Write new flow (30-50 lines) + add selectors to anchors | Nothing for smoke. Add feature entry (10-15 lines) for regression. |
| **Selector broke** | Update QA_ANCHOR_POINTS.json manually | Nothing. Pattern library finds new selectors automatically. |
| **App-specific quirk** | Edit the shell script prompt or scenario markdown | Add to QA_INSTRUCTIONS.json: structured, validated, reusable |

### Running tests

| | Legacy | Smart |
|---|--------|-------|
| **Smoke** | `./run-flows.sh local smoke` | `npx qa-agent test --url $URL --suite smoke` |
| **Regression** | `./run-flows.sh local regression` | `npx qa-agent test --url $URL --suite regression --feature call_logs` |
| **Specific feature** | Edit QA_FLOWS.json suite to include specific flows | `--feature call_logs` or `--feature appointments` |
| **New page** | Write flow JSON first, then run | Just give it the URL: `--url https://app.com/new-page` |
| **CI/CD** | Same shell scripts in GitHub Actions | Same CLI commands in GitHub Actions |

### What happens when something breaks

| Scenario | Legacy | Smart |
|----------|--------|-------|
| **Button selector changed** | AI guesses from screenshot (may fail) | Pattern library tries multiple signals; falls back to AI only if all fail |
| **New column added to table** | No detection — flow doesn't check columns | scan_page reports new column in pattern details; smoke check still passes |
| **Filter returns wrong results** | `verify: "exists"` passes (table still exists) | `verify_behavior: element_count_changed` catches it (row count didn't change when filter applied) |
| **Page crashes with JS error** | AI sees error screen in screenshot, reports it in text | `no_errors` check catches `[role='alert']` elements; console error listener catches JS errors |
| **Success toast doesn't appear** | Not checked at all | `toast_appeared` check explicitly verifies it |
| **New page added to app** | Must write new flow + selectors before testing | map_site auto-discovers it on next crawl, runs smoke checks |

### Cost per run

| | Legacy | Smart (smoke) | Smart (regression) |
|---|--------|--------------|-------------------|
| **Claude API calls** | 10-50 per run (every action needs AI) | 0 (all deterministic) | 5-15 (only for interaction execution) |
| **Approximate cost** | $0.50-2.00 | $0.00 | $0.10-0.50 |
| **Time** | 15-30s per flow | 3-5s per page (smoke) | 10-15s per capability |

### What each system is good at

**Legacy is better when:**
- You need pixel-perfect step sequences (exact click order matters)
- You want full control over every interaction
- The app has unconventional UI that doesn't match standard patterns

**Smart is better when:**
- You want tests that survive DOM changes
- You want to test new pages without writing config
- You want verification that things *changed correctly*, not just *exist*
- You want zero-config smoke testing
- You want lower API costs
- You want deterministic, debuggable test results

### Migration path for existing qa-agent consumers

```
Phase 1-2: Keep using legacy flows. Smart tools available but optional.
           Try: npx qa-agent map-site --url $URL → see what it finds.
           Compare with your manual QA_ANCHOR_POINTS.json.

Phase 3:   Start adding verify_behavior checks to existing flows.
           Instead of verify: "exists", use verify_behavior with
           element_count_changed, text_appeared, etc.
           Old flows still work — this is additive.

Phase 4-5: Write QA_FEATURE_MODEL.json for your top 3 features.
           Keep QA_FLOWS.json for everything else.
           Gradually move features from flows to feature model.
           Delete QA_FLOWS entries as you migrate.

Phase 6:   Delete QA_ANCHOR_POINTS.json — pattern library replaces it.
           Delete migrated flows from QA_FLOWS.json.
           Keep QA_FLOWS.json only for edge cases the feature model can't express.

End state: QA_FEATURE_MODEL.json + credentials = full test coverage.
```

---

## Repos & How They Relate

```
opencode-dev/                          ← Development monorepo (where we write code)
  packages/opencode/src/
    tool/                              ← Tool source files (.ts + .txt)
    browser/manager.ts                 ← BrowserManager singleton
    agent/agent.ts                     ← Agent definitions & permissions
    qa/                                ← NEW: Pattern library, feature model, state snapshot

opencode/                              ← Published package (@rondah-ai/qa-agent)
  tools/                               ← Tool files (copied/built from opencode-dev)
  scripts/                             ← Runner scripts (run-qa-ai-only.cjs, etc.)
  browser/manager.ts                   ← BrowserManager
  bin/qa-agent.js                      ← CLI entry point
  index.js                             ← CLI router
  package.json                         ← v1.0.1, published to GitHub Packages

qa-agent/                              ← Consumer repo
  node_modules/@rondah-ai/qa-agent/    ← Installed package
  QA_ANCHOR_POINTS.json                ← Current selectors (being replaced)
  QA_FLOWS.json                        ← Current flows (being supplemented)
  QA_FEATURE_MODEL.json                ← NEW: Feature definitions (Phase 4)
  run-flows.sh                         ← Shell wrapper that invokes the package
```

### Development → Publishing → Consumption flow

```
1. Write code in opencode-dev/packages/opencode/src/
2. Build/copy to opencode/ (the publishable package)
3. Bump version in opencode/package.json
4. Push to main → GitHub Actions publishes to GitHub Packages
5. In qa-agent/: npm install @rondah-ai/qa-agent@latest
6. qa-agent consumers get the new tools
```

**Open question to resolve before Phase 1**: The opencode-dev repo has a proper TypeScript build system but the published opencode/ package ships raw .ts files with .cjs runners. We need to decide:
- Option A: Keep shipping .ts files and have runners import them directly (current approach)
- Option B: Add a build step that compiles opencode-dev → opencode dist/

This doc assumes Option A (no build step) for simplicity. If we go with Option B, the file paths in opencode/ change but the source paths in opencode-dev/ stay the same.

---

## Pre-Implementation Decisions

These must be resolved before writing any code:

### Decision 1: Snapshot capture strategy

**Problem**: `captureState()` takes `selectors: string[]` but at capture-before time, the agent hasn't declared its verification checks yet. The before-snapshot won't have counts for selectors it doesn't know about.

**Recommended approach**: Two-phase verification.
1. Agent declares checks *before* performing the action (the check list is known from the feature model's `verify` block or from the pattern's regression checks)
2. System extracts selectors from the check list, captures state for those selectors
3. Agent performs the action
4. System runs the checks against the before-snapshot

**Implementation**: `verify_behavior` accepts the full check list at capture-before time. The `action: "capture_before"` call includes the checks array (not empty). This way the snapshot captures exactly the selectors needed.

```
Step A: verify_behavior({ action: "capture_before", checks: [...full check list...] })
  → extracts selectors from checks → captures counts → returns snapshotId

Step B: agent performs the action

Step C: verify_behavior({ action: "applied filter", checks: [...same checks...], beforeSnapshot: "snap_xyz" })
  → runs checks against before snapshot
```

### Decision 2: Test data injection

**Problem**: Feature model has `test_data` but the spec doesn't show how it reaches the agent during interaction execution.

**Recommended approach**: `compose_test` includes `test_data` in its output alongside the capability plan. The agent's context includes this data when executing interactions.

```json
{
  "plan": [
    {
      "capability": "add_appointment",
      "interaction": "click Add → fill form → submit",
      "test_data": {
        "patient_name": "Test Patient",
        "date": "2026-04-01",
        "type": "Cleaning"
      },
      "checks": [...]
    }
  ]
}
```

### Decision 3: Console error listener setup

**Problem**: `StateSnapshot.consoleErrors` needs a listener attached before navigation.

**Recommended approach**: BrowserManager attaches a console error listener on page creation. Errors buffer into a module-level array. `captureState()` reads and clears the buffer.

```typescript
// In BrowserManager, when creating a page:
page.on('console', msg => {
  if (msg.type() === 'error') consoleErrorBuffer.push(msg.text())
})
```

### Decision 4: SPA link discovery

**Problem**: BFS crawl collects `<a href>` but SPAs may use client-side routing without real links.

**Recommended approach**: After collecting `<a href>` tags, also check for links extracted by the `nav_sidebar` pattern. If scan_page found a sidebar pattern, its `details.links` array feeds back into the crawl queue. This covers client-side routed nav items.

---

## Phase 0: Pattern Library

> **Goal**: Define ~8 UI patterns with recognition signals, smoke checks, and regression descriptions. Pure data + matching logic. No tools yet.

### Duration: 2-3 days

### Files to create

| File | Location (opencode-dev) | Location (opencode) | Purpose |
|------|------------------------|---------------------|---------|
| `patterns.ts` | `packages/opencode/src/qa/patterns.ts` | `qa/patterns.ts` | Pattern definitions, matchPatterns(), runSmokeCheck(), SMOKE_CHECK_MAP |
| `patterns.test.ts` | `packages/opencode/src/qa/__tests__/patterns.test.ts` | (not shipped) | Unit tests |

### Files to modify

None. Phase 0 is purely additive — a new module with no imports into existing code.

### What goes in `patterns.ts`

```
Exports:
  - UI_PATTERNS: Record<string, UIPattern>     — pattern definitions
  - matchPatterns(page, patterns)               — returns PatternMatch[]
  - extractPatternDetails(page, pattern)        — returns pattern-specific details
  - runSmokeCheck(page, checkName, pattern)     — runs one smoke check
  - SMOKE_CHECK_MAP                             — check name → Playwright assertion

Types:
  - UIPattern { recognize, smoke, regression, extract? }
  - PatternMatch { type, confidence, rootSelector, signalHits, totalSignals, details? }
```

### Patterns to implement (start with 8, expand later)

| # | Pattern | Recognition Signals | Smoke Checks |
|---|---------|-------------------|--------------|
| 1 | `auth_form` | `input[type='email']`, `input[type='password']`, `button[type='submit']` | form renders, inputs accept text, submit clickable |
| 2 | `data_table` | `table`, `thead th`, `tbody tr` | table renders, has header row, has data or empty state |
| 3 | `nav_sidebar` | `nav a[href]`, `aside nav`, `[role='navigation']` | navigation renders, all nav links visible |
| 4 | `crud_page` | `button:has-text('Add')` or `button:has-text('Create')`, `table`, `button[aria-label='Edit']` | add/create button visible, table renders |
| 5 | `form_generic` | `form`, `label`, `input`, `button[type='submit']` | form renders without errors, all inputs accept text, submit clickable |
| 6 | `search_filter` | `input[type='search']`, `input[placeholder*='search' i]`, `input[placeholder*='filter' i]` | search/filter input visible |
| 7 | `modal_dialog` | `[role='dialog']`, `dialog`, `[aria-modal='true']` | (smoke: N/A — modal must be triggered first) |
| 8 | `toast_notification` | `[role='alert']`, `[role='status']`, `[aria-live='polite']` | (smoke: N/A — toast is transient) |

### How to test Phase 0

**Unit tests** — mock Playwright page objects with known HTML:
```
Test 1: Page with <table><thead><tbody> → data_table matched, confidence > 0.5
Test 2: Page with email + password + submit → auth_form matched
Test 3: Page with <div><h1>Hello</h1></div> → no patterns match
Test 4: Page with table + Add button + Edit button → both data_table AND crud_page match
Test 5: SMOKE_CHECK_MAP["table renders"] runs on mock page → returns true/false correctly
```

**Manual validation** — after building, run `matchPatterns()` against the real Rondah app pages in a Node script to see if patterns match what you expect.

### Done when

- [ ] `patterns.ts` exports all 8 patterns with signals and smoke checks
- [ ] `matchPatterns()` returns sorted matches with confidence scores
- [ ] `SMOKE_CHECK_MAP` has a concrete Playwright assertion for every smoke check name
- [ ] All unit tests pass
- [ ] Manual run against Rondah login page returns `auth_form` match
- [ ] Manual run against Rondah call-logs page returns `data_table`, `nav_sidebar`, `crud_page`

---

## Phase 1: scan_page Tool

> **Goal**: Build the `scan_page` tool that visits a URL and returns recognized patterns, interactive elements, and outbound routes.

### Duration: 2-3 days

### Files to create

| File | Location (opencode-dev) | Location (opencode) | Purpose |
|------|------------------------|---------------------|---------|
| `scan_page.ts` | `packages/opencode/src/tool/scan_page.ts` | `tools/scan_page.ts` | Tool definition |
| `scan_page.txt` | `packages/opencode/src/tool/scan_page.txt` | `tools/scan_page.txt` | Tool description |

### Files to modify

| File | What changes |
|------|-------------|
| `tool/registry.ts` | Import `ScanPageTool`, add to `all()` array |
| `agent/agent.ts` | Add `"scan_page": "allow"` to QA agent permissions |

### Implementation steps

```
1. Create scan_page.ts following Tool.define() pattern:
   - Import: Tool, z, BrowserManager, matchPatterns, extractPatternDetails from qa/patterns
   - Parameters: url (string), waitFor (enum), screenshot (bool), timeout (number)
   - Execute logic:
     a. Get page from BrowserManager
     b. Navigate to url with waitFor strategy
     c. Wait for page stability (no pending network for 500ms)
     d. Run matchPatterns(page, UI_PATTERNS)
     e. For each match: run extractPatternDetails() to get specifics (column names, link lists, etc.)
     f. Collect outbound routes: page.locator('a[href]') same-origin links
     g. Collect interactive elements: buttons, inputs, selects with their labels/text
     h. If screenshot: save to .opencode/screenshots/scan/
     i. Return structured result with patterns, elements, routes

2. Create scan_page.txt — describe what the tool does, parameters, example usage

3. Register in registry.ts — add ScanPageTool to the all() array

4. Update agent permissions — allow scan_page for QA agent
```

### Dependencies

- Phase 0 must be complete (`patterns.ts` must exist)
- BrowserManager must be available (already exists)

### How to test Phase 1

**Unit test**: Mock page with known HTML → scan_page returns expected patterns and elements.

**Integration test**:
```
1. Start a local dev server (Rondah or any web app)
2. Call scan_page with the URL
3. Verify: patterns array is non-empty
4. Verify: interactiveElements has buttons and inputs
5. Verify: outboundRoutes contains known routes
6. Verify: screenshot saved to expected path
```

**Edge case tests**:
```
- URL that 404s → returns { success: false, error: "navigation_failed" }
- URL behind auth → returns { authRequired: true } (redirect to login detected)
- Static page with no patterns → returns { patterns: [], interactiveElements: {...} }
- Slow-loading SPA → waitFor: "networkidle" handles it
```

### Done when

- [ ] `scan_page` tool registered and callable
- [ ] Returns correct patterns for Rondah login page
- [ ] Returns correct patterns for Rondah call-logs page (data_table, nav_sidebar, crud_page)
- [ ] Screenshots save correctly
- [ ] Outbound routes collected from same-origin links
- [ ] Auth redirect detected
- [ ] All tests pass

---

## Phase 2: map_site Tool

> **Goal**: Build `map_site` — crawls from a root URL, calls scan_page logic on each page, runs smoke checks, produces a site model.

### Duration: 3-4 days

### Files to create

| File | Location (opencode-dev) | Location (opencode) | Purpose |
|------|------------------------|---------------------|---------|
| `map_site.ts` | `packages/opencode/src/tool/map_site.ts` | `tools/map_site.ts` | Tool definition |
| `map_site.txt` | `packages/opencode/src/tool/map_site.txt` | `tools/map_site.txt` | Tool description |

### Files to modify

| File | What changes |
|------|-------------|
| `tool/registry.ts` | Import `MapSiteTool`, add to `all()` array |
| `agent/agent.ts` | Add `"map_site": "allow"` to QA agent permissions |
| `browser/manager.ts` | Add console error listener on page creation (Decision 3) |

### Implementation steps

```
1. Add console error buffering to BrowserManager:
   - On page creation: page.on('console', msg => { if error, buffer it })
   - Export getConsoleErrors() and clearConsoleErrors()

2. Create map_site.ts following Tool.define() pattern:
   - Parameters: rootUrl, maxPages (default 20), loginUrl?, email?, password?,
                 excludePatterns (string[]), runSmoke (bool)
   - Execute logic:
     a. AUTH (if loginUrl provided):
        - Navigate to loginUrl
        - Use matchPatterns to find auth_form pattern
        - Fill email/password using pattern's extracted selectors
        - Click submit, wait for redirect away from /login
        - If still on login → return { success: false, error: "auth_failed" }

     b. BFS CRAWL:
        - visited = Set<string>()
        - queue = [rootUrl or post-login URL]
        - URL normalization: strip trailing slash, sort query params, remove hash
        - While queue has items AND visited.size < maxPages:
          * Shift URL from queue
          * Skip if visited or matches excludePatterns
          * Navigate to URL
          * Run scan_page logic internally (matchPatterns + extractPatternDetails)
          * Store result in siteModel[normalizedRoute]
          * Add outbound routes to queue (same-origin, not visited, not excluded)
          * ALSO add links from nav_sidebar pattern if found (Decision 4)
          * Wait 500ms between pages (rate limiting)

     c. SMOKE (if runSmoke):
        - For each page in siteModel:
          For each pattern found on page:
            For each smoke check in pattern.smoke:
              Run SMOKE_CHECK_MAP[checkName](page, pattern)
              Record pass/fail

     d. SAVE:
        - Save siteModel to .opencode/site-maps/site-model-{timestamp}.json
        - Save smokeReport to .opencode/site-maps/smoke-report-{timestamp}.json

     e. Return structured result with siteModel, navigation summary, smokeReport
```

### Key implementation details

**URL normalization** — prevents visiting the same page twice:
```typescript
function normalizeUrl(url: string): string {
  const u = new URL(url)
  u.hash = ""
  u.pathname = u.pathname.replace(/\/$/, "") || "/"
  u.searchParams.sort()
  return u.toString()
}
```

**Smoke checks run per-page** — after scanning all pages, navigate back to each page and run its pattern's smoke checks. This is sequential, not parallel (one browser, one page).

**Auth state persists** — BrowserManager keeps cookies/session across navigations, so login at step (a) carries through the entire crawl.

### How to test Phase 2

**Integration test (local app)**:
```
1. Start Rondah locally
2. Run map_site with rootUrl=http://localhost:3000, loginUrl, credentials
3. Verify: pagesScanned > 0
4. Verify: siteModel has entries for /login, /home/dashboard, /home/call-logs, etc.
5. Verify: each page entry has patterns array
6. Verify: smokeReport.totalChecks > 0
7. Verify: navigation.sidebarRoutes matches expected nav structure
```

**Edge case tests**:
```
- App with no auth → crawl starts directly from rootUrl
- maxPages=1 → only scans root page
- excludePatterns=["/settings"] → settings page skipped
- Dead link in nav → page fails to load, gets { success: false }, crawl continues
- Infinite redirect loop → detect URL not changing, skip after 3 attempts
```

**Performance test**:
```
- 15-page Rondah app should complete in < 90 seconds (including smoke)
- Site model JSON should be < 500KB
```

### Done when

- [ ] `map_site` registered and callable
- [ ] Login flow works with auth_form pattern recognition
- [ ] BFS crawl discovers all reachable pages
- [ ] nav_sidebar links feed into crawl queue
- [ ] Smoke checks run per pattern per page
- [ ] Site model saved to .opencode/site-maps/
- [ ] Smoke report saved with pass/fail per check
- [ ] Console error listener captures JS errors
- [ ] URL normalization prevents duplicate visits
- [ ] Full Rondah crawl + smoke completes in < 90 seconds

---

## Phase 3: verify_behavior Tool

> **Goal**: Build `verify_behavior` — captures before/after page state and runs 11 deterministic check types.

**Note**: This is the engineering spec's Phase 5, but we build it third because it provides immediate value when combined with existing flows — no feature model needed.

### Duration: 3-4 days

### Files to create

| File | Location (opencode-dev) | Location (opencode) | Purpose |
|------|------------------------|---------------------|---------|
| `state-snapshot.ts` | `packages/opencode/src/qa/state-snapshot.ts` | `qa/state-snapshot.ts` | StateSnapshot type, captureState(), check runners |
| `verify_behavior.ts` | `packages/opencode/src/tool/verify_behavior.ts` | `tools/verify_behavior.ts` | Tool definition |
| `verify_behavior.txt` | `packages/opencode/src/tool/verify_behavior.txt` | `tools/verify_behavior.txt` | Tool description |
| `verify-behavior.test.ts` | `packages/opencode/src/qa/__tests__/verify-behavior.test.ts` | (not shipped) | Unit tests |

### Files to modify

| File | What changes |
|------|-------------|
| `tool/registry.ts` | Import `VerifyBehaviorTool`, add to `all()` array |
| `agent/agent.ts` | Add `"verify_behavior": "allow"` to QA agent permissions |

### Implementation steps

```
1. Create state-snapshot.ts:
   - StateSnapshot interface: id, timestamp, url, elementCounts, visibleText, consoleErrors
   - captureState(page, selectors): capture counts for given selectors + url + visible text + console errors
   - 11 CHECK_RUNNERS (see engineering spec lines 620-734):
     element_count_changed, element_appeared, element_disappeared,
     text_appeared, text_disappeared, url_changed, no_errors,
     toast_appeared, count_equals, custom_selector_visible, custom_selector_hidden
   - Each runner: async (page, check, beforeSnapshot) → { passed, before?, after?, detail }

2. Create verify_behavior.ts following Tool.define() pattern:
   - Parameters:
     action: string (what was done, or "capture_before")
     checks: array of { name, type, selector?, value? }
     beforeSnapshot: string (optional snapshot ID)
   - Execute logic:
     If action === "capture_before":
       Extract selectors from checks array
       captureState(page, selectors)
       Store snapshot in module-level Map<string, StateSnapshot>
       Return { snapshotId }
     Else:
       Retrieve before snapshot from Map
       For each check: run CHECK_RUNNERS[check.type](page, check, beforeSnapshot)
       Return { passed, failed, total, checks: [...results] }

3. Snapshot storage:
   - Module-level Map<string, StateSnapshot> (in-memory only)
   - Snapshots are session-scoped — cleared when BrowserManager resets
   - Implement Decision 1: checks array required at capture-before time
```

### Key implementation details

**Two-phase call pattern** (Decision 1 resolved):
```
// Phase A — before the action:
verify_behavior({
  action: "capture_before",
  checks: [
    { name: "rows", type: "element_count_changed", selector: "tbody tr" },
    { name: "toast", type: "toast_appeared" }
  ]
})
→ captures elementCounts for "tbody tr" and toast selectors
→ returns { snapshotId: "snap_abc" }

// Agent performs action...

// Phase B — after the action:
verify_behavior({
  action: "applied filter",
  checks: [same checks as above],
  beforeSnapshot: "snap_abc"
})
→ compares current state against snapshot
→ returns pass/fail per check
```

**Visible text capture** — for text_appeared/text_disappeared checks:
```typescript
async function getVisibleTextSnippets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const texts: string[] = []
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim()
      if (text && text.length > 2 && text.length < 200) texts.push(text)
    }
    return texts.slice(0, 500) // cap at 500 snippets
  })
}
```

### How to test Phase 3

**Unit tests (mock page)**:
```
Test 1: element_count_changed — before: 5 rows, after: 3 rows → passed: true
Test 2: element_count_changed — before: 5 rows, after: 5 rows → passed: false (no change)
Test 3: element_appeared — before: 0, after: 1 → passed: true
Test 4: element_appeared — before: 1, after: 1 → passed: false (was already there)
Test 5: text_appeared — text "Success" on page → passed: true
Test 6: url_changed — URL different → passed: true
Test 7: no_errors — no error elements → passed: true
Test 8: no_errors — error alert on page → passed: false
Test 9: toast_appeared — [role='alert'] present → passed: true
Test 10: count_equals — 3 items, expected 3 → passed: true
Test 11: custom_selector_visible — element visible → passed: true
```

**Integration test (real app)**:
```
1. Navigate to call-logs page
2. capture_before with checks: [element_count_changed on "tbody tr"]
3. Apply a filter
4. verify_behavior → confirm row count changed
```

### Done when

- [ ] `verify_behavior` registered and callable
- [ ] Two-phase pattern works (capture_before → action → verify)
- [ ] All 11 check types implemented and tested
- [ ] Snapshot stored in memory, retrievable by ID
- [ ] Console errors captured from BrowserManager listener
- [ ] Each check returns { passed, before, after, detail } — fully debuggable
- [ ] All unit tests pass
- [ ] Integration test passes against Rondah app

---

## Phase 4: Feature Model & Loader

> **Goal**: Define the feature model schema, build the loader with Zod validation, implement dependency resolution via topological sort.

### Duration: 2-3 days

### Files to create

| File | Location (opencode-dev) | Location (opencode) | Purpose |
|------|------------------------|---------------------|---------|
| `feature-model.ts` | `packages/opencode/src/qa/feature-model.ts` | `qa/feature-model.ts` | Schema, loader, dependency resolver |
| `feature-model.test.ts` | `packages/opencode/src/qa/__tests__/feature-model.test.ts` | (not shipped) | Unit tests |

### Files to modify

| File | What changes |
|------|-------------|
| `tool/load_qa_context.ts` | Add feature model loading alongside flows/anchors. Accept `featureModelPath` parameter. Cache in QAContext. |

### Implementation steps

```
1. Create feature-model.ts:
   - Zod schemas: CapabilitySchema, FeatureSchema, FeatureModelSchema (per engineering spec)
   - loadFeatureModel(path): read file, validate with Zod, return typed object or throw
   - resolveCapabilities(features, requestedCapabilities):
     a. Build dependency graph from requires + preconditions
     b. Topological sort
     c. Return ordered list of capabilities to execute
   - getFeatureModel(): return cached model or null

2. Update load_qa_context.ts:
   - Add optional parameter: featureModelPath
   - If provided: load and validate QA_FEATURE_MODEL.json
   - Store in QAContext alongside existing anchorPoints and flows
   - Both old (flows/anchors) and new (feature model) can coexist

3. Create QA_FEATURE_MODEL.json for Rondah (in qa-agent repo):
   - Start with 2-3 features: authentication, call_logs, appointments
   - Each feature has route, requires, and capabilities
   - Include test_data for form fills
```

### Topological sort implementation

```typescript
function topologicalSort(features: FeatureModel["features"], requested: string[]): string[] {
  const visited = new Set<string>()
  const sorted: string[] = []

  function visit(name: string) {
    if (visited.has(name)) return
    visited.add(name)
    const feature = features[name]
    if (!feature) return
    for (const dep of feature.requires) {
      visit(dep) // visit dependencies first
    }
    sorted.push(name)
  }

  for (const name of requested) visit(name)
  return sorted
}
```

### How to test Phase 4

**Unit tests**:
```
Test 1: Valid feature model → loads without error
Test 2: Missing required field → Zod throws with clear message
Test 3: Dependency resolution: [call_logs] → [authenticated, call_logs] (login first)
Test 4: Circular dependency → throws with cycle path
Test 5: Unknown feature requested → throws with available features list
Test 6: Capabilities within a feature resolve in precondition order
```

**Integration test**:
```
1. Write QA_FEATURE_MODEL.json for Rondah
2. Load via load_qa_context with featureModelPath
3. Verify: model loads, all features validated
4. Verify: resolveCapabilities("call_logs") returns [authenticated, view_list, ...]
```

### Done when

- [ ] Feature model schema defined with Zod
- [ ] Loader validates and caches the model
- [ ] Topological sort resolves feature dependencies correctly
- [ ] Circular dependency detection works
- [ ] load_qa_context accepts and loads feature model
- [ ] QA_FEATURE_MODEL.json written for Rondah (auth + call_logs + appointments)
- [ ] All unit tests pass

---

## Phase 5: Intent Composer (compose_test v2)

> **Goal**: Rewrite `compose_test` to parse natural language intent, resolve dependencies from the feature model, and output an ordered capability plan with checks and test data.

### Duration: 3-4 days

### Files to modify

| File | What changes |
|------|-------------|
| `tool/compose_test.ts` | Major rewrite: add intent parsing, feature model integration, dependency resolution. **Keep backward compatibility** — if no feature model loaded, fall back to current keyword matching. |
| `tool/compose_test.txt` | Update description to reflect new capabilities |
| `tool/execute_flow.ts` | Add capability-based execution mode alongside step-based |
| `tool/execute_flow.txt` | Update description |

### Implementation steps

```
1. Rewrite compose_test.ts:

   BACKWARD COMPATIBLE PATH (no feature model):
   - Current keyword matching logic stays
   - Triggered when getFeatureModel() returns null
   - Existing QA_FLOWS.json consumers unaffected

   NEW PATH (feature model loaded):
   a. Parse intent from description:
      - Extract target features (match against feature model keys)
      - Extract actions (CRUD verbs, "smoke", "regression")
      - Extract suite type if specified
      - If explicit capabilities/features params provided → skip AI parsing, use directly

   b. Resolve dependencies:
      - Call resolveCapabilities() from feature-model.ts
      - Get ordered list: [shared.authenticated, call_logs.view_list, call_logs.filter, ...]

   c. Build execution plan:
      For each capability in order:
        - Include: feature name, capability name, route, interaction, expected outcomes
        - Include: verify checks (mapped to verify_behavior check types)
        - Include: test_data from feature model (Decision 2)
        - Include: cleanup steps if defined
        - Include: edge_cases if regression suite requested

   d. Return structured plan (not execute — compose only)

2. Update execute_flow.ts:

   ADD capability-based execution mode:
   - New parameter: mode = "step" | "capability" (default: "step")
   - Step mode: existing flow step execution (unchanged)
   - Capability mode:
     a. Receive plan from compose_test output
     b. For each capability:
        1. scan_page on the capability's route (if first visit)
        2. verify_behavior capture_before
        3. Agent performs interaction (AI-driven, using selectors from scan)
        4. verify_behavior check after
        5. Run cleanup if defined
     c. Collect results, return summary
```

### Intent parsing approach

```
Option A (simple — start here): Keyword extraction + feature model lookup
  - Split description into tokens
  - Match tokens against feature model keys and capability names
  - Match "smoke", "regression", "crud", "full" against suite types
  - No AI needed for this step

Option B (later — if needed): Claude intent parsing
  - Send description + available features list to Claude
  - Claude returns { features: [...], capabilities: [...], suite: "..." }
  - Bypass entirely when explicit params provided (CI usage)
```

**Start with Option A. Move to Option B only if keyword matching proves insufficient for natural language input.**

### How to test Phase 5

**Unit tests**:
```
Test 1: "smoke test call_logs" → resolves to [authenticated, call_logs.view_list] with smoke checks
Test 2: "regression test appointments" → resolves full capability chain with edge cases
Test 3: "test CRUD for call_logs" → resolves add, view, edit, delete capabilities in order
Test 4: No feature model loaded → falls back to keyword matching (backward compat)
Test 5: Explicit capabilities param → uses those directly, no parsing
Test 6: Unknown feature name → returns error with available features
```

**Integration test**:
```
1. Load feature model for Rondah
2. compose_test("regression test call_logs")
3. Verify: plan has correct capability order
4. Verify: each capability has checks, test_data, cleanup
5. Execute the plan against running Rondah app
6. Verify: verify_behavior checks pass
```

### Done when

- [ ] compose_test v2 works with feature model when available
- [ ] Falls back to keyword matching when feature model not loaded
- [ ] Dependency resolution produces correct execution order
- [ ] Test data included in plan output
- [ ] execute_flow supports capability mode
- [ ] End-to-end: compose + execute + verify works for a Rondah feature
- [ ] All existing tests still pass (backward compat)

---

## Phase 6: Knowledge Evolution

> **Goal**: Extend the knowledge base to store discovered patterns, features, and selector fallbacks across runs.

### Duration: 2-3 days

### Files to modify

| File | What changes |
|------|-------------|
| `hybrid/types.ts` | Add types for feature knowledge entries, pattern knowledge entries |
| `hybrid/knowledge-manager.ts` | Add storage for: discovered patterns per page, selector fallback history, feature test results |

### Implementation steps

```
1. Extend knowledge types:
   - PatternKnowledge: { route, patterns: PatternMatch[], lastScanned, smokeResults }
   - FeatureKnowledge: { feature, capability, lastTested, result, duration }
   - SelectorKnowledge: { original, fallback, page, lastUsed, successRate }

2. After map_site runs: store pattern knowledge per page
3. After verify_behavior runs: store feature test results
4. After resolve_selector finds a fallback: store selector knowledge
5. On next run: load knowledge to:
   - Skip re-scanning pages that haven't changed (compare with cached patterns)
   - Prioritize known-good selectors
   - Flag features that failed last run
```

### How to test Phase 6

```
Test 1: Run map_site twice → second run loads cached knowledge, skips unchanged pages
Test 2: Selector fallback stored → next run uses fallback directly
Test 3: Feature test result stored → accessible in next session
```

### Done when

- [ ] Knowledge base stores pattern, feature, and selector data
- [ ] Subsequent runs benefit from cached knowledge
- [ ] Knowledge doesn't grow unbounded (prune old entries)

---

## QA Instructions File (QA_INSTRUCTIONS.json)

> **Goal**: Give users a structured way to provide context, constraints, and app-specific quirks to the agent — without going back to freeform prompts.

### Why this matters

The smart agent discovers a lot on its own (patterns, routes, elements). But there are things it **can't** infer from the DOM:

- "The billing page is under construction — skip it"
- "Success toasts take 3 seconds to appear in this app"
- "We use `<x-button>` custom elements, not `<button>`"
- "Don't test delete operations on production data"
- "The sidebar collapses on mobile viewport — test at 1920px"
- "After creating a record, wait 2s for the webhook to fire before verifying"

Without an instructions layer, users would either:
1. Hack the pattern library (wrong — it should stay app-agnostic)
2. Overload the feature model with operational concerns (wrong — it should describe features, not agent behavior)
3. Pass CLI flags for every quirk (doesn't scale)

### Design: structured, not freeform

This is NOT a return to the legacy prompt system. The legacy system dumped a massive text prompt into Claude and let AI interpret everything. Instructions here are **machine-parsed JSON** that tools read directly. The agent doesn't "interpret" them — it applies them as rules.

### File: `QA_INSTRUCTIONS.json`

Lives in the consumer repo (qa-agent/) alongside QA_FEATURE_MODEL.json.

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
      "button": "x-button, button",
      "input": "x-input input, input"
    }
  },

  "scope": {
    "exclude_routes": [
      "/home/billing",
      "/home/admin-hub/*",
      "/api/*"
    ],
    "exclude_capabilities": [
      "*.delete"
    ],
    "include_only": null,
    "max_pages": 20
  },

  "timing": {
    "slow_transitions": [
      { "after": "form_submit", "wait": 2000, "reason": "webhook processing" },
      { "after": "delete_confirm", "wait": 1500, "reason": "cascade delete" }
    ],
    "toast_appear_delay": 3000,
    "page_load_buffer": 1000
  },

  "known_issues": [
    {
      "page": "/home/call-logs",
      "issue": "pagination_missing",
      "action": "skip_check",
      "reason": "Pagination not implemented yet — ticket RONDAH-234"
    },
    {
      "page": "/home/configurations",
      "issue": "console_error",
      "pattern": "ResizeObserver loop",
      "action": "ignore",
      "reason": "Benign browser warning, not a real error"
    }
  ],

  "auth": {
    "strategy": "form",
    "session_duration": "30m",
    "reauth_on_redirect": true,
    "mfa": false
  },

  "environment_overrides": {
    "production": {
      "scope": {
        "exclude_capabilities": ["*.delete", "*.create"],
        "exclude_routes": ["/home/billing", "/home/admin-hub/*"]
      }
    },
    "staging": {
      "global": {
        "defaultTimeout": 15000
      }
    }
  },

  "agent_hints": [
    "After login, the first page load is slow (~3s) because of data hydration",
    "The date picker uses react-day-picker — click the day number directly, not the cell",
    "Table sorting requires clicking the column header text, not the sort icon"
  ]
}
```

### How each section is consumed by tools

| Section | Consumed by | How |
|---------|------------|-----|
| `global.viewport` | BrowserManager | Sets viewport on page creation |
| `global.defaultTimeout` | All tools | Override default navigation/action timeout |
| `global.waitAfterAction` | execute_flow, verify_behavior | Delay between action and verification |
| `global.customSelectors` | patterns.ts | Extend pattern signals with app-specific element names |
| `global.screenshotsOn` | All tools | When to auto-capture screenshots |
| `scope.exclude_routes` | map_site | Skip these routes during crawl |
| `scope.exclude_capabilities` | compose_test | Remove capabilities from execution plan (e.g., `*.delete` excludes all delete ops) |
| `scope.include_only` | compose_test | If set, ONLY test these features/capabilities |
| `scope.max_pages` | map_site | Override default page limit |
| `timing.slow_transitions` | verify_behavior | Wait longer after specific action types before checking state |
| `timing.toast_appear_delay` | verify_behavior (toast_appeared) | Use `waitForSelector` with this timeout instead of instant check |
| `known_issues` | map_site, verify_behavior | Skip specific checks or ignore specific errors. Prevents known bugs from failing the run. |
| `auth` | map_site | How to authenticate (form, token, cookie injection) and when to re-auth |
| `environment_overrides` | All tools | Merge over top-level sections when running in a specific environment |
| `agent_hints` | compose_test, execute_flow | Injected into agent context as supplementary instructions. This is the ONLY freeform text — kept minimal and specific. |

### What goes where: Instructions vs Feature Model vs Pattern Library

| Concern | Where it lives | Why |
|---------|---------------|-----|
| "What features does the app have?" | QA_FEATURE_MODEL.json | Describes capabilities and expected outcomes |
| "What UI patterns exist?" | patterns.ts (code) | App-agnostic recognition logic |
| "Skip billing page" | QA_INSTRUCTIONS.json → scope | Operational constraint, not a feature definition |
| "Toasts take 3s" | QA_INSTRUCTIONS.json → timing | App-specific timing, not a pattern property |
| "Ignore ResizeObserver error" | QA_INSTRUCTIONS.json → known_issues | Known noise, not a test failure |
| "Don't delete on production" | QA_INSTRUCTIONS.json → environment_overrides | Environment-specific safety rule |
| "Date picker needs special handling" | QA_INSTRUCTIONS.json → agent_hints | App-specific interaction quirk |
| "Button selector is `x-button`" | QA_INSTRUCTIONS.json → global.customSelectors | App-specific DOM convention |

### Does this make the agent more flexible or more limited?

**Both — and that's the point.**

It makes the agent **more flexible** by:
- Letting it handle app-specific quirks without pattern library changes
- Supporting per-environment behavior (safe on production, full CRUD on staging)
- Allowing known issues to be tracked without failing runs
- Giving timing hints that prevent false failures on slow apps

It makes the agent **more focused** by:
- Scoping what to test and what to skip (exclude_routes, exclude_capabilities)
- Preventing destructive operations in sensitive environments
- Replacing vague freeform prompts with machine-parsed rules

The key distinction from the legacy system: **instructions are guardrails, not scripts**. They tell the agent what to avoid and what to account for — they don't tell it what to click.

### Implementation

This is a cross-cutting concern, not a separate phase. It gets built incrementally:

| Phase | What gets added |
|-------|----------------|
| Phase 1 (scan_page) | `global.viewport`, `global.defaultTimeout`, `global.customSelectors` |
| Phase 2 (map_site) | `scope.exclude_routes`, `scope.max_pages`, `auth`, `known_issues` (ignore errors) |
| Phase 3 (verify_behavior) | `timing.*`, `known_issues` (skip checks), `global.waitAfterAction` |
| Phase 4 (feature model) | Load instructions alongside feature model in `load_qa_context` |
| Phase 5 (compose_test) | `scope.exclude_capabilities`, `scope.include_only`, `agent_hints`, `environment_overrides` |

### Files to create / modify

| File | Change |
|------|--------|
| `qa/instructions.ts` (NEW) | Zod schema, loader, getter. Validates at load time. |
| `tool/load_qa_context.ts` | Accept `instructionsPath` parameter. Cache in QAContext. |
| `qa/patterns.ts` | Read `global.customSelectors` to extend pattern signals |
| `browser/manager.ts` | Read `global.viewport` to set page viewport |
| `tool/scan_page.ts` | Read `global.defaultTimeout` |
| `tool/map_site.ts` | Read `scope.exclude_routes`, `scope.max_pages`, `auth`, `known_issues` |
| `tool/verify_behavior.ts` | Read `timing.*`, `known_issues`, `global.waitAfterAction` |
| `tool/compose_test.ts` | Read `scope.exclude_capabilities`, `scope.include_only`, `agent_hints` |

### Validation

Instructions file is validated at load time with Zod — same as the feature model. If a section is missing, defaults are used. If a field has wrong type, you get a clear error before any tests run.

```typescript
const InstructionsSchema = z.object({
  version: z.string(),
  global: z.object({
    viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1920, height: 1080 }),
    defaultTimeout: z.number().default(10000),
    waitAfterAction: z.number().default(500),
    toastTimeout: z.number().default(3000),
    screenshotsOn: z.array(z.string()).default(["failure"]),
    customSelectors: z.record(z.string()).default({}),
  }).default({}),
  scope: z.object({
    exclude_routes: z.array(z.string()).default([]),
    exclude_capabilities: z.array(z.string()).default([]),
    include_only: z.array(z.string()).nullable().default(null),
    max_pages: z.number().default(20),
  }).default({}),
  timing: z.object({
    slow_transitions: z.array(z.object({
      after: z.string(),
      wait: z.number(),
      reason: z.string().optional(),
    })).default([]),
    toast_appear_delay: z.number().default(3000),
    page_load_buffer: z.number().default(0),
  }).default({}),
  known_issues: z.array(z.object({
    page: z.string(),
    issue: z.string(),
    pattern: z.string().optional(),
    action: z.enum(["skip_check", "ignore", "warn"]),
    reason: z.string(),
  })).default([]),
  auth: z.object({
    strategy: z.enum(["form", "token", "cookie"]).default("form"),
    session_duration: z.string().default("30m"),
    reauth_on_redirect: z.boolean().default(true),
    mfa: z.boolean().default(false),
  }).default({}),
  environment_overrides: z.record(z.any()).default({}),
  agent_hints: z.array(z.string()).default([]),
}).strict()
```

Every field has a default. The file itself is optional — if missing, all defaults apply. Zero config still works.

### CLI usage

```bash
# With instructions:
npx qa-agent test --url $URL --suite smoke --instructions ./QA_INSTRUCTIONS.json

# Without (all defaults):
npx qa-agent test --url $URL --suite smoke

# With environment override:
npx qa-agent test --url $URL --suite regression --instructions ./QA_INSTRUCTIONS.json --env production
```

When `--env production` is passed, `environment_overrides.production` is deep-merged over the top-level sections before the run starts.

---

## Generating Config Files

> Nobody should write these files from scratch. Init builds the skeleton, learn refines it through iteration.

### The problem

Even though QA_FEATURE_MODEL.json is simpler than QA_FLOWS.json (100 lines vs 858 lines), writing JSON by hand is still tedious and error-prone. And QA_INSTRUCTIONS.json has fields you wouldn't know to fill until you've actually run the agent against your app.

### The solution: init → learn → learn → learn

The workflow is always the same:

```
1. init    — agent scans your app, drafts a feature model skeleton (breadth)
2. learn   — you walk through the app, agent observes and upgrades the model (depth)
3. learn   — you walk through again, agent refines and fills gaps
4. learn   — final pass, model stabilizes
```

Each learn session makes the feature model better. The AI compares what it observes against what's already in the model and improves it. After 3-4 iterations, the model converges — you'll see the "no changes" message and know it's solid.

```bash
# Step 1: Scan for skeleton
npx qa-agent init --url https://app.example.com --email test@x.com --password pass123

# Step 2-4: Walk through and refine (repeat until stable)
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123

# Also available:
npx qa-agent migrate --flows ./QA_FLOWS.json --anchors ./QA_ANCHOR_POINTS.json  # legacy migration
```

---

### Step 1: `qa-agent init` — Build the skeleton

> Agent scans every page, recognizes patterns, drafts a feature model with capabilities it can infer from the DOM. Fast, broad, but shallow.

This runs `map_site` under the hood — crawls the full app, recognizes patterns, and uses deterministic pattern→capability mapping to generate a first-pass feature model.

#### What it produces

```
npx qa-agent init --url https://app.rondah.com --email test@x.com --password pass123

  Scanning... 12 pages found
  Patterns recognized: auth_form, data_table (x4), nav_sidebar, crud_page (x3),
                        search_filter (x2), form_generic (x2)

  Generated: ./QA_FEATURE_MODEL.json
  Generated: ./QA_INSTRUCTIONS.json

  Feature model summary:
    authentication    — 2 capabilities (login, login_invalid)
    call_logs         — 4 capabilities (view_list, filter, search, sort)       ← inferred from data_table + search_filter
    appointments      — 5 capabilities (view_list, create, edit, delete, search) ← inferred from crud_page
    configurations    — 2 capabilities (view_form, submit_form)                 ← inferred from form_generic
    voicemails        — 1 capability  (view_list)                               ← inferred from data_table
    ...

  Quality: ██░░░░░░░░ SKELETON
    ✓ All pages discovered
    ✓ Patterns recognized
    ✗ Interactions are guesses (not observed)
    ✗ Verify checks are generic defaults
    ✗ Test data is placeholder TODOs
    ✗ No cleanup steps
    ✗ No edge cases

  → Run 'npx qa-agent learn' to improve this model
```

The skeleton is immediately usable for **smoke testing** (pattern-based checks don't need interaction details). But for **regression testing**, the interactions and verify checks need to be sharpened — that's what learn does.

#### What the skeleton looks like

```json
{
  "version": "1.0",
  "meta": {
    "generated_by": "init",
    "learn_sessions": 0,
    "confidence": "skeleton"
  },
  "features": {
    "call_logs": {
      "description": "Call logs management",
      "route": "/home/call-logs",
      "requires": ["authenticated"],
      "capabilities": {
        "view_list": {
          "interaction": "navigate to call logs page",
          "expected": ["table with records visible"],
          "verify": {
            "table_visible": { "type": "custom_selector_visible", "selector": "table" },
            "has_rows": { "type": "element_appeared", "selector": "tbody tr" }
          },
          "_confidence": "init",
          "_observed": 0
        },
        "filter": {
          "preconditions": ["view_list"],
          "interaction": "use filter controls to narrow results",
          "expected": ["table rows change"],
          "verify": {
            "rows_changed": { "type": "element_count_changed", "selector": "tbody tr" }
          },
          "test_data": { "filter_value": "TODO" },
          "_confidence": "init",
          "_observed": 0
        }
      }
    }
  }
}
```

Notice the `_confidence` and `_observed` fields — these track how the capability was generated and how many times it's been observed in learn sessions. Init sets `_confidence: "init"` and `_observed: 0`. Learn upgrades these.

---

### Step 2-4: `qa-agent learn` — Iterative refinement

> You use the app. The agent watches. Each session improves the feature model.

Learn mode always reads the existing QA_FEATURE_MODEL.json first. It doesn't start from scratch — it **improves what's already there**.

#### How it works

```
npx qa-agent learn --url https://app.rondah.com --email test@x.com --password pass123

┌────────────────────────────────────────────────────────────────┐
│  QA Agent — Learn Mode (Session #1)                            │
│                                                                │
│  Loaded: QA_FEATURE_MODEL.json (5 features, 14 capabilities)  │
│  Browser opened at https://app.rondah.com                      │
│                                                                │
│  Walk through your app. The agent is watching.                 │
│                                                                │
│  Commands:                                                     │
│    [Enter]  Mark this action as a capability                   │
│    [n]      Name/rename the current capability                 │
│    [e]      Mark as edge case for the last capability          │
│    [s]      Skip — don't record this interaction               │
│    [d]      Done — finish session and merge into model         │
│                                                                │
│  Capabilities to improve (low confidence):                     │
│    • call_logs.filter — interaction is a guess, needs real data │
│    • appointments.create — no test data, no cleanup            │
│    • appointments.delete — never observed                      │
│                                                                │
│  Status: Watching...                                           │
└────────────────────────────────────────────────────────────────┘
```

The agent opens a **visible browser**. You use the app. Behind the scenes:

```
For every page you visit:
  1. scan_page runs silently → records patterns, elements, route

For every interaction you perform (click, type, submit):
  2. Agent captures state BEFORE (URL, element counts, visible text)
  3. You perform the action naturally
  4. Agent captures state AFTER
  5. Agent records:
     - What changed (rows appeared, URL changed, toast showed, modal opened)
     - What you interacted with (selector, element type, text content)
     - What page you were on
     - The actual values you typed (test data capture)
```

When you press [Enter]:
```
  6. Agent checks: does this match an existing capability in the model?

     IF YES (capability already exists):
       → UPGRADE it:
         - Replace guessed interaction with observed interaction
         - Add/refine verify checks based on actual state changes
         - Capture real test_data from what you typed
         - Detect cleanup if you undo the action afterward
         - Increment _observed counter
         - Upgrade _confidence from "init" → "observed_1x"

     IF NO (new capability):
       → ADD it to the appropriate feature
         - Auto-detect which feature based on current route
         - Build interaction from observed events
         - Build verify checks from state diff
         - Set _confidence: "observed_1x", _observed: 1
```

#### What changes per learn session

**Session 1 — The happy path walkthrough:**
You walk through the main features: login, view call logs, apply a filter, create an appointment, etc. This replaces init's guesses with observed reality.

```
Before learn #1:
  call_logs.filter:
    interaction: "use filter controls to narrow results"     ← guessed
    verify: { rows_changed: element_count_changed }          ← generic
    test_data: { filter_value: "TODO" }                      ← placeholder
    _confidence: "init"
    _observed: 0

After learn #1:
  call_logs.filter:
    interaction: "click Filter button, select 'Completed' from status dropdown, click Apply"  ← observed
    verify: {
      rows_changed: { type: "element_count_changed", selector: "tbody tr" },      ← confirmed
      filter_chip: { type: "element_appeared", selector: ".filter-chip" },          ← NEW: discovered
      no_errors: { type: "no_errors" }                                              ← NEW: added
    }
    test_data: { filter_value: "Completed" }                 ← real value
    cleanup: "click Clear Filters button"                    ← observed
    _confidence: "observed_1x"
    _observed: 1
```

**Session 2 — Alternative paths and deeper coverage:**
You walk through the same features but take different paths: use a different filter, try the search, use keyboard navigation, test with empty results.

```
After learn #2:
  call_logs.filter:
    interaction: "click Filter button, select criteria from status dropdown, click Apply"  ← generalized
    verify: {
      rows_changed: { type: "element_count_changed", selector: "tbody tr" },
      filter_chip: { type: "element_appeared", selector: ".filter-chip" },
      no_errors: { type: "no_errors" },
      url_updated: { type: "url_changed" }                                          ← NEW: discovered in session 2
    }
    test_data: {
      filter_value: ["Completed", "Missed"]                   ← expanded: multiple values seen
    }
    cleanup: "click Clear Filters button"
    _confidence: "observed_2x"
    _observed: 2

  NEW capability discovered:
  call_logs.filter_empty_results:
    interaction: "apply filter that returns no results"
    verify: {
      empty_state: { type: "element_appeared", selector: ".empty-state, :text('No results')" },
      no_errors: { type: "no_errors" }
    }
    _confidence: "observed_1x"
    _observed: 1
```

**Session 3 — Edge cases and negative tests:**
You deliberately break things: submit empty forms, use invalid data, test error states.

```
After learn #3:
  NEW capabilities:
  call_logs.filter → edge_cases:
    - "apply filter with no criteria selected → shows validation message"
    - "apply filter while table is loading → waits for load, then filters"

  appointments.create → edge_cases:
    - "submit with empty required fields → shows validation errors"
    - "submit with past date → shows date validation error"
    - "cancel during creation → no record created, returns to list"

  _confidence: "observed_3x"
  _observed: 3
```

**Session 4 — Stability check:**
If you walk through and the agent says "no changes detected for 8/10 capabilities" — the model is stable. You're done.

```
After learn #4:
  ═══════════════════════════════════════════════════════
  Session complete. Model comparison:

  Unchanged:     8 capabilities (already solid)
  Refined:       2 capabilities (minor verify check updates)
  New:           0 capabilities
  Confidence:    observed_4x for 10 capabilities

  Model status: ██████████ STABLE
  Ready for regression testing.
  ═══════════════════════════════════════════════════════
```

#### Confidence levels

| Level | Meaning | How it's reached |
|-------|---------|-----------------|
| `init` | Guessed from DOM patterns | `qa-agent init` generated it |
| `migrated` | Converted from legacy flows | `qa-agent migrate` generated it |
| `observed_1x` | Seen once in learn session | One learn session confirmed it |
| `observed_2x` | Seen twice, interaction consistent | Two learn sessions, same behavior |
| `observed_3x+` | Stable — interaction and checks consistent across sessions | Three+ sessions, model converged |
| `edge_cased` | Has edge cases recorded | User demoed edge cases in learn mode |

The agent uses confidence to guide the user during learn sessions:
```
Capabilities to improve (low confidence):
  • call_logs.sort — _confidence: init, never observed
  • appointments.delete — _confidence: observed_1x, no edge cases
  • voicemails.view_list — _confidence: init, never observed

Capabilities that are solid (no action needed):
  • authentication.login — _confidence: observed_3x
  • call_logs.filter — _confidence: observed_3x, edge_cased
```

#### Merge logic — how learn updates the model

When a learn session ends, the agent merges observations into QA_FEATURE_MODEL.json:

```
For each capability observed during the session:

  1. MATCH: Find the existing capability by route + interaction similarity
     - Same route + similar actions → same capability
     - Same route + different actions → new capability
     - New route not in model → new feature

  2. MERGE interaction description:
     - If init guess: REPLACE with observed
     - If already observed: GENERALIZE
       Session 1: "select 'Completed' from status dropdown"
       Session 2: "select 'Missed' from status dropdown"
       Merged:    "select criteria from status dropdown"
       (specific values move to test_data)

  3. MERGE verify checks:
     - UNION all checks seen across sessions
     - If a check passed in session 1 but wasn't seen in session 2: KEEP it
     - If a check FAILED in a session: FLAG it for review (don't auto-remove)
     - New state changes → new checks added

  4. MERGE test_data:
     - Collect all values seen across sessions into arrays
     - Password fields always stored as "$TEST_PASSWORD" reference
     - Email fields stored as "$TEST_EMAIL" or actual test email

  5. MERGE edge_cases:
     - Append new edge cases from [e] key presses
     - Include observed verify checks for each edge case

  6. UPDATE metadata:
     - Increment _observed counter
     - Update _confidence level
     - Record session timestamp
```

#### What the model looks like after 3 learn sessions

```json
{
  "version": "1.0",
  "meta": {
    "generated_by": "init",
    "learn_sessions": 3,
    "last_session": "2026-03-16T14:30:00Z",
    "confidence": "stable"
  },
  "features": {
    "call_logs": {
      "description": "View and manage call logs",
      "route": "/home/call-logs",
      "requires": ["authenticated"],
      "capabilities": {
        "view_list": {
          "preconditions": [],
          "interaction": "navigate to call logs page",
          "expected": ["table with call records visible", "column headers: Date, From, To, Duration, Status"],
          "verify": {
            "table_visible": { "type": "custom_selector_visible", "selector": "table" },
            "has_rows": { "type": "element_appeared", "selector": "tbody tr" },
            "has_headers": { "type": "custom_selector_visible", "selector": "thead th" },
            "no_errors": { "type": "no_errors" }
          },
          "_confidence": "observed_3x",
          "_observed": 3
        },
        "filter": {
          "preconditions": ["view_list"],
          "interaction": "click Filter button, select criteria from status dropdown, click Apply",
          "expected": ["table rows change to match filter", "filter chip appears", "URL updates with query params"],
          "verify": {
            "rows_changed": { "type": "element_count_changed", "selector": "tbody tr" },
            "filter_chip": { "type": "element_appeared", "selector": ".filter-chip" },
            "url_updated": { "type": "url_changed" },
            "no_errors": { "type": "no_errors" }
          },
          "test_data": {
            "filter_options": ["Completed", "Missed", "Voicemail"]
          },
          "cleanup": "click Clear Filters button",
          "edge_cases": [
            {
              "name": "empty_results",
              "interaction": "apply filter that returns no matching records",
              "verify": {
                "empty_state": { "type": "element_appeared", "selector": ".empty-state, :text('No results')" }
              }
            },
            {
              "name": "clear_filter",
              "interaction": "click Clear Filters after applying a filter",
              "verify": {
                "rows_restored": { "type": "element_count_changed", "selector": "tbody tr" },
                "chip_removed": { "type": "element_disappeared", "selector": ".filter-chip" }
              }
            }
          ],
          "_confidence": "observed_3x",
          "_observed": 3
        },
        "search": {
          "preconditions": ["view_list"],
          "interaction": "type search term in search input, wait for results to update",
          "expected": ["table rows filtered to match search term"],
          "verify": {
            "rows_changed": { "type": "element_count_changed", "selector": "tbody tr" },
            "no_errors": { "type": "no_errors" }
          },
          "test_data": {
            "search_terms": ["John", "555"]
          },
          "cleanup": "clear search input",
          "_confidence": "observed_2x",
          "_observed": 2
        }
      }
    }
  }
}
```

#### Terminal output during learn — what you see

```
Session #2 — Walking through call_logs

  You clicked: button:has-text("Filter")
  You clicked: [data-testid="status-select"]
  You clicked: option:has-text("Missed")
  You clicked: button:has-text("Apply")

  State changes detected:
    tbody tr: 25 → 12
    .filter-chip: 0 → 1
    URL: /home/call-logs → /home/call-logs?status=missed

  Press [Enter] to record, [s] to skip

You: [Enter]

  ✓ UPGRADED: call_logs.filter (was observed_1x → now observed_2x)
    + verify.url_updated: url_changed                          ← NEW check
    + test_data.filter_options: added "Missed"                 ← NEW value
    ~ interaction: generalized "Completed" → "criteria"        ← REFINED

  Capabilities still needing attention:
    • call_logs.sort — never observed
    • appointments.delete — observed_1x, no edge cases

You: Click column header "Date" to sort

  State changes detected:
    tbody tr order changed (first row text different)
    th.sorted-asc appeared

You: [Enter]

  ✓ UPGRADED: call_logs.sort (was init → now observed_1x)
    Replaced: guessed interaction with observed
    + verify.sort_indicator: element_appeared("th.sorted-asc")  ← discovered

  Remaining low-confidence:
    • appointments.delete — observed_1x, no edge cases
```

#### How learn handles the instructions file

Learn mode also auto-updates QA_INSTRUCTIONS.json as it observes your usage:

```
Session observations → instructions updates:

  Detected: page transition took 2.8s after form submit
    → timing.slow_transitions: [{ after: "form_submit", wait: 3000 }]

  Detected: console warning "ResizeObserver loop" on /home/configurations
    → known_issues: [{ page: "/home/configurations", pattern: "ResizeObserver", action: "ignore" }]

  Detected: you waited 3s for toast to appear
    → timing.toast_appear_delay: 3000

  Detected: you navigated to /home/admin-hub but got redirected to 403
    → scope.exclude_routes: ["/home/admin-hub/*"]
```

These are proposed changes — shown at the end of the session for you to approve or reject.

#### Session persistence

```bash
# Sessions auto-save every 30 seconds to .qa-learn-session.json
# If browser crashes or you need a break:
npx qa-agent learn --url $URL --resume

# View session history:
npx qa-agent learn --history
  Session #1: 2026-03-16 10:00 — 8 capabilities recorded, 19 checks
  Session #2: 2026-03-16 14:00 — 3 capabilities upgraded, 2 new checks
  Session #3: 2026-03-16 16:00 — 1 edge case added, model stable
```

#### Technical implementation

```
Components:
  1. Non-headless browser launch (Playwright: headless: false)
  2. Event listeners injected into the page to capture user interactions:
     - click events → what was clicked (selector, text, element type)
     - input events → what was typed (field, value)
     - submit events → form submissions
     - navigation events → page changes (popstate, pushState)
  3. State snapshots before/after each significant interaction
  4. Terminal UI for user commands ([Enter], [n], [e], [s], [d])
  5. Session recorder that accumulates interactions → capabilities
  6. Merge engine that compares observations against existing model
  7. Feature model writer that outputs the updated JSON

New files:
  - scripts/learn.js            — CLI command and terminal UI
  - qa/session-recorder.ts      — accumulates events, groups into capabilities
  - qa/interaction-tracker.ts   — injects page listeners, captures events
  - qa/model-merger.ts          — compares observations with existing model, merges

Phase built: After Phase 3 (needs scan_page + state snapshots + verify_behavior)
```

#### Event capture — what gets injected into the page

```typescript
// Injected into the browser page via page.evaluate()
// Captures user interactions without interfering with app behavior

window.__qaTracker = {
  events: [],

  init() {
    // Track clicks
    document.addEventListener('click', (e) => {
      const target = e.target.closest('button, a, input, [role="button"], [onclick]')
      if (!target) return
      this.events.push({
        type: 'click',
        timestamp: Date.now(),
        selector: this.getSelector(target),
        text: target.textContent?.trim().slice(0, 100),
        tag: target.tagName.toLowerCase(),
        url: window.location.href,
      })
    }, { capture: true })

    // Track input
    document.addEventListener('input', (e) => {
      const target = e.target
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      this.events.push({
        type: 'input',
        timestamp: Date.now(),
        selector: this.getSelector(target),
        value: target.type === 'password' ? '***' : target.value,
        field: target.placeholder || target.name || target.id || 'unknown',
        url: window.location.href,
      })
    }, { capture: true })

    // Track navigation
    const pushState = history.pushState
    history.pushState = function() {
      pushState.apply(this, arguments)
      window.__qaTracker.events.push({
        type: 'navigation',
        timestamp: Date.now(),
        url: window.location.href,
      })
    }
  },

  getSelector(el) {
    if (el.id) return `#${el.id}`
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`
    if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`
    if (['BUTTON', 'A'].includes(el.tagName)) {
      const text = el.textContent?.trim()
      if (text && text.length < 50) return `${el.tagName.toLowerCase()}:has-text("${text}")`
    }
    return this.cssPath(el)
  },

  flush() {
    const events = [...this.events]
    this.events = []
    return events
  }
}

window.__qaTracker.init()
```

Node.js polls `page.evaluate(() => window.__qaTracker.flush())` every 500ms.

#### Password and sensitive data handling

- Password inputs captured as `***` — never stored in the feature model
- Feature model references environment variables: `"password": "$TEST_PASSWORD"`
- Email values stored as-is (test accounts)
- Fields with `type="password"` or `autocomplete="new-password"` are always redacted

---

### Command 1: `qa-agent init` — Generate feature model from live app

**This is the primary onboarding path.** You point the agent at your app, it scans every page, and drafts a feature model.

#### What happens

```
npx qa-agent init --url https://app.rondah.com --email test@x.com --password pass123

Step 1: map_site (deterministic)
  ├── Login with credentials
  ├── BFS crawl all pages
  ├── scan_page on each page → recognize patterns
  └── Output: site model with pages, patterns, elements, routes

Step 2: Draft feature model (AI-assisted — single Claude call)
  ├── Input: the full site model from step 1
  ├── Claude sees: "these are the pages, these are the patterns on each page,
  │   these are the interactive elements, these are the routes"
  ├── Claude drafts a QA_FEATURE_MODEL.json:
  │   - One feature per page/section that has meaningful patterns
  │   - Capabilities inferred from patterns:
  │     data_table → view_list, filter, sort, pagination
  │     crud_page → create, read, update, delete
  │     auth_form → login, login_invalid
  │     search_filter → search, clear_search
  │   - Dependencies inferred from routes:
  │     All /home/* pages → requires: ["authenticated"]
  │   - Verify checks inferred from patterns:
  │     data_table → element_count_changed, no_errors
  │     crud_page → element_appeared, toast_appeared
  │   - Test data left as placeholders:
  │     "test_data": { "patient_name": "TODO", "date": "TODO" }
  └── Output: QA_FEATURE_MODEL.json written to current directory

Step 3: Print summary
  Found 12 pages, 8 features, 23 capabilities
  Generated: ./QA_FEATURE_MODEL.json

  Review TODOs:
    - 4 test_data fields need real values (search for "TODO")
    - call_logs.filter: verify the filter interaction description
    - configurations: multiple sub-pages detected, check grouping

  Next steps:
    1. Open QA_FEATURE_MODEL.json and review
    2. Fill in TODO test data values
    3. Run: npx qa-agent test --url $URL --suite smoke
```

#### What the generated feature model looks like

```json
{
  "version": "1.0",
  "features": {
    "authentication": {
      "description": "User login and session management",
      "route": "/auth/sign-in",
      "requires": [],
      "capabilities": {
        "login": {
          "interaction": "fill email and password fields, click submit",
          "expected": ["redirect to /home/dashboard", "sidebar navigation visible"],
          "verify": {
            "redirected": { "type": "url_changed" },
            "nav_visible": { "type": "custom_selector_visible", "selector": "nav" },
            "no_errors": { "type": "no_errors" }
          }
        },
        "login_invalid": {
          "interaction": "fill invalid credentials, click submit",
          "expected": ["error message appears", "stays on login page"],
          "verify": {
            "error_shown": { "type": "element_appeared", "selector": "[role='alert'], .text-red-500" },
            "still_on_login": { "type": "url_changed" }
          },
          "test_data": {
            "email": "invalid@example.com",
            "password": "wrongpassword"
          }
        }
      }
    },
    "call_logs": {
      "description": "View and manage call logs",
      "route": "/home/call-logs",
      "requires": ["authenticated"],
      "capabilities": {
        "view_list": {
          "preconditions": [],
          "interaction": "navigate to call logs page",
          "expected": ["table with call records visible", "column headers present"],
          "verify": {
            "table_visible": { "type": "custom_selector_visible", "selector": "table" },
            "has_rows": { "type": "element_appeared", "selector": "tbody tr" },
            "no_errors": { "type": "no_errors" }
          }
        },
        "filter": {
          "preconditions": ["view_list"],
          "interaction": "click filter controls, select criteria, apply filter",
          "expected": ["table rows change", "filter indicator visible"],
          "verify": {
            "rows_changed": { "type": "element_count_changed", "selector": "tbody tr" },
            "no_errors": { "type": "no_errors" }
          },
          "cleanup": "clear all filters"
        },
        "search": {
          "preconditions": ["view_list"],
          "interaction": "type search term in search input",
          "expected": ["table rows filtered to match search"],
          "verify": {
            "rows_changed": { "type": "element_count_changed", "selector": "tbody tr" },
            "no_errors": { "type": "no_errors" }
          },
          "cleanup": "clear search input",
          "test_data": {
            "search_term": "TODO"
          }
        }
      }
    }
  },
  "shared": {
    "authenticated": {
      "how": "fill email and password on login page, submit form",
      "verify": "URL contains /home/",
      "route": "/auth/sign-in"
    }
  }
}
```

#### Why this works

- **Pattern → capability mapping is deterministic.** If scan_page found `data_table`, we know to generate `view_list`, `filter`, `sort` capabilities. If it found `crud_page`, we generate `create`, `read`, `update`, `delete`. No guessing.
- **Verify checks come from patterns too.** A `data_table` capability always gets `element_count_changed` on `tbody tr`. A `crud_page.create` always gets `element_appeared` + `toast_appeared`. These mappings are in the pattern library.
- **AI is only used for:** writing natural language interaction descriptions, inferring dependencies between features, and grouping pages into logical features. These are things a human would write anyway — AI just drafts them faster.
- **The output is reviewable JSON.** Not hidden in a database. You open the file, read it, fix the TODOs, and you're done. Version-controlled alongside your code.

#### Pattern → capability mapping table

This is hardcoded in the generator, not AI-inferred:

| Pattern found | Capabilities generated | Default verify checks |
|--------------|----------------------|----------------------|
| `auth_form` | login, login_invalid | url_changed, no_errors, element_appeared (for error) |
| `data_table` | view_list, sort, pagination | custom_selector_visible(table), element_appeared(tbody tr), element_count_changed |
| `crud_page` | create, view_detail, edit, delete | element_appeared, element_disappeared, toast_appeared, no_errors |
| `search_filter` | search, clear_search | element_count_changed, no_errors |
| `form_generic` | submit_form, submit_invalid | toast_appeared, no_errors, element_appeared (for validation) |
| `nav_sidebar` | (no capabilities — structural) | — |
| `modal_dialog` | (generated as sub-capability of crud) | element_appeared([role='dialog']), element_disappeared |
| `tab_panel` | switch_tabs | custom_selector_visible (tab content) |
| `card_grid` | view_cards | custom_selector_visible, element_appeared |

---

### Command 2: `qa-agent init --instructions` — Generate instructions from scan results

**Run this after your first `map_site` or after a failed test run.** It analyzes what happened and drafts sensible defaults.

#### What happens

```
npx qa-agent init --url https://app.rondah.com --instructions \
  --email test@x.com --password pass123

Step 1: map_site (if no cached site model, run a fresh scan)

Step 2: Analyze scan results for instruction-worthy findings:

  Detected: toast elements use [data-sonner-toast] (non-standard)
    → timing.toast_appear_delay: 3000
    → global.customSelectors.toast: "[data-sonner-toast], [role='status']"

  Detected: /home/admin-hub pages require different auth (403 response)
    → scope.exclude_routes: ["/home/admin-hub/*"]

  Detected: console errors on /home/configurations → "ResizeObserver loop"
    → known_issues: [{ page: "/home/configurations", pattern: "ResizeObserver",
                       action: "ignore", reason: "benign browser warning" }]

  Detected: slow page transitions (> 2s between navigations)
    → timing.page_load_buffer: 1500

  Detected: 22 pages reachable
    → scope.max_pages: 25

Step 3: Write QA_INSTRUCTIONS.json with detected values + safe defaults

Step 4: Print summary
  Generated: ./QA_INSTRUCTIONS.json

  Auto-detected:
    - 1 custom selector override (toast elements)
    - 1 excluded route pattern (/home/admin-hub/*)
    - 1 known issue (ResizeObserver on configurations)
    - Slow transitions detected — added 1500ms page load buffer

  Review:
    - Check scope.exclude_routes — add any routes you don't want tested
    - Check known_issues — add bugs from your tracker
    - Add agent_hints for any interaction quirks you know about
```

#### What the generated instructions file looks like

```json
{
  "version": "1.0",
  "global": {
    "viewport": { "width": 1920, "height": 1080 },
    "defaultTimeout": 10000,
    "waitAfterAction": 500,
    "toastTimeout": 3000,
    "screenshotsOn": ["failure", "capability_complete"],
    "customSelectors": {
      "toast": "[data-sonner-toast], [role='status']"
    }
  },
  "scope": {
    "exclude_routes": ["/home/admin-hub/*", "/api/*"],
    "exclude_capabilities": [],
    "include_only": null,
    "max_pages": 25
  },
  "timing": {
    "slow_transitions": [],
    "toast_appear_delay": 3000,
    "page_load_buffer": 1500
  },
  "known_issues": [
    {
      "page": "/home/configurations",
      "issue": "console_error",
      "pattern": "ResizeObserver loop",
      "action": "ignore",
      "reason": "Benign browser warning — not a real error"
    }
  ],
  "auth": {
    "strategy": "form",
    "session_duration": "30m",
    "reauth_on_redirect": true,
    "mfa": false
  },
  "environment_overrides": {
    "production": {
      "scope": {
        "exclude_capabilities": ["*.delete", "*.create"]
      }
    }
  },
  "agent_hints": []
}
```

#### What gets auto-detected vs what you fill in manually

| Field | Auto-detected | Manual |
|-------|:---:|:---:|
| `global.viewport` | Default 1920x1080 | Change if testing responsive |
| `global.customSelectors` | Yes — from non-standard elements in scan | Add more as needed |
| `scope.exclude_routes` | Yes — from 403s, error pages, admin areas | Add pages under construction |
| `scope.exclude_capabilities` | No | Add per environment (e.g., no deletes on prod) |
| `timing.toast_appear_delay` | Yes — measured from scan | Adjust if too fast/slow |
| `timing.page_load_buffer` | Yes — measured from navigation timings | Adjust based on app performance |
| `known_issues` | Yes — from console errors, missing elements | Add bugs from your tracker |
| `environment_overrides` | Scaffold with sensible prod defaults | Customize per environment |
| `agent_hints` | No — these are human knowledge | Add interaction quirks you know about |

---

### Command 3: `qa-agent migrate` — Convert legacy flows to feature model

**For existing qa-agent users who already have QA_FLOWS.json and QA_ANCHOR_POINTS.json.**

#### What happens

```
npx qa-agent migrate --flows ./QA_FLOWS.json --anchors ./QA_ANCHOR_POINTS.json

Step 1: Parse QA_FLOWS.json
  ├── Read all flow categories: authentication, callLogs, appointmentTypes, etc.
  ├── Read all atomic flows with their steps
  ├── Read composite flows and their sub-flow references
  └── Read test suites: smoke, criticalPath, regression

Step 2: Parse QA_ANCHOR_POINTS.json
  ├── Read route mappings
  ├── Read selector groups per feature area
  └── Map selectors to flow steps

Step 3: Convert flows → features (deterministic transformation)

  For each flow category:
    → Create a feature with the category name
    → Set route from anchor points routes mapping
    → Set requires from flow prerequisites

  For each atomic flow in a category:
    → Create a capability
    → Convert step sequence to natural language interaction:
      [fill email, fill password, click submit] → "fill email and password, submit form"
    → Convert verify steps to verify checks:
      { action: "verify", target: "nav", state: "visible" }
        → { type: "custom_selector_visible", selector: "nav" }
      { action: "waitFor", target: "url", condition: "contains:/home/" }
        → { type: "url_changed" }
    → Convert requiredParams to test_data with placeholder values
    → Set priority from flow priority field

  For composite flows:
    → Convert to capability with preconditions referencing sub-flows

Step 4: Write QA_FEATURE_MODEL.json

Step 5: Print migration report
  Migrated:
    - 5 flow categories → 5 features
    - 18 atomic flows → 18 capabilities
    - 4 composite flows → 4 capabilities with preconditions
    - 12 verify steps → 12 typed checks (8 exact, 4 approximate)

  Manual review needed:
    - callLogs.filter: interaction description is generic — refine if needed
    - appointments.create: test_data has placeholder values — fill in real data
    - 4 verify checks converted as custom_selector_visible — could be more specific

  Files written:
    - ./QA_FEATURE_MODEL.json (generated)
    - ./QA_FEATURE_MODEL.migration-notes.md (review guide)

  Legacy files NOT deleted. Both systems work in parallel.
```

#### Flow step → verify check conversion table

| Legacy verify step | Smart verify check |
|---|---|
| `{ action: "verify", target: "nav", state: "visible" }` | `{ type: "custom_selector_visible", selector: "nav" }` |
| `{ action: "verify", target: "table", state: "visible" }` | `{ type: "custom_selector_visible", selector: "table" }` |
| `{ action: "waitFor", target: "url", condition: "contains:/home/" }` | `{ type: "url_changed" }` |
| `{ action: "verify", target: "tbody tr", state: "visible" }` | `{ type: "element_appeared", selector: "tbody tr" }` |
| `{ action: "verify", target: ".error", state: "visible" }` | `{ type: "element_appeared", selector: ".error" }` |
| `{ action: "verify", target: "[role='dialog']", state: "hidden" }` | `{ type: "custom_selector_hidden", selector: "[role='dialog']" }` |

#### Flow steps → interaction description conversion

```
Input (legacy steps):
  { action: "navigate", target: "/auth/sign-in" }
  { action: "fill", target: "input[type='email']", value: "{email}" }
  { action: "fill", target: "input[type='password']", value: "{password}" }
  { action: "click", target: "button[type='submit']" }

Output (smart interaction):
  "navigate to /auth/sign-in, fill email and password fields, click submit button"
```

This conversion is deterministic — action types map to verbs:
- `navigate` → "navigate to {target}"
- `fill` → "fill {field description}"
- `click` → "click {element description}"
- `waitFor` → (omitted — implicit in smart system)
- `verify` → (moved to verify checks, not interaction)

---

### The full onboarding workflow

There's one path. Init then learn. The only variation is how many learn sessions you do.

```bash
# ── Day 1: Skeleton + First Walk ──────────────────────────────────

# 1. Build the skeleton (60 seconds, automated)
npx qa-agent init --url https://app.example.com --email test@x.com --password pass123
# → QA_FEATURE_MODEL.json (skeleton — guessed interactions, generic checks)
# → QA_INSTRUCTIONS.json (auto-detected timing + quirks)

# 2. First learn session — happy path (5-10 min)
#    Walk through login, main features, basic CRUD
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → Model upgraded: guesses replaced with observed interactions
# → Quality: ████░░░░░░ OBSERVED_1X

# 3. Smoke tests work now (zero interaction needed — pattern-based)
npx qa-agent test --url https://app.example.com --suite smoke

# ── Day 1 or 2: Refine ───────────────────────────────────────────

# 4. Second learn session — alternative paths (5-10 min)
#    Use different filter values, try search, use keyboard nav
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → Model refined: interactions generalized, test_data expanded, new checks added
# → Quality: ██████░░░░ OBSERVED_2X

# 5. Regression tests should work now
npx qa-agent test --url https://app.example.com --suite regression

# ── Day 2 or 3: Edge cases ───────────────────────────────────────

# 6. Third learn session — break things (5-10 min)
#    Empty forms, invalid data, cancel flows, error states
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → Model enriched: edge cases added, negative tests captured
# → Quality: ████████░░ OBSERVED_3X + EDGE_CASED

# ── Optional: Final stability check ──────────────────────────────

# 7. Fourth learn session — confirm stability
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → "No changes detected for 12/14 capabilities — model is stable"
# → Quality: ██████████ STABLE
```

**Total time across all sessions: ~30-40 minutes of actually using your app.** Not writing JSON. Not maintaining selectors. Just using the app like a normal user while the agent builds your entire test suite.

#### For existing qa-agent users (has QA_FLOWS.json)

```bash
# Start with migrate instead of init — same learn loop after
npx qa-agent migrate --flows ./QA_FLOWS.json --anchors ./QA_ANCHOR_POINTS.json
# → QA_FEATURE_MODEL.json (converted from flows, _confidence: "migrated")

# Then learn to upgrade migrated capabilities with real observations
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → Migrated capabilities upgraded to observed_2x
# → Legacy flows/anchors no longer needed
```

#### Adding a new feature later

```bash
# You built a new page in the app. One learn session adds it to the model.
npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
# → Navigate to the new page, demo the feature
# → Agent adds new feature + capabilities to existing model
# → Existing features untouched
```

#### What each session focuses on

| Session | Focus | What you do | What the model gains |
|---------|-------|------------|---------------------|
| **init** | Breadth | Nothing (automated) | All pages, all patterns, skeleton capabilities |
| **learn #1** | Happy paths | Login, main features, basic flows | Real interactions, real verify checks, real test data |
| **learn #2** | Alternative paths | Different inputs, different routes to same features | Generalized interactions, expanded test data, new checks |
| **learn #3** | Edge cases | Empty forms, invalid data, cancel, error states | Edge case array, negative test capabilities |
| **learn #4** | Stability | Same as #1 | Confirmation that model is converged |

---

### Implementation: where these commands live

| Command | Tool/Script | Phase built | New files |
|---------|------------|-------------|-----------|
| `qa-agent init` | `bin/qa-agent.js` + `scripts/init.js` | After Phase 2 (needs map_site) | `scripts/init.js` |
| `qa-agent learn` | `bin/qa-agent.js` + `scripts/learn.js` | After Phase 3 (needs scan_page + state snapshots) | `qa/session-recorder.ts`, `qa/interaction-tracker.ts`, `qa/model-merger.ts`, `scripts/learn.js` |
| `qa-agent migrate` | `bin/qa-agent.js` + `scripts/migrate.js` | After Phase 4 (needs feature model schema) | `scripts/migrate.js` |

#### `scripts/init.js` — what it does

```
1. Run map_site internally → get site model
2. Apply pattern → capability mapping (deterministic, from table above)
3. For each page in site model:
   a. Group by feature area (pages under same parent route = same feature)
   b. For each pattern on page → generate capabilities
   c. For each capability → generate verify checks from pattern defaults
   d. Infer dependencies from route structure (/home/* → requires authenticated)
4. Call Claude ONCE with:
   Input: site model + generated capability skeleton
   Task: "Write natural language interaction descriptions for each capability.
          Group related pages into features. Infer feature dependencies."
   Output: completed QA_FEATURE_MODEL.json
5. Write file, print summary with TODOs
```

**AI usage: exactly ONE Claude call** for the entire generation. Everything else is deterministic. The AI call costs ~$0.02-0.05 (small input, structured output).

#### `scripts/migrate.js` — what it does

```
1. Parse QA_FLOWS.json and QA_ANCHOR_POINTS.json
2. For each flow category → create feature
3. For each flow → create capability:
   a. Steps → interaction description (deterministic verb mapping)
   b. Verify steps → verify checks (deterministic type mapping)
   c. requiredParams → test_data with TODO values
   d. prerequisite flows → preconditions
   e. priority → kept as-is
4. Write QA_FEATURE_MODEL.json
5. Write migration-notes.md with items to review
```

**AI usage: ZERO.** The entire migration is deterministic. Flow steps map to interaction verbs. Verify steps map to check types. No AI needed.

---

### Keeping files in sync as the app changes

After initial generation, the feature model and instructions need updates when the app changes. Three approaches:

#### 1. Re-scan and diff (recommended)

```bash
# Run periodically or after deploy:
npx qa-agent init --url $URL --diff

# Compares new scan against existing QA_FEATURE_MODEL.json:
  New pages found:
    + /home/messages (patterns: data_table, search_filter)
    → Suggested: add messages feature with view_list, search capabilities

  Pages removed:
    - /home/reports (no longer reachable)
    → Suggested: remove reports feature

  Pattern changes:
    /home/call-logs: crud_page confidence dropped 0.80 → 0.40 (Edit button removed?)
    → Suggested: review call_logs.edit capability

  No changes needed:
    /home/dashboard, /home/appointments, /auth/sign-in (all stable)
```

Outputs a diff report. Doesn't overwrite your files — you decide what to apply.

#### 2. CI check (automated)

```yaml
# In GitHub Actions — after deploy:
- name: Check QA model freshness
  run: |
    npx qa-agent init --url $PREVIEW_URL --diff --json > qa-diff.json
    if [ $(jq '.newPages | length' qa-diff.json) -gt 0 ]; then
      echo "::warning::New pages detected — QA_FEATURE_MODEL.json may need updating"
    fi
```

#### 3. Manual (just re-run init)

```bash
# Regenerate and manually merge:
npx qa-agent init --url $URL --output ./QA_FEATURE_MODEL.new.json
diff QA_FEATURE_MODEL.json QA_FEATURE_MODEL.new.json
```

---

## Publishing & Consumer Updates

After each phase ships, the changes need to reach the qa-agent consumer:

### Per-phase publishing checklist

```
1. Verify all tests pass in opencode-dev
2. Copy/build changed files to opencode/ package directory
3. Bump version in opencode/package.json:
   - Phase 0+1: 1.1.0 (minor — new feature: scan_page)
   - Phase 2: 1.2.0 (minor — new feature: map_site)
   - Phase 3: 1.3.0 (minor — new feature: verify_behavior)
   - Phase 4: 1.4.0 (minor — new feature: feature model)
   - Phase 5: 1.5.0 (minor — compose_test v2)
   - Phase 6: 1.6.0 (minor — knowledge evolution)
4. Push to main → GitHub Actions publishes
5. In qa-agent: npm install @rondah-ai/qa-agent@latest
6. Test in qa-agent: run existing smoke suite → still passes (backward compat)
7. Test new features: run new tools against Rondah
```

### Consumer-side changes per phase

| Phase | Changes in qa-agent repo |
|-------|--------------------------|
| 0+1 | None required. scan_page available but optional. |
| 2 | None required. Can start using `npx qa-agent test --url ... --suite smoke` with zero config. |
| 3 | None required. verify_behavior available for use in flows. |
| 4 | Create `QA_FEATURE_MODEL.json`. Update `load_qa_context` calls to include it. |
| 5 | Update run-flows.sh to use new compose_test params. Old scripts still work. |
| 6 | None required. Knowledge builds automatically. |

---

## Testing Strategy Per Phase

### Test pyramid for each phase

```
                    ┌─────────────────┐
                    │   Manual QA     │  Run against real Rondah app
                    │   (per phase)   │  Verify patterns match, smoke passes
                    ├─────────────────┤
                    │  Integration    │  Real Playwright + mock HTML pages
                    │  (per tool)     │  Test full tool execute() flow
                    ├─────────────────┤
                    │   Unit Tests    │  Mock page objects, test pure logic
                    │  (per module)   │  Patterns, checks, dependency resolution
                    └─────────────────┘
```

### Test file locations

```
packages/opencode/src/qa/__tests__/
  patterns.test.ts              ← Phase 0
  state-snapshot.test.ts        ← Phase 3 (verify checks)
  feature-model.test.ts         ← Phase 4 (dependency resolution)

packages/opencode/src/tool/__tests__/
  scan_page.test.ts             ← Phase 1
  map_site.test.ts              ← Phase 2
  verify_behavior.test.ts       ← Phase 3
  compose_test.test.ts          ← Phase 5 (backward compat + new path)
```

### Regression gate

Before publishing any phase, run:
```bash
# Existing smoke suite must still pass
./run-flows.sh local smoke

# New tests must pass
npm test

# Manual: scan_page on Rondah login + dashboard + call-logs → patterns make sense
```

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Pattern signals don't match Rondah's actual DOM | Medium | High | Test against real app in Phase 0 before building tools. Iterate signals. |
| 2 | BFS crawl misses SPA routes | Low | Medium | nav_sidebar pattern feeds links into crawl (Decision 4). Manual fallback: add routes to excludePatterns inverted list. |
| 3 | Smoke checks too generic (false passes) | Medium | Medium | Start strict. A check that always passes is useless. Better to have fewer checks that mean something. |
| 4 | verify_behavior snapshot timing (stale state) | Low | Low | Snapshots capture in <100ms. Minimize window between capture and action. |
| 5 | Feature model authoring is tedious | Medium | Medium | Phase 4 includes auto-generation from map_site results. User reviews and refines, not writes from scratch. |
| 6 | compose_test keyword parsing misses intent | Medium | Low | Always allow explicit capabilities param to bypass parsing. AI fallback (Option B) available if needed. |
| 7 | opencode → opencode package copy step is error-prone | High | High | Needs to be resolved in pre-implementation. Either automate the copy or add a build step. |
| 8 | Breaking existing qa-agent consumers | Low | High | Every phase is backward compatible. Old flows/anchors continue working. New features are opt-in. Regression gate before every publish. |

---

## Timeline Summary

| Phase | What | Duration | Cumulative | Publish Version |
|-------|------|----------|------------|----------------|
| 0 | Pattern Library | 2-3 days | Week 1 | — (internal module) |
| 1 | scan_page | 2-3 days | Week 1-2 | 1.1.0 |
| 2 | map_site + smoke | 3-4 days | Week 2-3 | 1.2.0 |
| 2.5 | `qa-agent init` command | 2 days | Week 3 | 1.2.1 |
| 3 | verify_behavior | 3-4 days | Week 3-4 | 1.3.0 |
| 3.5 | `qa-agent learn` command | 3-4 days | Week 4-5 | 1.3.1 |
| 4 | Feature model + loader | 2-3 days | Week 5 | 1.4.0 |
| 4.5 | `qa-agent migrate` command | 1-2 days | Week 5-6 | 1.4.1 |
| 5 | compose_test v2 + execute | 3-4 days | Week 6 | 1.5.0 |
| 5.5 | QA Instructions integration | 1-2 days | Week 6-7 | 1.5.1 |
| 6 | Knowledge evolution | 2-3 days | Week 7 | 1.6.0 |
| **Total** | | **24-34 days** | **~7 weeks** | **1.6.0** |

### Milestone checkpoints

```
End of Week 2:  "Give it a URL, it tells you what's on every page"
                → scan_page + map_site working. Zero-config smoke test possible.

End of Week 3:  "Generate a feature model skeleton automatically"
                → qa-agent init works. One command → QA_FEATURE_MODEL.json drafted.

End of Week 4:  "Tests verify behavior, not just existence"
                → verify_behavior working. Existing flows upgraded from "exists" to before/after checks.

End of Week 5:  "Walk through your app, agent builds the test suite"
                → qa-agent learn works. Init → learn → learn loop produces stable model.

End of Week 6:  "Migrate from legacy and describe tests in English"
                → qa-agent migrate works. compose_test v2 with intent parsing.

End of Week 7:  "Complete smart QA agent with knowledge evolution"
                → Full system. Init → learn → test → learn cycle. Knowledge persists.
```

---

## Phase Execution Checklist

Use this as a running checklist during implementation:

### Phase 0 — Pattern Library
- [ ] Create `qa/` directory in opencode-dev
- [ ] Write `patterns.ts` with 8 initial patterns
- [ ] Write `SMOKE_CHECK_MAP` with Playwright assertions
- [ ] Write `matchPatterns()` function
- [ ] Write `extractPatternDetails()` function
- [ ] Write unit tests
- [ ] Manual validation against Rondah pages
- [ ] Code review

### Phase 1 — scan_page
- [ ] Create `scan_page.ts` + `scan_page.txt`
- [ ] Register in `registry.ts`
- [ ] Update agent permissions
- [ ] Write integration tests
- [ ] Test edge cases (404, auth redirect, empty page)
- [ ] Manual test against Rondah
- [ ] Copy to opencode/ package
- [ ] Publish v1.1.0

### Phase 2 — map_site
- [ ] Add console error listener to BrowserManager
- [ ] Create `map_site.ts` + `map_site.txt`
- [ ] Implement URL normalization
- [ ] Implement BFS crawl with nav_sidebar link injection
- [ ] Implement auth flow using pattern recognition
- [ ] Implement smoke check runner
- [ ] Register in `registry.ts`
- [ ] Update agent permissions
- [ ] Write integration tests
- [ ] Performance test (< 90s for Rondah)
- [ ] Manual full-app smoke test
- [ ] Copy to opencode/ package
- [ ] Publish v1.2.0

### Phase 2.5 — `qa-agent init` command
- [ ] Create `scripts/init.js` — CLI entry that runs map_site + generates feature model
- [ ] Implement pattern→capability mapping function (hardcoded table, see "Pattern → capability mapping table" section)
- [ ] Implement feature grouping by parent route (`/home/call-logs` → feature: `call_logs`)
- [ ] Implement dependency inference (`/home/*` → requires: `["authenticated"]`)
- [ ] Implement verify check defaults per pattern (data_table → element_count_changed, etc.)
- [ ] Implement single Claude API call for interaction descriptions:
  - Input: site model JSON + capability skeleton with empty interaction fields
  - Prompt: "For each capability, write a 1-line natural language interaction description based on the page patterns and interactive elements. Return the same JSON with interaction fields filled."
  - Output: completed feature model JSON
  - Fallback: if Claude call fails, use generic descriptions ("use the {pattern} controls")
- [ ] Implement `_confidence: "init"` and `_observed: 0` metadata on all capabilities
- [ ] Implement QA_INSTRUCTIONS.json auto-generation:
  - Detect custom elements: any pattern signal selector that uses non-standard tags → `global.customSelectors`
  - Detect excluded routes: pages that returned 403/404/redirect → `scope.exclude_routes`
  - Measure page load times: record navigation duration per page → if any > 2s, set `timing.page_load_buffer`
  - Capture console errors: from BrowserManager buffer → `known_issues` with `action: "ignore"` for benign warnings
  - Detect toast selectors: if `[data-sonner-toast]` or non-standard toast elements found → `timing.toast_appear_delay`
- [ ] Add `init` command to `bin/qa-agent.js` CLI router
- [ ] Validate generated feature model against Zod schema before writing
- [ ] Write test: init against Rondah → feature model has auth + call_logs + appointments
- [ ] Write test: init against static HTML page → empty feature model (no patterns)
- [ ] Implement `--diff` flag for re-scanning existing model:
  - Compare new scan against existing QA_FEATURE_MODEL.json
  - Output: new pages found, pages removed, pattern confidence changes
  - Does NOT overwrite — outputs diff report, user decides what to apply
- [ ] Copy to opencode/ package
- [ ] Publish v1.2.1

### Phase 3 — verify_behavior
- [ ] Create `state-snapshot.ts`
- [ ] Implement `captureState()` with selector extraction from checks
- [ ] Implement all 11 check runners
- [ ] Implement visible text capture
- [ ] Create `verify_behavior.ts` + `verify_behavior.txt`
- [ ] Implement two-phase call pattern
- [ ] Implement snapshot storage (in-memory Map)
- [ ] Register in `registry.ts`
- [ ] Update agent permissions
- [ ] Write unit tests for each check type
- [ ] Integration test: filter on call-logs, verify row count changed
- [ ] Copy to opencode/ package
- [ ] Publish v1.3.0

### Phase 3.5 — `qa-agent learn` command

#### Core: interaction-tracker.ts
- [ ] Create `qa/interaction-tracker.ts`
- [ ] Implement `injectTracker(page)` — injects `window.__qaTracker` into the page
- [ ] Re-inject tracker on every navigation (page.on('load', () => injectTracker(page)))
- [ ] Implement `pollEvents(page)` — calls `page.evaluate(() => window.__qaTracker.flush())` every 500ms
- [ ] Implement `getSelector(el)` priority: data-testid > id > aria-label > text content > CSS path
- [ ] Implement password/sensitive field redaction (type="password", autocomplete="new-password")
- [ ] Write test: inject into mock page → click button → event captured with correct selector
- [ ] Write test: type in password field → value captured as "***"

#### Core: session-recorder.ts
- [ ] Create `qa/session-recorder.ts`
- [ ] Define `SessionEvent` type: { type, timestamp, selector, text?, value?, url }
- [ ] Define `SessionCapability` type: { name, feature, route, events[], stateChanges[], interaction, verify }
- [ ] Define `LearnSession` type: { id, startedAt, events[], capabilities[], modelBefore }
- [ ] Implement `startSession(existingModel)` — loads model, creates session
- [ ] Implement `recordEvent(event)` — buffers events between [Enter] presses
- [ ] Implement `captureStateBefore(page, selectors)` — snapshot before interaction starts
- [ ] Implement `captureStateAfter(page, selectors)` — snapshot after state settles
- [ ] Implement `markCapability(events, stateBefore, stateAfter)`:
  - Group buffered events since last [Enter] into a capability
  - Build interaction description from events: click → "click {text}", input → "type {value} in {field}"
  - Build verify checks from state diff:
    - element count changed → `element_count_changed`
    - new element appeared → `element_appeared`
    - element disappeared → `element_disappeared`
    - URL changed → `url_changed`
    - New text on page → `text_appeared`
    - Toast/alert appeared → `toast_appeared`
  - Auto-detect feature name from current route (`/home/call-logs` → `call_logs`)
  - Auto-detect preconditions from previous capabilities in session
- [ ] Implement `markEdgeCase(events, stateChanges, parentCapability)` — records edge case for [e] key
- [ ] Implement `detectCleanup(events, stateChanges, lastCapability)` — if state reverts to before, mark as cleanup
- [ ] Implement `autoSave(session, path)` — write session to `.qa-learn-session.json` every 30s
- [ ] Implement `resumeSession(path)` — load partial session and continue
- [ ] Write test: 3 click events + state change → markCapability produces correct interaction + verify
- [ ] Write test: undo action detected → cleanup recorded

#### Core: model-merger.ts
- [ ] Create `qa/model-merger.ts`
- [ ] Implement `matchCapability(observed, existingFeatures)`:
  - Match by route + action similarity:
    1. Same route + same selectors clicked → exact match
    2. Same route + same pattern type interacted (e.g., both click filter controls) → probable match
    3. Same route + no match → new capability
  - Return: `{ matched: existingCapability | null, confidence: number }`
- [ ] Implement `mergeInteraction(observed, existing, sessionCount)`:
  - If existing._confidence === "init": REPLACE entirely with observed
  - If existing._confidence starts with "observed": GENERALIZE
    - Find tokens that differ between sessions:
      e.g., "select 'Completed'" vs "select 'Missed'" → "select criteria"
    - Move specific values to test_data array
    - Keep stable parts unchanged
  - Return merged interaction string
- [ ] Implement `mergeVerifyChecks(observed, existing)`:
  - UNION: add any new check types not in existing
  - KEEP: checks in existing that weren't seen this session (may appear in different paths)
  - FLAG: checks that FAILED in this session → add `_flagged: true` for review
  - Return merged verify object
- [ ] Implement `mergeTestData(observed, existing)`:
  - If existing has single value + observed has different value → convert to array
  - If existing is array → append new values, deduplicate
  - Passwords always stored as "$TEST_PASSWORD"
  - Emails stored as "$TEST_EMAIL" or literal test email
  - Return merged test_data object
- [ ] Implement `mergeEdgeCases(observed, existing)`:
  - Append new edge cases from session
  - Deduplicate by interaction similarity
  - Return merged edge_cases array
- [ ] Implement `updateConfidence(capability, sessionCount)`:
  - 0 sessions observed → "init" or "migrated"
  - 1 session → "observed_1x"
  - 2 sessions → "observed_2x"
  - 3+ sessions with no changes → "stable"
  - Has edge cases → append "_edge_cased"
- [ ] Implement `mergeSession(session, existingModel)`:
  - For each capability in session:
    1. matchCapability → find or create
    2. mergeInteraction
    3. mergeVerifyChecks
    4. mergeTestData
    5. mergeEdgeCases
    6. updateConfidence
  - For pages visited but no capability marked → still update page patterns in model
  - Preserve all capabilities NOT touched in this session unchanged
  - Update model.meta: increment learn_sessions, update last_session timestamp
  - Return: { updatedModel, changeReport }
- [ ] Implement `generateChangeReport(before, after)`:
  - List: capabilities upgraded (init → observed)
  - List: capabilities refined (new checks, new test_data)
  - List: capabilities added (new features/routes)
  - List: capabilities unchanged
  - Count: total changes vs unchanged → if <20% changed, model is "stable"
  - Return report object for terminal display
- [ ] Write test: session with new interaction → replaces init guess
- [ ] Write test: two sessions with different filter values → interaction generalized, test_data expanded
- [ ] Write test: session observes same behavior as model → no changes, confidence bumped
- [ ] Write test: edge case marked → added to capability's edge_cases array
- [ ] Write test: cleanup detected → added as cleanup field

#### CLI: scripts/learn.js
- [ ] Create `scripts/learn.js`
- [ ] Launch Playwright in non-headless mode (`headless: false`)
- [ ] Load existing QA_FEATURE_MODEL.json (error if not found — run init first)
- [ ] Display terminal UI: session info, commands, low-confidence capabilities
- [ ] Inject interaction tracker on page load and after each navigation
- [ ] Start state snapshot polling (capture element counts for tracked selectors every 500ms)
- [ ] Listen for user key presses:
  - [Enter] → markCapability, display result
  - [n] → prompt for name, update last capability name
  - [e] → markEdgeCase for last capability
  - [s] → discard buffered events since last mark
  - [d] → end session, merge, write, display report
- [ ] Auto-save session every 30 seconds to `.qa-learn-session.json`
- [ ] Support `--resume` flag to load saved session
- [ ] On [d]: call `mergeSession()`, write updated QA_FEATURE_MODEL.json, display change report
- [ ] Also update QA_INSTRUCTIONS.json with timing/quirk observations from session
- [ ] Add `learn` command to `bin/qa-agent.js` CLI router
- [ ] Write test: full learn session against mock app → model updated correctly
- [ ] Write test: resume from saved session → continues correctly
- [ ] Write test: 3 sessions in sequence → confidence progresses init → 1x → 2x → stable
- [ ] Copy to opencode/ package
- [ ] Publish v1.3.1

#### Session persistence format (`.qa-learn-session.json`)
```json
{
  "id": "session_abc123",
  "startedAt": "2026-03-16T10:00:00Z",
  "modelSnapshot": "sha256 hash of model at session start",
  "events": [
    { "type": "click", "timestamp": 1710583200000, "selector": "button:has-text('Filter')", "url": "/home/call-logs" }
  ],
  "capabilities": [
    { "name": "filter", "feature": "call_logs", "route": "/home/call-logs", "events": [...], "stateChanges": {...}, "markedAt": 1710583260000 }
  ],
  "status": "in_progress"
}
```

### Phase 4 — Feature Model
- [ ] Create `feature-model.ts` with Zod schemas
- [ ] Implement `loadFeatureModel()`
- [ ] Implement `resolveCapabilities()` with topological sort
- [ ] Implement circular dependency detection
- [ ] Update `load_qa_context.ts` to accept feature model + instructions file
- [ ] Write `QA_FEATURE_MODEL.json` for Rondah (3 features — or generate via init + learn)
- [ ] Write unit tests
- [ ] Copy to opencode/ package
- [ ] Publish v1.4.0

### Phase 4.5 — `qa-agent migrate` command
- [ ] Create `scripts/migrate.js`
- [ ] Implement QA_FLOWS.json parser:
  - Read `flows` object → for each category, for each flow: extract steps, priority, requiredParams
  - Read `testSuites` / `suites` → map suite names to flow IDs
  - Read `compositeFlows` → resolve sub-flow references
  - Read `errorHandling` → convert to QA_INSTRUCTIONS.json known_issues
- [ ] Implement QA_ANCHOR_POINTS.json parser:
  - Read `routes` → map route names to paths
  - Read per-feature selectors → associate with features
- [ ] Implement step→interaction converter:
  - `navigate` → "navigate to {target}"
  - `fill` → "fill {placeholder or name} field" (or "fill email/password" from field type)
  - `click` → "click {text or description}"
  - `waitFor` → omitted (implicit in smart system)
  - `verify` → moved to verify checks, not interaction
  - Join converted steps with ", " to form interaction string
- [ ] Implement step→verify check converter:
  - `{ action: "verify", target, state: "visible" }` → `{ type: "custom_selector_visible", selector: target }`
  - `{ action: "verify", target, state: "hidden" }` → `{ type: "custom_selector_hidden", selector: target }`
  - `{ action: "waitFor", target: "url", condition: "contains:..." }` → `{ type: "url_changed" }`
  - `{ action: "verify", assertions: [...] }` → map each assertion to appropriate check type
- [ ] Implement feature grouping: flow categories → features, route from anchor points
- [ ] Implement dependency inference: flows with `prerequisite` → capability preconditions
- [ ] Implement test_data extraction: `requiredParams` → test_data with `$ENV_VAR` references
- [ ] Set `_confidence: "migrated"` and `_observed: 0` on all converted capabilities
- [ ] Write migration notes generator (`QA_FEATURE_MODEL.migration-notes.md`):
  - List capabilities where interaction description is generic
  - List capabilities with only `custom_selector_visible` checks (could be more specific)
  - List test_data fields that need real values
  - Recommend running `qa-agent learn` to upgrade migrated capabilities
- [ ] Validate output against feature model Zod schema
- [ ] Add `migrate` command to `bin/qa-agent.js` CLI router
- [ ] Write test: migrate Rondah QA_FLOWS.json → produces valid feature model with all flows
- [ ] Write test: migrated model loads correctly via `loadFeatureModel()`
- [ ] Write test: backward compat — existing `run-flows.sh` still works alongside new model
- [ ] Copy to opencode/ package
- [ ] Publish v1.4.1

### Phase 5 — Intent Composer
- [ ] Rewrite `compose_test.ts` with dual path (keyword fallback + feature model)
- [ ] Implement intent parsing (Option A: keyword extraction)
- [ ] Implement plan builder with test data injection
- [ ] Update `execute_flow.ts` with capability mode
- [ ] Verify backward compatibility (old keyword path still works)
- [ ] Write unit tests for both paths
- [ ] End-to-end test: compose → execute → verify for Rondah feature
- [ ] Update tool descriptions (.txt files)
- [ ] Copy to opencode/ package
- [ ] Publish v1.5.0

### Phase 5.5 — QA Instructions integration
- [ ] Create `qa/instructions.ts` with Zod schema (see "Validation" section for full schema)
- [ ] Implement `loadInstructions(path)` — validate with Zod, return typed object, defaults for missing fields
- [ ] Implement `getInstructions()` — return cached instructions or defaults
- [ ] Implement environment override merging: `deepMerge(base, overrides[env])`
- [ ] Update `load_qa_context.ts` to accept `instructionsPath` parameter and cache in QAContext
- [ ] Wire into tools:
  - `browser/manager.ts`: read `global.viewport` on page creation
  - `scan_page.ts`: read `global.defaultTimeout`, `global.customSelectors` extends pattern signals
  - `map_site.ts`: read `scope.exclude_routes`, `scope.max_pages`, `auth` config, `known_issues` (ignore errors)
  - `verify_behavior.ts`: read `timing.slow_transitions` (wait after specific actions), `timing.toast_appear_delay`, `global.waitAfterAction`, `known_issues` (skip checks)
  - `compose_test.ts`: read `scope.exclude_capabilities`, `scope.include_only`, inject `agent_hints` into context
- [ ] Add `--instructions` and `--env` CLI flags to `bin/qa-agent.js`
- [ ] Write test: missing instructions file → all defaults apply, no errors
- [ ] Write test: instructions with wrong field type → Zod error with clear message
- [ ] Write test: `scope.exclude_routes` → map_site skips those routes
- [ ] Write test: `known_issues` with action "skip_check" → verify_behavior skips that check
- [ ] Write test: `environment_overrides.production` → merges correctly
- [ ] Copy to opencode/ package
- [ ] Publish v1.5.1

### Phase 6 — Knowledge Evolution
- [ ] Extend knowledge types (PatternKnowledge, FeatureKnowledge, SelectorKnowledge)
- [ ] Store pattern knowledge after map_site
- [ ] Store feature results after verify_behavior
- [ ] Store selector fallbacks after resolve_selector
- [ ] Implement knowledge loading on subsequent runs
- [ ] Implement knowledge pruning: keep last 30 days of entries, max 1000 entries per type
- [ ] Test: second run benefits from cached knowledge
- [ ] Copy to opencode/ package
- [ ] Publish v1.6.0

---

*Last updated: 2026-03-16*
