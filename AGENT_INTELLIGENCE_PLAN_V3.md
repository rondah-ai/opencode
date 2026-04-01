# Agent Intelligence v3 — Implementation Plan

> Corrected implementation plan for fixing the `wimsical` flow failure.
> Deterministic first. Backward-compatible flow schema. AI remains optional.

---

## Outcome

This version fixes the remaining issues in V2:

1. `[k]` now truly keeps a batch as one step
2. Split steps use correct per-group route/state metadata
3. Validation helpers are explicitly defined
4. Overlay detection includes dropdown-style blockers when they actually block interaction
5. `[f]`, `[d]`, and interrupted sessions all share one finalization path

Phase 1 alone should fix the reported `wimsical` replay failure.

---

## Constraints

- No flow JSON schema break
- No new required dependencies
- CommonJS only
- Existing recordings in `QA_RECORDED_FLOWS.json` must continue to replay
- Core correctness must not depend on Anthropic/API availability

---

## Shared Helpers

These helpers should be extracted once and reused across replay, validation, and learning code.

### `lib/resolve-value.js`

The validator must not depend on a helper that only exists inside `run-e2e.js`.

```javascript
// lib/resolve-value.js

function resolveValue(value, cfg) {
  if (typeof value !== 'string') return value

  let resolved = value
  resolved = resolved.replace(/\$EMAIL/g, cfg.email || '')
  resolved = resolved.replace(/\$PASSWORD/g, cfg.password || '')

  for (const [key, val] of Object.entries(cfg.vars || {})) {
    resolved = resolved.replace(new RegExp(`\\$${key}`, 'g'), val)
  }

  return resolved
}

module.exports = { resolveValue }
```

Use it from:

- `scripts/run-e2e.js`
- `lib/action-executor.js`
- any future validator/replay helpers

---

## Phase 1: Replay Reliability

> Goal: existing broken flows replay more reliably without re-recording.

### 1.1 Create `lib/page-state.js`

Use plain helpers, not classes.

```javascript
// lib/page-state.js

async function capturePageState(page) {
  return await page.evaluate(() => {
    const state = {
      overlays: [],
      openModals: [],
      openDropdowns: [],
    }

    document.querySelectorAll('*').forEach(el => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()

      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0

      if (!visible) return

      const blocksPointer = style.pointerEvents !== 'none'

      if ((style.position === 'fixed' || style.position === 'absolute') && blocksPointer) {
        const coversPage =
          rect.width >= window.innerWidth * 0.8 &&
          rect.height >= window.innerHeight * 0.8 &&
          parseInt(style.zIndex || '0', 10) > 0

        if (coversPage) {
          state.overlays.push({
            selector: minSelector(el),
            zIndex: parseInt(style.zIndex || '0', 10),
            coversFullPage: true,
          })
        }
      }
    })

    document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]').forEach(el => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      state.openModals.push({
        selector: minSelector(el),
        title: el.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() || '',
        hasBackdrop: !!document.querySelector('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]'),
      })
    })

    document.querySelectorAll('[aria-expanded="true"], [data-state="open"]').forEach(el => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      state.openDropdowns.push({
        selector: minSelector(el),
        triggerText: el.textContent?.trim()?.slice(0, 60) || '',
        mayBlock: !!document.querySelector('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]'),
      })
    })

    return state

    function minSelector(el) {
      if (el.id) return `#${el.id}`
      const testId = el.getAttribute('data-testid')
      if (testId) return `[data-testid="${testId}"]`
      const role = el.getAttribute('role')
      if (role) return `[role="${role}"]`
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase()
    }
  })
}

function hasBlockingOverlay(state) {
  return state.overlays.some(o => o.coversFullPage) ||
    state.openModals.some(m => m.hasBackdrop) ||
    state.openDropdowns.some(d => d.mayBlock)
}

function getBlockingElement(state) {
  if (state.openModals.length > 0) return { type: 'modal', ...state.openModals.at(-1) }
  if (state.overlays.length > 0) return { type: 'overlay', ...state.overlays.at(-1) }
  if (state.openDropdowns.length > 0) return { type: 'dropdown', ...state.openDropdowns.at(-1) }
  return null
}

async function dismissBlockingOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await capturePageState(page)
    if (!hasBlockingOverlay(before)) return true

    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)

    const afterEscape = await capturePageState(page)
    if (!hasBlockingOverlay(afterEscape)) return true

    try {
      const backdrop = page.locator('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]').first()
      if (await backdrop.count() > 0) {
        await backdrop.click({ force: true })
        await page.waitForTimeout(400)
      }
    } catch {}

    const afterClick = await capturePageState(page)
    if (!hasBlockingOverlay(afterClick)) return true
  }

  return false
}

module.exports = {
  capturePageState,
  hasBlockingOverlay,
  getBlockingElement,
  dismissBlockingOverlays,
}
```

### 1.2 Modify `scripts/run-e2e.js`

Add:

- pre-step overlay dismissal in `executeStep()`
- action retry on `intercepts pointer events`
- `waitForStableState(page)` helper after step actions

Implementation notes:

- Keep current `executeAction()` signature
- Extract the existing action switch into `executeActionInner()`
- Retry only intercepted-click failures
- Only force-click as last resort for `click`/`submit`

### 1.3 Success Criteria

- Existing `wimsical` flow no longer fails at the Reports click because of the leftover practice overlay
- Existing flow schema remains unchanged
- Runner logs when it auto-dismisses or retries

---

## Phase 2: Recorder Guardrails

> Goal: prevent obviously bad steps from being recorded silently.

### 2.1 Add recorder state flags in `scripts/learn.js`

Near the existing session state:

```javascript
let overlayWarningAcknowledged = false
let largeStepWarningAcknowledged = false
let splitPreview = null
let forceSingleStepOnce = false
```

### 2.2 Add `[x]` command

`[x]` calls `dismissBlockingOverlays(page)` and keeps the session alive.

### 2.3 Warn on blocking UI before step commit

Inside the Enter handler, before building the step:

- inspect `capturePageState(page)`
- if a blocking element exists and `overlayWarningAcknowledged` is false:
  - show warning
  - set `overlayWarningAcknowledged = true`
  - return without committing
- if the user presses Enter again:
  - allow commit
  - reset `overlayWarningAcknowledged = false`

### 2.4 Warn on very large steps

If `pendingEvents.length > 8` and `largeStepWarningAcknowledged` is false:

- show warning
- set `largeStepWarningAcknowledged = true`
- return

On second Enter, proceed and reset the flag.

### 2.5 Success Criteria

- Open dropdown/modal at step commit produces a warning
- `[x]` dismisses blockers without restarting learning
- Large multi-action steps are warned but not blocked

---

## Phase 3: Deterministic Step Splitting

> Goal: split navigation-heavy batches into valid step objects with correct metadata.

### 3.1 Create `lib/step-splitter.js`

```javascript
// lib/step-splitter.js

function splitOnNavigation(events) {
  if (!events || events.length <= 1) return [events]

  const groups = []
  let current = []

  for (const ev of events) {
    current.push(ev)
    if (ev.type === 'navigation' || ev._urlChanged) {
      groups.push(current)
      current = []
    }
  }

  if (current.length > 0) groups.push(current)
  return groups.length > 1 ? groups : [events]
}

function getGroupSnapshot(group, fallbackSnapshot) {
  for (let i = group.length - 1; i >= 0; i--) {
    if (group[i]._snapshotAfter) return group[i]._snapshotAfter
  }
  return fallbackSnapshot
}

function getGroupRoute(group, fallbackRoute) {
  for (let i = group.length - 1; i >= 0; i--) {
    if (group[i].type === 'navigation' && group[i].url) {
      try {
        return new URL(group[i].url).pathname
      } catch {}
    }
  }
  return fallbackRoute
}

module.exports = {
  splitOnNavigation,
  getGroupSnapshot,
  getGroupRoute,
}
```

### 3.2 Capture navigation snapshots in the poller

When a new event batch is pulled from the page tracker in `learn.js`, and an event is of type `navigation`, attach:

```javascript
ev._snapshotAfter = await captureState(page, consoleErrorCount)
```

Only do this for `navigation` events. Do not snapshot every event.

### 3.3 Tag URL changes that occur without explicit navigation events

Some SPA transitions may change the URL without a raw tracker `navigation` event. Add a secondary split signal in the poller.

Recommended poller behavior:

```javascript
const polledUrl = page.url()
const batchHasNavigation = events.some(ev => ev.type === 'navigation')

if (polledUrl !== lastPolledUrl && events.length > 0 && !batchHasNavigation) {
  events[0]._urlChanged = true
  events[0]._snapshotAfter = await captureState(page, consoleErrorCount)
}

lastPolledUrl = polledUrl
```

This lets the splitter break on route transitions even when the page tracker does not emit a dedicated `navigation` event.

### 3.4 Add split preview with real keep-as-one-step support

Inside the Enter handler:

1. If `forceSingleStepOnce` is `true`, bypass splitting for this batch and immediately commit as one step.
2. Otherwise run `splitOnNavigation(pendingEvents)`.
3. If multiple groups exist and `splitPreview` is empty:
   - print preview
   - store `splitPreview = { groups }`
   - return
4. If Enter is pressed again with `splitPreview` present:
   - accept split
   - commit split groups
5. If `[k]` is pressed:
   - set `forceSingleStepOnce = true`
   - clear `splitPreview`
   - print `Keeping as single step. Press [Enter] to commit.`
   - return

### 3.5 Build full recorded steps from each group

Add a helper in `learn.js`:

```javascript
function buildRecordedStepFromGroup(group, stepNumber, fallbackSnapshot, fallbackRoute, config) {
  const { getGroupSnapshot, getGroupRoute } = require('../lib/step-splitter')

  const snapshot = getGroupSnapshot(group, fallbackSnapshot)
  const route = getGroupRoute(group, fallbackRoute)
  const landmark = pickLandmark(snapshot.landmarks || {})

  return {
    stepNumber,
    route,
    description: describeEvents(group),
    actions: collapseEvents(group, config),
    rawEventCount: group.length,
    landmark: landmark || undefined,
    stateAfter: snapshot,
    verify: [],
    timestamp: Date.now(),
  }
}
```

Critical rule:

- Do not call `captureState(page, ...)` for every split group after the batch has already ended
- Use the per-navigation `_snapshotAfter` when available
- Only use the final current snapshot as fallback for the last group or non-navigation groups

### 3.6 Success Criteria

- `[k]` truly keeps the batch as one step
- Navigation-heavy recordings split into multiple valid step objects
- URL changes without explicit navigation events can still produce split boundaries
- Earlier groups do not inherit the final page route/landmark/state

---

## Phase 4: Centralized Flow Finalization

> Goal: all save paths use one implementation.

### 4.1 Create `lib/flow-validator.js`

Validator uses existing action/auth logic rather than inventing a second flow format.

```javascript
// lib/flow-validator.js

const { capturePageState, hasBlockingOverlay, dismissBlockingOverlays } = require('./page-state')

async function validateFlow(flow, config, executeActionFn, authenticateFn) {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()

  const result = {
    flow: flow.name,
    valid: true,
    issues: [],
    fixes: [],
    steps: [],
  }

  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: config.timeout })
    if (authenticateFn && config.email && config.password) {
      await authenticateFn(page, config.email, config.password, config.timeout)
    }

    if (flow.startRoute) {
      const startUrl = new URL(flow.startRoute, config.url).href
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout })
    }

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      const stepResult = { stepNumber: step.stepNumber || i + 1, status: 'passed', actions: [] }

      const preState = await capturePageState(page)
      if (hasBlockingOverlay(preState)) {
        result.valid = false
        result.issues.push({
          type: 'OVERLAY_BLOCKING',
          step: stepResult.stepNumber,
          detail: 'Blocking UI left open from previous step',
        })
        result.fixes.push({
          type: 'INSERT_DISMISS',
          beforeStep: stepResult.stepNumber,
          action: { type: 'press', key: 'Escape', _autoInserted: true },
        })
        await dismissBlockingOverlays(page)
      }

      for (const action of step.actions || []) {
        try {
          await executeActionFn(page, action, config)
          stepResult.actions.push({ type: action.type, selector: action.selector, status: 'ok' })
        } catch (err) {
          stepResult.status = 'failed'
          stepResult.actions.push({ type: action.type, selector: action.selector, status: 'failed', error: err.message })
          result.valid = false
          result.issues.push({
            type: err.message.includes('intercepts pointer events') ? 'OVERLAY_BLOCKING' : 'ACTION_FAILED',
            step: stepResult.stepNumber,
            detail: `${action.type} ${action.selector || ''} failed: ${err.message}`,
          })
          break
        }
      }

      result.steps.push(stepResult)
      if (stepResult.status === 'failed') break
    }
  } catch (err) {
    result.valid = false
    result.issues.push({ type: 'SETUP_FAILED', step: 0, detail: err.message })
  } finally {
    await browser.close()
  }

  return result
}

function applyFixes(flow, fixes) {
  const fixed = JSON.parse(JSON.stringify(flow))
  const sorted = [...fixes].sort((a, b) => b.beforeStep - a.beforeStep)

  for (const fix of sorted) {
    if (fix.type !== 'INSERT_DISMISS') continue
    const step = fixed.steps[fix.beforeStep - 1]
    if (!step) continue
    step.actions.unshift(fix.action)
    step.description = `[auto-dismiss] ${step.description}`
  }

  return fixed
}

module.exports = { validateFlow, applyFixes }
```

### 4.2 Extract a shared validation action executor

`executeActionForValidation()` must not remain implicit. Define it explicitly by extracting the minimal action execution logic into a shared helper module.

Create:

```javascript
// lib/action-executor.js

const { resolveValue } = require('./resolve-value')

async function executeRecordedAction(page, action, cfg) {
  const value = resolveValue(action.value, cfg)

  switch (action.type) {
    case 'fill':
      await page.locator(action.selector).first().fill(value, { timeout: cfg.timeout })
      return

    case 'click':
      await page.locator(action.selector).first().click({ timeout: cfg.timeout })
      return

    case 'press':
      if (action.selector) {
        await page.locator(action.selector).first().press(action.key, { timeout: cfg.timeout })
      } else {
        await page.keyboard.press(action.key)
      }
      return

    case 'submit':
      await page.locator(action.selector).first().click({ timeout: cfg.timeout })
      return

    case 'waitForURL':
      await page.waitForURL(`**${value}`, { timeout: cfg.timeout })
      return

    case 'select': {
      const triggerSelector = action.triggerSelector || action.selector
      const trigger = page.locator(triggerSelector).first()
      const tagName = await trigger.evaluate(el => el.tagName).catch(() => '')

      if (tagName === 'SELECT') {
        await trigger.selectOption({ index: (action.position || 1) - 1 }, { timeout: cfg.timeout })
        return
      }

      await trigger.click({ timeout: cfg.timeout })
      await page.waitForTimeout(300)

      const options = page.locator('[role="option"], [role="menuitem"], [role="listbox"] li, [cmdk-item], [data-value]')
      const count = await options.count()
      if (count === 0) throw new Error(`No dropdown options found for ${triggerSelector}`)

      const index = Math.min(Math.max((action.position || 1) - 1, 0), count - 1)
      await options.nth(index).click({ timeout: cfg.timeout })
      return
    }

    default:
      throw new Error(`Unsupported validation action type: ${action.type}`)
  }
}

module.exports = { executeRecordedAction }
```

Reason for extracting this module:

- `run-e2e.js` and `flow-validator.js` should not drift on action semantics
- `learn.js` should not depend on an undefined local helper
- validator replay should use the same action contract as recorded flows

### 4.3 Add missing small helpers in `scripts/learn.js`

Define:

```javascript
function askUser(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, answer => resolve((answer || '').trim().toLowerCase())))
}
```

Implementation note:

- `scripts/learn.js` should import the shared executor:

```javascript
const { executeRecordedAction } = require('../lib/action-executor')
```

- `finalizeFlow()` should pass that function into `validateFlow(...)`

```javascript
const validation = await validateFlow(flow, config, executeRecordedAction, authenticate)
```

### 4.4 Add `finalizeFlow(rl, name, opts)` in `scripts/learn.js`

This function is used by:

- `[f]`
- `[d]`
- interrupted session close

`rl` should be explicit in the function signature so prompting is not hidden in closure scope.

Required behavior:

1. build flow object
2. validate unless `skipValidation`
3. if fixes are available and user interaction is allowed, prompt
4. tag failed auto-saves with `_validationStatus` and `_validationIssues`
5. reset recorder state exactly once

Prompting shape:

```javascript
const choice = await askUser(rl, '  Apply fixes [f], save anyway [s], or discard [d]? ')
```

### 4.5 Rewire all save paths

- `[f]` asks for name, then `await finalizeFlow(rl, name)`
- `[d]` auto-finishes with `await finalizeFlow(rl, name, { autoSave: true })`
- interrupted-close path must not rely on awaited async validation or prompts

### 4.6 Make interrupted close handling synchronous-safe

Do not rely on awaited async work inside `rl.on("close")`.

On close:

1. if a flow is in progress, push a draft flow into `recordedFlows`
2. mark it with `_validationStatus: 'skipped'`
3. reset flow state
4. allow the normal synchronous shutdown/save path to persist it

Recommended shape:

```javascript
rl.on('close', () => {
  if (recordingFlow && currentFlowSteps.length > 0) {
    const name = `_draft_flow_${recordedFlows.length + 1}`
    recordedFlows.push({
      name,
      startRoute: flowStartSnapshot?.route,
      steps: currentFlowSteps,
      stepCount: currentFlowSteps.length,
      recordedAt: new Date().toISOString(),
      _validationStatus: 'skipped',
      _validationIssues: ['draft saved during close'],
    })
    resetFlowState()
  }

  clearInterval(poller)
  clearInterval(autoSave)
  browser.close().catch(() => {})
  resolveSession()
})
```

This close path should not validate, prompt, or await anything.

### 4.7 Update help text

The learn-session help output must include:

- `[x]` auto-dismiss blocking overlay
- `[k]` keep pending auto-split as one step

Without this, the new commands are hard to discover.

### 4.8 Success Criteria

- No flow-save path bypasses central validation logic
- Drafts survive interrupted sessions
- Failed validation is visible in saved JSON and in runner logs
- `finalizeFlow` does not depend on hidden access to `rl`
- close-path draft handling does not rely on async completion

---

## Phase 5: Optional AI Classification

> Goal: improve single-page ambiguous batches after deterministic behavior is stable.

This phase stays optional and off by default.

Rules:

- only trigger with `--classify` or env flag
- only trigger when there is no navigation split available
- require `ANTHROPIC_API_KEY`
- on any error or timeout, do nothing and continue with deterministic behavior

AI may:

- drop exploration-only subgroups
- improve descriptions

AI may not:

- be required for correct replay
- change flow schema
- block recording when unavailable

---

## Implementation Order

1. Phase 1: runner overlay handling
2. Phase 2: recorder warnings
3. Phase 3: deterministic split with correct metadata
4. Phase 4: centralized finalization and validation
5. Phase 5: optional AI polish

---

## Definition Of Done

The plan is complete when all of these are true:

1. The current `wimsical` flow replays without the practice-selector overlay failure.
2. Recording a step with a blocking dropdown/modal warns before commit.
3. `[k]` truly preserves a batch as a single step.
4. Split steps retain correct route, landmark, and `stateAfter`.
5. `[f]`, `[d]`, and interrupted sessions all use the same finalization path.
6. Validation failures are visible and optionally auto-fixable.
7. Existing flow files remain compatible with `scripts/run-e2e.js`.
