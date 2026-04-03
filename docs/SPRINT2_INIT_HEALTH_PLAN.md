# Sprint 2 Init Health Plan

This document captures the next phase of init improvements after Sprint 1.

Sprint 1 made init honest:

- init now generates passive-only capabilities
- the runner no longer fakes interactive workflow coverage
- selector evaluation is more reliable

Sprint 2 should make init more useful by generating broader passive health coverage per route.

## Goal

After Sprint 2, a fresh init run should produce meaningful route-level health checks for most discovered pages, not just login and obvious list/table pages.

That means a new `QA_FEATURE_MODEL.json` should contain:

- better `feature.health` blocks
- stable landmarks for each route
- route checks that work without learn sessions

## Product outcome

A user should be able to:

1. run `node scripts/init.js`
2. run `node scripts/run-test.js`
3. get real passive page coverage across the app

without expecting CRUD, form submission, search, or sort replay.

## Scope

Files expected to change:

- [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js)
- [qa/model-generator.ts](/Users/bones/Documents/rondah/opencode/qa/model-generator.ts)
- [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js)
- [README.md](/Users/bones/Documents/rondah/opencode/README.md)

## Deliverables

### 1. Generate `feature.health` for discovered routes

For each feature/page discovered during init, generate a health block with:

- `url_is`
- `no_console_errors`
- `no_error_alerts`
- `landmark_visible`

This should become the main value of init.

### 2. Add landmark ranking

Init should rank candidate landmarks in this order:

1. visible `h1`
2. stable `data-testid`
3. unique visible heading text
4. page title fallback

Avoid brittle landmarks based on dynamic row text, transient counts, or toast messages.

### 3. Improve page classification

Init should distinguish:

- auth pages
- list/table pages
- generic pages with headings only
- form pages without guessing submit workflows
- settings/detail pages

The purpose is better passive route coverage, not more guessed actions.

### 4. Expand passive capability generation carefully

Possible passive outputs:

- `login`
- `view_list`
- `view_page`
- `_health`

Do not add interactive drafts back in Sprint 2.

### 5. Make runner output emphasize health coverage

`run-test.js` should make it obvious when a result came from:

- route health
- passive init capability
- learned interactive capability

This likely means a small reporting improvement in console output and `summary.json`.

## Implementation order

### Phase 1

Add health-block generation in init/model generator using the route and visible landmark data already available during scan.

### Phase 2

Improve landmark extraction and ranking so health checks stay stable across reruns.

### Phase 3

Broaden passive route coverage from table-driven pages to generic headed pages.

### Phase 4

Update README examples and expectations to show:

1. `init`
2. `run-test`
3. `learn`
4. `run-e2e`

## Acceptance criteria

Sprint 2 is complete when:

1. a fresh init model contains health blocks for most discovered routes
2. `run-test.js` executes those health blocks without skipped check types
3. a new project gets useful passive coverage before any learn session
4. docs clearly distinguish passive health coverage from learned interactions

## Explicit non-goals

Sprint 2 does not include:

- replaying form submission from init
- CRUD automation from init
- sort/search/pagination replay from init
- replacing learn mode

Those remain part of later learned interaction work.
