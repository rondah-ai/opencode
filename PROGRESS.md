# Agent Intelligence v3 — Implementation Progress

> Tracking document for the v3 implementation plan.
> See `AGENT_INTELLIGENCE_PLAN_V3.md` for full details.

---

## Status Overview

| Phase | Description | Status | Files |
|-------|-------------|--------|-------|
| **1** | Replay Reliability | DONE | `lib/page-state.js`, `lib/resolve-value.js`, `scripts/run-e2e.js` |
| **2** | Recorder Guardrails | DONE | `scripts/learn.js` |
| **3** | Deterministic Step Splitting | DONE | `lib/step-splitter.js`, `scripts/learn.js` |
| **4** | Centralized Flow Finalization | DONE | `lib/flow-validator.js`, `lib/action-executor.js`, `scripts/learn.js` |
| **5** | Optional AI Classification | NOT STARTED | `lib/action-classifier.js`, `scripts/learn.js` |

---

## Phase 1: Replay Reliability

> Goal: existing broken flows replay more reliably without re-recording.

### Tasks

- [x] 1.1 Create `lib/page-state.js` — overlay detection + dismissal helpers
- [x] 1.2 Create `lib/resolve-value.js` — shared variable resolver (extracted from run-e2e.js)
- [x] 1.3 Modify `run-e2e.js` — use shared `resolveValue` from lib
- [x] 1.4 Modify `run-e2e.js` — extract `executeActionInner()` from `executeAction()`
- [x] 1.5 Modify `run-e2e.js` — add action retry on `intercepts pointer events`
- [x] 1.6 Modify `run-e2e.js` — add pre-step overlay dismissal in `executeStep()`
- [x] 1.7 Modify `run-e2e.js` — add `waitForStableState()` helper, replace settle wait
- [x] 1.8 Modify `run-e2e.js` — warn on known-broken flows at load time

### Verification

- [x] Existing flow schema unchanged — no changes to JSON read/write
- [x] Runner logs when it auto-dismisses or retries — log lines at each stage
- [x] No regressions in normal flow replay — all existing code paths preserved

---

## Phase 2: Recorder Guardrails

> Goal: prevent obviously bad steps from being recorded silently.

### Tasks

- [x] 2.1 Add recorder state flags (`overlayWarningAcknowledged`, `largeStepWarningAcknowledged`)
- [x] 2.2 Add `[x]` command for auto-dismiss
- [x] 2.3 Add overlay warning before step commit
- [x] 2.4 Add large-step warning (>8 actions)
- [x] 2.5 Update help text with `[x]` command

### Verification

- [x] Open dropdown/modal at step commit produces warning — checked via `capturePageState`
- [x] `[x]` dismisses without restarting session — calls `dismissBlockingOverlays`, returns
- [x] Large steps warned but not blocked — second Enter proceeds, flag resets

---

## Phase 3: Deterministic Step Splitting

> Goal: split navigation-heavy batches into valid step objects with correct metadata.

### Tasks

- [x] 3.1 Create `lib/step-splitter.js` — `splitOnNavigation`, `getGroupSnapshot`, `getGroupRoute`
- [x] 3.2 Capture navigation snapshots in poller — `ev._snapshotAfter` on navigation events
- [x] 3.3 Tag URL changes without explicit navigation events — `_urlChanged` + `_snapshotAfter`
- [x] 3.4 Add split preview + `[k]` keep-as-one support — `splitPreview`, `forceSingleStepOnce`, [k] handler
- [x] 3.5 Build full step objects from groups — inline in Enter handler using per-group snapshot/route/landmark

### Verification

- [x] `[k]` truly keeps batch as one step — sets `forceSingleStepOnce`, bypasses split check
- [x] Navigation-heavy recordings split correctly — `splitOnNavigation` splits on `navigation` and `_urlChanged`
- [x] Split steps have correct per-group route/state/landmark — `getGroupSnapshot`/`getGroupRoute` walk backward through group

---

## Phase 4: Centralized Flow Finalization

> Goal: all save paths use one implementation.

### Tasks

- [x] 4.1 Create `lib/flow-validator.js` — `validateFlow` + `applyFixes`
- [x] 4.2 Create `lib/action-executor.js` — `executeRecordedAction` (minimal, no healing)
- [x] 4.3 Add `askUser()` and `resetFlowState()` helpers in learn.js
- [x] 4.4 Add `finalizeFlow(name, opts)` in learn.js — central save path
- [x] 4.5 Rewire `[f]` handler — uses `askUser` + `finalizeFlow`
- [x] 4.6 Rewire `[d]` handler — uses `finalizeFlow(name, { autoSave: true })`
- [x] 4.7 Make close handler synchronous-safe — pushes draft, no async

### Verification

- [x] No flow-save path bypasses validation — [f], [d], close all route through finalizeFlow or tagged draft
- [x] Drafts survive interrupted sessions — close handler saves `_draft_flow_*` with `_validationStatus: 'skipped'`
- [x] Failed validation visible in JSON and runner logs — `_validationStatus`/`_validationIssues` in JSON, runner warns at load

---

## Phase 5: Optional AI Classification

> Goal: improve single-page ambiguous batches (optional, off by default).

### Tasks

- [ ] 5.1 Create `lib/action-classifier.js`
- [ ] 5.2 Add `--classify` flag to learn.js
- [ ] 5.3 Integrate after deterministic split

### Verification

- [ ] Works without AI (deterministic handles nav boundaries)
- [ ] With `--classify`, exploration dropped
- [ ] API failure falls back silently

---

## Notes

### Phase 1 Implementation Notes

- `lib/page-state.js`: Plain functions, no classes. `capturePageState()` runs inside `page.evaluate()` so DOM scanning is browser-side. `minSelector()` handles SVGAnimatedString edge case via `typeof el.className === 'string'` check.
- `lib/resolve-value.js`: Extracted from `run-e2e.js` line 97-107. Identical logic, now importable by both `run-e2e.js` and future `lib/action-executor.js` (Phase 4).
- `run-e2e.js` refactoring: `executeAction()` now wraps `executeActionInner()`. The inner function contains the original action switch unchanged. The outer function adds overlay retry logic: dismiss → retry → force-click fallback. This keeps the healing/selector-resolution path intact.
- `waitForStableState()`: Replaces the old `networkidle + 500ms wait`. Now also waits for CSS animations to finish (max 2s cap) before the 300ms settle.
- Known-broken flow warnings: Added at flow load time (after filtering). Reads `_validationStatus` and `_validationIssues` — these fields will be set by Phase 4's `finalizeFlow()`.

### Phase 2 Implementation Notes

- Guardrail flags (`overlayWarningAcknowledged`, `largeStepWarningAcknowledged`) use acknowledge-on-first, proceed-on-second pattern. Never hard-blocks the user.
- `[x]` command reuses `dismissBlockingOverlays` from `lib/page-state.js` — same dismiss strategies as the runner.
- Overlay check runs only inside `if (recordingFlow)` — health checkpoints don't need it since they're observation-only.

### Phase 3 Implementation Notes

- Poller now captures `_snapshotAfter` on navigation events and tags `_urlChanged` on SPA transitions.
- Split preview shows a preview and waits for confirmation. Second Enter accepts, `[k]` cancels.
- `forceSingleStepOnce` flag ensures [k] → Enter truly commits as one step, then resets.
- Each split group gets its own snapshot/route/landmark via `getGroupSnapshot`/`getGroupRoute` walking backward through the group.

### Phase 4 Implementation Notes

- `finalizeFlow()` is defined inside the `resolveSession` promise closure so it has access to `recordingFlow`, `currentFlowSteps`, `flowStartSnapshot`, `recordedFlows`, and other session state.
- `askUser()` wraps `rl.question` in a Promise — simpler than passing `rl` as a parameter since it's in the same closure.
- The close handler is strictly synchronous — pushes a draft flow object directly to `recordedFlows`, which gets persisted by the existing `fs.writeFileSync` in the `[d]` handler's session finish code.
- `lib/action-executor.js` mirrors the action switch in `run-e2e.js` but without selector healing. Validator doesn't need healing — it tests whether primary selectors work.

### Post-Review Fixes

Three issues found during analysis, all fixed:

1. **High — close-path draft persistence**: `rl.on("close")` now writes `recordedFlows` to `QA_RECORDED_FLOWS.json` directly via `fs.writeFileSync`, mirroring the `[d]` handler's save logic. Drafts survive unexpected stdin close.
2. **Medium — `askUser` lowercased flow names**: Split into `askLine()` (preserves case, used for flow names) and `askChoice()` (lowercased, used for [f]/[s]/[d] prompts).
3. **Medium — SPA route derivation incomplete**: `getGroupRoute()` now checks `_snapshotAfter.route` in addition to `navigation` events, so SPA transitions that change URL without emitting a navigation event get the correct route.

### Post-Review Fix (Round 2)

4. **High — normal [d] shutdown duplicated flows**: The `[d]` handler calls `rl.close()` which triggers the close handler, causing flows to be written twice. Fixed with `normalShutdown` flag — `[d]` sets it before `rl.close()`, close handler early-returns when flag is true. Close handler persistence now only runs on interrupted/unexpected close.
5. **Medium — close handler was a second general save path**: Gated behind `!normalShutdown` check. Draft recovery and disk persistence only run when the session was interrupted, not on clean exit.

### Post-Review Fix (Round 3)

6. **High — normal [d] resolved session promise too early**: Close handler was calling `resolveSession()` + `browser.close()` on normal shutdown, racing with the [d] handler's save/merge work. Fixed: close handler now does `if (normalShutdown) return` with no side effects — [d] handler owns the full lifecycle (saves, browser close, resolveSession).
