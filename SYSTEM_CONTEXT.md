# Rondar — System Context & Progress

> Architecture, implementation details, and progress tracking for the Rondar QA agent.

---

## Architecture

```
opencode/
├── bin/qa-agent.js              # CLI entry point
├── index.js                     # Module entry
├── scripts/                     # Main executable scripts
│   ├── init.js                  # Scan app → feature model + health blocks
│   ├── learn.js                 # Interactive learning + E2E recording
│   ├── run-test.js              # Health check runner (categorized errors)
│   ├── run-e2e.js               # E2E replay with overlay handling + healing
│   └── migrate.js               # Legacy file migration
├── lib/                         # Shared helpers
│   ├── page-state.js            # Overlay/modal/dropdown detection + dismissal
│   ├── resolve-value.js         # $EMAIL/$PASSWORD variable substitution
│   ├── step-splitter.js         # Navigation-boundary step splitting
│   ├── action-executor.js       # Minimal action executor (for validation)
│   ├── flow-validator.js        # Instant replay validation + auto-fix
│   └── bootstrap.js             # Bootstrap record/replay for init/test
├── qa/                          # Core QA logic (TypeScript)
│   ├── feature-model.ts         # Zod schema + loader
│   ├── patterns.ts              # UI pattern recognition
│   ├── model-generator.ts       # Feature model + health block generation
│   ├── model-merger.ts          # Merge learn sessions into model
│   ├── interaction-tracker.ts   # Browser event capture
│   ├── session-recorder.ts      # E2E flow recording
│   └── state-snapshot.ts        # Page state snapshots
├── browser/manager.ts           # Playwright lifecycle
├── tools/                       # AI agent tools (28 TypeScript files)
└── hybrid/                      # Hybrid mode support
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js >= 18 (CommonJS) |
| Browser | Playwright |
| Validation | Zod |
| AI (optional) | Anthropic Claude SDK |

---

## Implementation Status

### Agent Intelligence (E2E Replay + Recording)

> Fixes overlay failures, improves recording quality, adds flow validation.

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Replay Reliability — overlay dismissal, action retry, force-click fallback | DONE |
| 2 | Recorder Guardrails — overlay warnings, [x] dismiss, large-step warnings | DONE |
| 3 | Deterministic Step Splitting — nav-boundary split, [k] keep-as-one | DONE |
| 4 | Centralized Flow Finalization — validation on all save paths, draft recovery | DONE |
| 5 | Optional AI Classification — exploration filtering (behind --classify flag) | NOT STARTED |

### Production Health Testing

> Shifts init-generated tests from state assertions to route-level health checks.

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Health blocks from init — every route gets url_is, no_js_errors, no_console_errors, no_error_alerts | DONE |
| 2 | Landmark enrichment — data-page > data-testid > h1 > h2 > title priority | DONE |
| 3 | Error tracking + triage — split JS/console/request errors, hydration detection, categories | DONE |
| 4 | Regenerate + validate | DONE |

---

## Key Implementation Details

### Overlay Handling (lib/page-state.js)

`capturePageState(page)` detects three types of blockers:
- **Overlays**: fixed/absolute elements covering >80% of viewport with zIndex > 0
- **Modals**: `[role="dialog"]`, `dialog[open]`, `[aria-modal="true"]` with backdrop
- **Dropdowns**: `[aria-expanded="true"]`, `[data-state="open"]` with backdrop

`dismissBlockingOverlays(page)` tries up to 3 times: Escape → backdrop click → repeat.

Used in:
- `run-e2e.js` — pre-step dismissal + action-level retry on `intercepts pointer events`
- `learn.js` — warns before committing a step with open overlay ([x] to dismiss)

### Step Splitting (lib/step-splitter.js)

`splitOnNavigation(events)` splits on:
- `ev.type === "navigation"` (explicit navigation events)
- `ev._urlChanged` (SPA transitions detected by URL polling)

Each split group gets its own snapshot/route/landmark via `getGroupSnapshot`/`getGroupRoute` walking backward through the group to find the nearest `_snapshotAfter`.

### Flow Validation (lib/flow-validator.js)

`validateFlow(flow, config, executeActionFn, authenticateFn)`:
1. Launches headless browser
2. Authenticates
3. Replays each step
4. Before each step, checks for blocking overlays
5. On overlay found: records issue + suggests INSERT_DISMISS fix
6. On action failure: records issue + stops
7. Returns `{ valid, issues, fixes }`

`applyFixes(flow, fixes)` inserts dismiss actions at the right positions.

### Flow Finalization (learn.js)

All save paths route through `finalizeFlow(name, opts)`:
- `[f]` — validates, prompts user: apply fixes / save anyway / discard
- `[d]` — validates with `autoSave: true`, tags failures
- `rl.on("close")` — synchronous draft save, no validation (process exiting)

`normalShutdown` flag prevents the close handler from interfering with `[d]`'s save/merge/cleanup.

### Health Block Generation (model-generator.ts + init.js)

`buildHealthBlock(route, pageScan)` generates for every crawled route:
```json
{
  "route": "/home/reports",
  "landmark": { "selector": "h1", "text": "Reports" },
  "checks": [
    { "type": "url_is", "value": "/home/reports" },
    { "type": "no_js_errors" },
    { "type": "no_console_errors" },
    { "type": "no_error_alerts" }
  ]
}
```

`pickInitLandmark(pageScan)` priority: `data-page` > `data-testid` > `h1` > `h2` > page title.

Routes with no pattern match still get a health-only feature (empty `capabilities: {}`).

### Error Categorization (run-test.js)

Three separate tracking arrays:
- `consoleErrors` — `console.error()` calls
- `jsErrors` — uncaught exceptions (`pageerror`)
- `requestFailures` — failed network requests (`requestfailed`)

Health check categories:
- `no_js_errors` → detects `hydration_error` via regex, else `runtime_error`
- `no_console_errors` → `console_error`
- `no_request_failures` → `request_failure` (only fetch/xhr, ignores static assets)

Old `no_errors` capability check combines both arrays for backward compat.

### Bootstrap Replay (lib/bootstrap.js)

- Recording uses a **separate browser context** (discarded after save)
- Replay always runs on a **fresh context** (no stale cookies)
- Steps before the first `navigation` event are critical (auth) — failures abort
- Steps after navigation are best-effort (setup prompts) — failures are logged, not fatal
- Click-before-fill patterns are auto-skipped

---

## Post-Review Fixes

Issues caught during review and fixed:

1. **Close-path draft persistence** — `rl.on("close")` now writes flows to disk on interrupted close
2. **askUser lowercased flow names** — Split into `askLine()` (preserves case) and `askChoice()` (lowercased)
3. **SPA route derivation** — `getGroupRoute()` checks `_snapshotAfter.route` for SPA transitions
4. **Normal [d] duplicated flows** — `normalShutdown` flag prevents close handler from double-writing
5. **Close handler was general save path** — Gated behind `!normalShutdown`, only runs on interrupted close
6. **Normal [d] resolved promise too early** — Close handler does `if (normalShutdown) return` with no side effects
7. **Init health blocks missing in JS copy** — `buildHealthBlock`/`pickInitLandmark` added to init.js inline generator
8. **Bootstrap stale cookies** — Recording now uses separate context, closed before replay

---

## Files Changed (All Implementations)

| File | What Changed |
|------|-------------|
| `lib/page-state.js` | NEW — overlay detection + dismissal |
| `lib/resolve-value.js` | NEW — shared $EMAIL/$PASSWORD resolver |
| `lib/step-splitter.js` | NEW — navigation-boundary splitting |
| `lib/action-executor.js` | NEW — minimal action executor for validation |
| `lib/flow-validator.js` | NEW — instant replay validation + auto-fix |
| `lib/bootstrap.js` | MODIFIED — separate recording context, best-effort post-nav steps, click-before-fill skip |
| `scripts/run-e2e.js` | MODIFIED — overlay dismissal, action retry, waitForStableState, known-broken flow warnings |
| `scripts/learn.js` | MODIFIED — [x]/[k] commands, overlay/large-step warnings, split preview, finalizeFlow, draft save |
| `scripts/run-test.js` | MODIFIED — split error tracking, hydration detection, no_request_failures, categories |
| `scripts/init.js` | MODIFIED — health blocks, landmark capture, separate bootstrap context, removed row/table assertions |
| `qa/model-generator.ts` | MODIFIED — HealthBlock interface, buildHealthBlock, pickInitLandmark, removed row/table assertions |
