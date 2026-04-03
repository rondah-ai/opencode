# Production Health Test Plan

This document defines how init-generated testing should work in production, based on the current behavior of `init`, `run-test.js`, bootstrap replay, and the failures observed on pages like `system_health`, `dashboard`, and `voicemails`.

## Goal

Init-generated tests should answer this question:

`Does this page load correctly in a valid state, without runtime, hydration, or request failures?`

Init-generated tests should not answer this question:

`Does this page currently show rows, tables, or a particular non-error UI state?`

That distinction is critical for production reliability.

## Current Problem Statement

The current init-generated passive model still reflects assumptions like:

- table must exist
- rows must exist
- list layout must be present

Those assumptions are not safe for production health testing because many pages can legitimately render:

- empty states
- filtered states
- first-time setup states
- alternate layouts
- partial data
- state-specific UI variants

A page can be healthy and still have:

- zero rows
- no table
- a placeholder card layout
- a valid suspense/loading shell

At the same time, the test suite should still fail hard on:

- React hydration mismatches
- uncaught runtime exceptions
- missing required API/backend dependencies
- visible error alerts
- navigation to the wrong route

## Evidence From Current Runs

Based on the recent `test:full` run:

- bootstrap replay now works correctly
- `call_logs.view_list` passes
- `system_health.view_list` fails because of hydration mismatch and a runtime exception
- `dashboard.view_list` fails because of `ERR_CONNECTION_REFUSED`
- `voicemails.view_list` fails because of hydration mismatch

Those are real production-grade failures.

The row/table assumptions were previously causing noise, but once bootstrap and row-presence semantics were fixed, the remaining failures were primarily app/runtime failures.

This confirms the main design issue:

`init` should produce route health coverage, not UI-shape assertions.

## Root Design Problems

### Problem 1: Init passive coverage is state-sensitive

Current init templates still generate passive checks such as:

- `custom_selector_visible: table, [role='grid']`
- `element_present: tbody tr, [role='row']`

These checks assume a specific valid state of the page.

That is inappropriate for production health testing where valid empty or alternate states exist.

### Problem 2: Pattern recognition is being used as a test oracle

The scanner sees a table or CRUD-like structure and turns that into a required health assertion.

But pattern recognition should only help describe page structure, not define pass/fail unless the product explicitly wants state assertions.

### Problem 3: Health and state assertions are mixed together

The current `view_list` capability combines:

- page identity
- structural assumptions
- data-state assumptions

Those should be separated.

### Problem 4: Production triage is harder than necessary

When passive tests include state-sensitive checks, failures mix:

- real runtime issues
- harmless data/empty-state variations

That reduces the value of the test signal.

## Desired Production Behavior

For init-generated passive coverage, a page should pass when:

1. the expected route loads
2. a stable page identity landmark is present
3. no runtime/hydration errors occur
4. no console error output occurs
5. no visible blocking error state is rendered
6. required backend/network dependencies do not fail

A page should not fail simply because:

- it has no rows
- it shows an empty state
- it renders a different valid layout
- its visible content is state-dependent

## Proposed Solution

Shift init-generated testing from `view_list`-style structural assertions to route-level `_health` blocks.

### Replace passive list assertions with route health checks

Instead of generating:

- `table_visible`
- `has_rows`

generate:

- `url_is`
- `landmark_visible`
- `no_console_errors`
- `no_error_alerts`
- optional required-request checks

This makes passive tests resilient to valid page-state changes while still failing on true application problems.

### Keep UI patterns as metadata, not assertions

Pattern detection such as:

- `data_table`
- `crud_page`
- `form_generic`

should remain useful for:

- descriptions
- future learn suggestions
- categorization

but should not automatically become pass/fail health criteria.

### Make `_health` the primary init output

Every discovered route should get a `feature.health` block.

That should become the main init-generated test artifact.

Capabilities such as `view_list` should either:

- be removed from init passive coverage entirely, or
- be downgraded to optional descriptive metadata

## Implementation Plan

### Phase 1: Redefine init output

Files:

- [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js)
- [qa/model-generator.ts](/Users/bones/Documents/rondah/opencode/qa/model-generator.ts)

Changes:

1. Stop emitting state-sensitive passive checks:
   - remove `table_visible`
   - remove `has_rows`

2. Generate `feature.health` for all discovered routes.

3. Health block format should include:
   - `route`
   - `landmark`
   - `checks`

4. Checks should default to:
   - `url_is`
   - `landmark_visible`
   - `no_console_errors`
   - `no_error_alerts`

5. Keep detected patterns in the scan/model metadata, but do not convert them into required row/table assertions.

Acceptance:

- a fresh init model no longer requires rows or tables to pass
- every relevant discovered route has a health block

### Phase 2: Improve landmark generation

Files:

- [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js)
- [qa/model-generator.ts](/Users/bones/Documents/rondah/opencode/qa/model-generator.ts)

Changes:

1. Rank landmarks in this order:
   - `data-page`
   - stable `data-testid`
   - visible `h1`
   - visible `h2`
   - page title fallback

2. Avoid dynamic or content-sensitive landmarks.

3. Do not use row text or counts as a page identity signal.

Acceptance:

- each route gets a stable identity check
- page health remains resilient across valid state changes

### Phase 3: Strengthen runner error classification

Files:

- [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js)

Changes:

1. Continue to fail hard on:
   - hydration mismatch
   - runtime exceptions
   - console errors
   - visible error alerts

2. Add better categories in result output:
   - `runtime_error`
   - `hydration_error`
   - `request_failure`
   - `visible_error_state`

3. Record request failure metadata:
   - URL
   - resource type
   - failure reason

Acceptance:

- production failures become easier to triage
- output clearly separates app failures from state variation

### Phase 4: Add request-level production health checks

Files:

- [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js)

Changes:

1. Track `requestfailed` events during page load.
2. Decide which failures are hard failures by policy.
3. Optionally support route-level required request patterns in the future.

Acceptance:

- pages fail with actionable network details instead of opaque `ERR_CONNECTION_REFUSED`

### Phase 5: Separate passive health from stateful expectations

Files:

- [README.md](/Users/bones/Documents/rondah/opencode/README.md)
- [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js)
- [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js)

Changes:

1. Define passive init coverage as:
   - route loads
   - landmark visible
   - no runtime/request errors

2. Define stateful expectations as:
   - rows present
   - widgets visible
   - dashboard content assertions
   - data-specific assertions

3. Reserve stateful expectations for:
   - learned interactions
   - explicit health policies
   - route-specific custom checks

Acceptance:

- the docs match the production testing philosophy
- init no longer overspecifies valid UI states

## Recommended JSON Shape

Example desired route health output:

```json
{
  "dashboard": {
    "route": "/home/dashboard",
    "requires": ["authenticated"],
    "health": {
      "route": "/home/dashboard",
      "landmark": {
        "selector": "h1",
        "text": "Dashboard"
      },
      "checks": [
        { "type": "url_is", "value": "/home/dashboard" },
        { "type": "no_console_errors" },
        { "type": "no_error_alerts" }
      ]
    },
    "capabilities": {}
  }
}
```

The important point is that health is about correctness of load, not about a table/row state.

## Recommended Pass/Fail Policy

### Should fail

- hydration mismatch
- uncaught runtime exception
- console error during load
- visible blocking error state
- refused/failed required requests
- wrong route
- missing identity landmark

### Should not fail by default

- zero rows
- empty list
- empty dashboard
- different valid layout for the same route
- missing data-dependent widgets when the page is otherwise healthy

## Migration Strategy

### Step 1

Implement route-level health generation without deleting old capability fields immediately.

### Step 2

Update `run-test.js` to prioritize `feature.health` for passive init runs.

### Step 3

Remove row/table passive assertions from init templates.

### Step 4

Regenerate `QA_FEATURE_MODEL.json` for the current app.

### Step 5

Update docs and examples to reflect the new philosophy.

## Risks

### Risk 1: Health may become too shallow

Mitigation:

Keep runtime, hydration, and network integrity checks strict.

### Risk 2: Some truly required UI structures may no longer be checked

Mitigation:

Allow explicit custom route health policies later for pages that truly require specific widgets.

### Risk 3: Existing models may mix old and new semantics

Mitigation:

Version the model or add a migration path for passive checks.

## Definition of Done

This work is done when:

1. init-generated passive tests no longer require rows or tables
2. every discovered route gets route-level health checks
3. runtime/hydration/network failures remain hard failures
4. valid empty or alternate page states pass
5. docs clearly explain passive health vs stateful expectations

## Recommended Next Implementation

The next concrete code change should be:

1. generate `feature.health` blocks for every discovered route
2. stop generating row/table checks as passive init assertions
3. make `run-test.js` prefer `_health` blocks for init-generated routes

That is the cleanest path to production-grade passive testing.
