# Problem Report: "wimsical" E2E Flow Failure

## Summary

The learned flow "wimsical" failed at Step 2 because a **practice-selector dropdown overlay** was left open from Step 1, blocking clicks on sidebar navigation links. The root cause is a combination of **how learn.js groups actions** and **missing state-cleanup awareness** in the E2E runner.

---

## What Happened

### Step 1 — Passed (but left the app in a bad state)

The agent recorded **6 clicks** as a single step:

```
1. click "Enable Notifications"     ← dismissed a notification prompt
2. click "Select practice"          ← OPENED the practice dropdown
3. click "Live"                     ← tab filter inside dropdown
4. click "Onboarding"               ← tab filter inside dropdown
5. click "Deactivated"              ← tab filter inside dropdown
6. click "All"                      ← tab filter inside dropdown
```

**Problem:** The user was exploring the practice-selector dropdown (browsing tabs), but never **closed** it. The step ended with the dropdown **still open**.

Evidence from the screenshot at end of Step 1:

![Step 1 screenshot](qa-results/screenshots/e2e_wimsical_step1.png)

The dropdown is still open showing "No authorized practices" with All/Live/Onboarding/Deactivated tabs visible.

### Step 2 — Failed

First action was to click `a:has-text('Reports')` in the sidebar.

**Error:**
```
<div class="fixed inset-0 z-40 bg-black/5 backdrop-blur-[2px]"></div>
from <div data-sidebar="header"> subtree intercepts pointer events
```

The practice-selector dropdown has a **backdrop overlay** (`fixed inset-0 z-40`) that covers the entire viewport. Playwright found the "Reports" link but couldn't click it because the overlay intercepts all pointer events.

The sidebar link exists and is visible (Playwright resolved the locator), but it's **behind** the overlay — a z-index stacking issue.

---

## Root Cause Analysis

### Issue 1: learn.js doesn't track overlay/modal state

When recording, the agent groups all interactions between `[Enter]` presses as one step. It captures what you clicked but doesn't understand that:

- "Select practice" **opened** a dropdown with a backdrop overlay
- Clicking "All" tab inside the dropdown **didn't close** the dropdown
- The step ended with the dropdown open = the app is in a **modal state**

The `stateAfter` snapshot shows `"[role='dialog']": 1` confirming a dialog was open, but the runner doesn't use this info to close it before Step 2.

### Issue 2: E2E runner has no overlay-dismissal logic

When Step 2 starts, the runner doesn't check if there's an overlay/modal/dropdown blocking the page. It immediately tries to click the next selector and times out for 10 seconds.

The runner **could** handle this by:
1. Detecting blocking overlays before each step
2. Pressing `Escape` or clicking outside to dismiss them
3. Retrying the action after dismissal

### Issue 3: learn.js recorded exploration as intentional actions

The user was **exploring** the practice selector (clicking through tabs), not performing a meaningful test action. But learn.js can't distinguish between:
- **Intentional test steps** (navigate to Reports, select a date range)
- **Exploration/browsing** (opening a dropdown, looking at tabs, then moving on)

Everything between `[Enter]` presses gets bundled as a single step, regardless of intent.

### Issue 4: Step granularity is too coarse

Step 2 bundles **5 completely different actions** into one step:

```
1. click "Reports" link              ← NAVIGATION (sidebar click)
2. waitForURL /home/reports           ← URL change
3. click "Mar 01, 2026 - Apr 01..."  ← DATE PICKER (open calendar)
4. click "7"                          ← DATE SELECTION (pick start date)
5. click "23"                         ← DATE SELECTION (pick end date)
```

These are logically separate — navigation vs. filter interaction vs. date selection. If action 1 fails, actions 2-5 can't even run, and the error message doesn't help identify which logical task failed.

Similarly Step 3 bundles **12 actions** spanning 6 different page navigations:

```
Action Centre → My Notifications → System Health → Practice Notifications → Analytics → Select practices
```

This is essentially "visit every sidebar link" — a smoke test, not an E2E flow. The agent recorded all of it as one step because the user only pressed `[Enter]` once.

---

## Specific Bugs in learn.js

### Bug 1: No overlay detection on step commit

**File:** `scripts/learn.js` ~line 686

When the user presses `[Enter]` to commit a step, `captureState()` records element counts including `[role='dialog']` but this information is not used to warn the user:

```
"[role='dialog']": 1   ← dialog is open, but learn.js doesn't flag this
```

**Fix:** After capturing state, check for open modals/dialogs/overlays. If found, warn:
```
⚠ Dialog/overlay is still open. This may block the next step.
  Press [Enter] to dismiss it first, or [s] to skip.
```

### Bug 2: No escape/close action before cross-step transitions

**File:** `scripts/run-e2e.js`

Between steps, the runner should check for blocking elements:

```javascript
// Before each step, dismiss any blocking overlays
const overlay = page.locator('[class*="fixed"][class*="inset-0"], [role="dialog"]')
if (await overlay.count() > 0) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}
```

### Bug 3: collapseEvents doesn't separate by navigation boundaries

**File:** `scripts/learn.js`, `collapseEvents()` function

All events between `[Enter]` presses become one step. But if a `waitForURL` event exists in the middle, that's a page transition — it should automatically split into a new step.

---

## What the User Likely Intended

Based on the recorded actions, the user probably wanted this test flow:

```
Step 1: Dismiss notification prompt
  → click "Enable Notifications" (or dismiss it)
  → verify: notification dismissed

Step 2: Navigate to Reports
  → click "Reports" in sidebar
  → verify: URL is /home/reports, h1 is "Reports"

Step 3: Select date range
  → click date range picker
  → select start date (7th)
  → select end date (23rd)
  → verify: report data updates

Step 4: Navigate through other pages (smoke check)
  → Action Centre → verify loaded
  → My Notifications → verify loaded
  → System Health → verify loaded
  → etc.

Step 5: Open Analytics and select practice
  → click Analytics
  → click "Select practices"
  → select option 3
  → verify: dashboard data loads
```

Instead, learn.js recorded it as 3 giant steps with everything batched together.

---

## Recommendations

### Short-Term Fixes (run-e2e.js)

1. **Add overlay dismissal before each step** — Press `Escape` if a blocking overlay is detected
2. **Add `{ force: true }` option for clicks blocked by overlays** — As a fallback when Escape doesn't work
3. **Increase timeout for first action in a step** — The first action often involves page transition

### Medium-Term Fixes (learn.js)

1. **Warn when committing a step with an open dialog/overlay** — Let the user close it first
2. **Auto-split steps on URL changes** — If `waitForURL` appears in pending events, split into separate steps
3. **Detect and ignore exploration patterns** — If user opens a dropdown, clicks tabs, but never selects a value, don't record the dropdown interaction
4. **Suggest step boundaries** — When the user presses `[Enter]` with 10+ actions, suggest splitting

### Long-Term (Agent Intelligence)

1. **Semantic step grouping** — Use AI to classify actions: "this is navigation", "this is form filling", "this is exploration"
2. **State machine awareness** — Track modal/overlay state and automatically insert dismiss actions
3. **Flow validation before save** — Replay the flow immediately after recording to catch issues like this before the user ends the session
