# Production Health — Execution Plan

> Concrete implementation steps for shifting init-generated testing from state assertions to route-level health checks.
> See `PRODUCTION_HEALTH_TEST_PLAN.md` for the design rationale.

---

## Current State

```
QA_FEATURE_MODEL.json (4 features, all init-generated):

  call_logs:     route=/home/call-logs        caps=[view_list]  health=none
  system_health: route=/home/admin-hub/...    caps=[view_list]  health=none
  dashboard:     route=/home/dashboard        caps=[view_list]  health=none
  voicemails:    route=/home/voicemails       caps=[view_list]  health=none
```

Every feature has a single `view_list` capability with `table_visible` + `has_rows` checks. No health blocks exist.

The runner (`run-test.js`) already supports `feature.health` blocks (lines 131-141, 275-326) with `runHealthCheck()` supporting: `url_is`, `landmark_visible`, `no_console_errors`, `no_js_errors`, `no_error_alerts`.

---

## What Changes

### Files Modified

| File | What |
|------|------|
| `qa/model-generator.ts` | Add `health` to `GeneratedFeature`, generate health blocks for all routes |
| `scripts/init.js` | Mirror health block generation, stop emitting state-sensitive checks |
| `scripts/run-test.js` | Split error tracking, add hydration detection, add request failure tracking |

### Files NOT Modified

- `lib/page-state.js`, `lib/step-splitter.js`, etc. — unrelated
- `scripts/learn.js` — learn sessions already produce health blocks via the observation merge path
- `scripts/run-e2e.js` — E2E replay is unrelated to passive health testing

---

## Phase 1: Generate Health Blocks From Init

> Goal: every discovered route gets a `feature.health` block. Remove state-sensitive assertions from init output.

### 1.1 Add `health` to `GeneratedFeature` interface

**File:** `qa/model-generator.ts` line 45

```typescript
export interface HealthBlock {
  route: string
  landmark?: { selector: string; text: string }
  checks: Array<{ type: string; value?: string; selector?: string; text?: string }>
}

export interface GeneratedFeature {
  description: string
  route: string
  requires: string[]
  capabilities: Record<string, GeneratedCapability>
  health?: HealthBlock
}
```

### 1.2 Build health blocks for every feature in `generateFeatureModel()`

**File:** `qa/model-generator.ts` line 193 (inside feature creation)

After creating the feature object, attach a health block:

```typescript
features[featureName] = {
  description: generateDescription(featureName, pageScan),
  route,
  requires,
  capabilities,
  health: buildHealthBlock(route, pageScan),
}
```

Add the helper:

```typescript
function buildHealthBlock(route: string, pageScan: PageScanData): HealthBlock {
  const landmark = pickInitLandmark(pageScan)
  return {
    route,
    ...(landmark && { landmark }),
    checks: [
      { type: "url_is", value: route },
      { type: "no_console_errors" },
      { type: "no_error_alerts" },
    ],
  }
}

function pickInitLandmark(pageScan: PageScanData): { selector: string; text: string } | null {
  // Priority: data-page > data-testid > h1 > h2 > title
  // pageScan has: title, patterns, and the raw page data
  // The title is available on pageScan.title
  if (pageScan.title && pageScan.title.length > 2 && !/loading/i.test(pageScan.title)) {
    return { selector: "title", text: pageScan.title }
  }
  return null
}
```

Note: `pickInitLandmark` is intentionally conservative at init time — we only have the page title from the crawl. Learn sessions can enrich it later with `data-page`, `data-testid`, or `h1` via the existing `pickLandmark` function in `learn.js`.

### 1.3 Generate health blocks for routes with no pattern match

**File:** `qa/model-generator.ts` line 158-161

Currently:
```typescript
if (meaningfulPatterns.length === 0) continue  // skips the route entirely
```

Change to:
```typescript
if (meaningfulPatterns.length === 0) {
  // No actionable patterns, but still create a health-only feature
  const featureName = routeToFeatureName(route)
  if (!featureName || features[featureName]) continue

  const requires: string[] = []
  if (hasAuth && !isAuthPage) requires.push("authenticated")

  features[featureName] = {
    description: generateDescription(featureName, pageScan),
    route,
    requires,
    capabilities: {},
    health: buildHealthBlock(route, pageScan),
  }
  continue
}
```

### 1.4 Remove state-sensitive checks from `PATTERN_CAPABILITY_MAP`

**File:** `qa/model-generator.ts` lines 87-110

Replace the `data_table.view_list` and `crud_page.view_list` entries:

```typescript
data_table: {
  view_list: {
    interaction: "navigate to page",
    expected: ["page loads without errors"],
    verify: {
      no_errors: { type: "no_errors" },
    },
  },
},
crud_page: {
  view_list: {
    interaction: "navigate to page",
    expected: ["page loads without errors"],
    verify: {
      no_errors: { type: "no_errors" },
    },
  },
},
```

This removes `table_visible` and `has_rows` from init-generated capabilities. The `view_list` capability still exists (for backward compat with learn sessions that may reference it) but no longer asserts table/row presence.

### 1.5 Mirror in `scripts/init.js`

**File:** `scripts/init.js` lines 239-272

The `PATTERN_CAPABILITY_MAP` in init.js is a copy of the one in model-generator.ts. Apply the same change:
- Remove `table_visible` and `has_rows` from `data_table.view_list.verify`
- Remove `table_visible` and `has_rows` from `crud_page.view_list.verify`
- Keep `no_errors` in both

Note: init.js calls `generateFeatureModel()` from model-generator.ts (line 418), so the health block generation from 1.2 and 1.3 flows through automatically. But init.js also has its own inline copy of `PATTERN_CAPABILITY_MAP` for the `--instructions` path — both copies must match.

### 1.6 Acceptance Criteria

- [ ] `npm run init` generates a model where every feature has a `health` block
- [ ] Health blocks contain `url_is`, `no_console_errors`, `no_error_alerts`
- [ ] No `table_visible` or `has_rows` checks in any init-generated capability
- [ ] Routes with no pattern match still get a health-only feature
- [ ] `npm run test:smoke` runs health checks for all features
- [ ] Existing model compatibility: `run-test.js` handles features with or without `health`

---

## Phase 2: Improve Landmark Generation

> Goal: each route gets a stable identity check that survives state changes.

### 2.1 Enrich `pickInitLandmark` with crawl data

**File:** `qa/model-generator.ts`

The crawl's `siteModel[route]` currently stores `title` and `patterns`. To get better landmarks, we need to capture `h1`, `data-page`, and `data-testid` during the crawl.

**File:** `scripts/init.js` — inside the `crawlPages()` function

After navigating to each page, capture landmark candidates:

```javascript
const landmarks = await page.evaluate(() => {
  const h1 = document.querySelector("h1")?.textContent?.trim() || ""
  const dataPages = Array.from(document.querySelectorAll("[data-page]"))
    .map(el => el.getAttribute("data-page")).filter(Boolean)
  const dataTestIds = Array.from(document.querySelectorAll("[data-testid]"))
    .map(el => el.getAttribute("data-testid")).filter(Boolean).slice(0, 5)
  return { h1, dataPages, dataTestIds }
})
```

Store these in the siteModel page entry so `pickInitLandmark` can use them.

### 2.2 Update `pickInitLandmark` priority

```typescript
function pickInitLandmark(pageScan: PageScanData): { selector: string; text: string } | null {
  // 1. data-page attribute (most stable)
  if (pageScan.landmarks?.dataPages?.length > 0) {
    return { selector: `[data-page="${pageScan.landmarks.dataPages[0]}"]`, text: pageScan.landmarks.dataPages[0] }
  }
  // 2. stable data-testid
  if (pageScan.landmarks?.dataTestIds?.length > 0) {
    return { selector: `[data-testid="${pageScan.landmarks.dataTestIds[0]}"]`, text: pageScan.landmarks.dataTestIds[0] }
  }
  // 3. h1 text
  if (pageScan.landmarks?.h1) {
    return { selector: "h1", text: pageScan.landmarks.h1 }
  }
  // 4. page title fallback
  if (pageScan.title && pageScan.title.length > 2 && !/loading/i.test(pageScan.title)) {
    return { selector: "title", text: pageScan.title }
  }
  return null
}
```

### 2.3 Acceptance Criteria

- [ ] Init captures h1, data-page, data-testid during crawl
- [ ] Landmarks use data-page > data-testid > h1 > title priority
- [ ] Health blocks include `landmark` when available
- [ ] Landmark checks pass across valid empty/loaded states

---

## Phase 3: Split Error Tracking and Add Hydration Detection

> Goal: triage failures by category — hydration, runtime, console, request.

### 3.1 Split `consoleErrors` into categorized tracking

**File:** `scripts/run-test.js` lines 229-235

Replace:
```javascript
let consoleErrors = []
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text())
})
page.on("pageerror", (err) => {
  consoleErrors.push(err.message)
})
```

With:
```javascript
let consoleErrors = []   // console.error() calls
let jsErrors = []        // uncaught exceptions (pageerror)
let requestFailures = [] // failed network requests

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text())
})
page.on("pageerror", (err) => {
  jsErrors.push(err.message)
})
page.on("requestfailed", (request) => {
  requestFailures.push({
    url: request.url(),
    resourceType: request.resourceType(),
    failure: request.failure()?.errorText || "unknown",
  })
})
```

Reset all three per step (line 257):
```javascript
consoleErrors = []
jsErrors = []
requestFailures = []
```

### 3.2 Update `runHealthCheck` to use split tracking

**File:** `scripts/run-test.js` — `runHealthCheck()` signature

Change signature to accept all error arrays:

```javascript
async function runHealthCheck(check, page, consoleErrors, jsErrors, requestFailures) {
```

Update the check types:

```javascript
case "no_js_errors": {
  const allErrors = [...jsErrors]
  result.passed = allErrors.length === 0
  result.detail = result.passed
    ? "No JS errors"
    : `${allErrors.length} JS errors: ${allErrors.slice(0, 2).join("; ")}`
  // Classify
  const hydrationErrors = allErrors.filter(e => /hydration|text content does not match|did not match/i.test(e))
  if (hydrationErrors.length > 0) {
    result.category = "hydration_error"
    result.detail = `Hydration error: ${hydrationErrors[0].slice(0, 150)}`
  } else if (allErrors.length > 0) {
    result.category = "runtime_error"
  }
  break
}

case "no_console_errors": {
  result.passed = consoleErrors.length === 0
  result.detail = result.passed
    ? "No console errors"
    : `${consoleErrors.length} console errors: ${consoleErrors.slice(0, 2).join("; ")}`
  if (!result.passed) result.category = "console_error"
  break
}
```

Now `no_js_errors` and `no_console_errors` are genuinely different:
- `no_js_errors` = uncaught exceptions (pageerror), includes hydration detection
- `no_console_errors` = explicit console.error() calls

### 3.3 Add `no_request_failures` health check type

**File:** `scripts/run-test.js` — add to `runHealthCheck()` switch

```javascript
case "no_request_failures": {
  // Only fail on API/fetch failures, not static assets or analytics
  const apiFailures = requestFailures.filter(r =>
    r.resourceType === "fetch" || r.resourceType === "xhr"
  )
  result.passed = apiFailures.length === 0
  result.detail = result.passed
    ? "No API request failures"
    : `${apiFailures.length} failed: ${apiFailures.map(r => `${r.failure} ${r.url.split("?")[0]}`).slice(0, 2).join("; ")}`
  if (!result.passed) result.category = "request_failure"
  break
}
```

### 3.4 Update default health checks to include all types

**File:** `qa/model-generator.ts` — in `buildHealthBlock()`

```typescript
checks: [
  { type: "url_is", value: route },
  { type: "no_js_errors" },
  { type: "no_console_errors" },
  { type: "no_error_alerts" },
  { type: "no_request_failures" },
],
```

### 3.5 Add `category` to result output

**File:** `scripts/run-test.js` — result logging and summary

When printing check results, show category:

```javascript
const category = checkResult.category ? ` [${checkResult.category}]` : ""
console.log(`  ${icon} [${check.type}]${category} ${checkResult.detail}`)
```

In the summary JSON, include category counts:

```javascript
const categoryCounts = {}
for (const r of results) {
  for (const c of r.checks) {
    if (c.category) categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1
  }
}
summary.categories = categoryCounts
```

### 3.6 Acceptance Criteria

- [ ] `no_js_errors` catches uncaught exceptions, detects hydration errors specifically
- [ ] `no_console_errors` catches console.error() calls only
- [ ] `no_request_failures` catches failed API requests (fetch/xhr), ignores static assets
- [ ] Each failed check has a `category` field for triage
- [ ] Summary shows category breakdown (e.g., `hydration_error: 2, request_failure: 1`)

---

## Phase 4: Regenerate and Validate

> Goal: ship the new model and confirm production behavior.

### 4.1 Regenerate the feature model

```bash
npm run init -- --url http://localhost:3000 --email test@x.com --password pass123
```

Verify the output:
- Every feature has a `health` block
- No `table_visible` or `has_rows` in any capability
- Routes with no table pattern still appear as features

### 4.2 Run smoke tests

```bash
npm run test:smoke
```

Expected:
- Pages that load correctly pass (even with zero rows)
- Pages with hydration errors fail with `category: hydration_error`
- Pages with `ERR_CONNECTION_REFUSED` fail with `category: request_failure`
- No false failures from empty states

### 4.3 Run full tests

```bash
npm run test:full
```

Verify that `view_list` capabilities (now stripped of row assertions) don't produce false failures.

### 4.4 Compare before/after

Keep the old `QA_FEATURE_MODEL.json` as `QA_FEATURE_MODEL.old.json` before regenerating. Compare:
- Which failures disappeared (should be: empty state false positives)
- Which failures remain (should be: real hydration/runtime/network errors)

---

## Implementation Order

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(health      (landmarks)  (error       (regenerate
 blocks)                   tracking)    & validate)

 ~2 days      ~1 day       ~2 days      ~0.5 day
```

Phase 1 is the critical change. Phase 2 improves quality. Phase 3 improves triage. Phase 4 validates.

### Dependency Chain

```
Phase 1: model-generator.ts + init.js  ← no dependencies
Phase 2: init.js crawl + model-generator.ts  ← depends on Phase 1 (health block shape)
Phase 3: run-test.js  ← independent of Phase 1-2 (can parallelize)
Phase 4: validation  ← depends on all above
```

Phase 1 and Phase 3 can be built in parallel.

---

## Files Changed Summary

| File | Phase | Changes |
|------|-------|---------|
| `qa/model-generator.ts` | 1, 2 | Add `HealthBlock` interface, `buildHealthBlock()`, `pickInitLandmark()`. Modify `GeneratedFeature`, `generateFeatureModel()`, `PATTERN_CAPABILITY_MAP`. |
| `scripts/init.js` | 1, 2 | Update inline `PATTERN_CAPABILITY_MAP`. Capture landmarks during crawl. |
| `scripts/run-test.js` | 3 | Split error tracking, add hydration detection, add `no_request_failures` check, add `category` to results. |

---

## Backward Compatibility

- `run-test.js` already handles features without `health` blocks (line 131: `if (feature.health)` — skips gracefully)
- `view_list` capability still exists in the model — just with fewer assertions
- Learn sessions that reference `view_list` continue to work
- New health blocks are additive — old models without them still run

---

## Definition of Done

1. `npm run init` generates health blocks for every discovered route
2. No `table_visible` or `has_rows` in init-generated output
3. `npm run test:smoke` passes on pages with legitimate empty states
4. Hydration/runtime/request failures are caught and categorized
5. Summary output shows failure categories for production triage
6. Existing learn-session flows and E2E recordings are unaffected
