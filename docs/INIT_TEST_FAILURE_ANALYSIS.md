# Init Test Failure Analysis

This document explains why `npm run test:full -- --url http://localhost:3000 --email john@mail.com --password 123456 --no-headless` fails when the model was produced only by `init`.

## Short version

`init` is not producing a validated test suite. It produces a guessed skeleton model.

The current `QA_FEATURE_MODEL.json` explicitly says that:

- `meta.generated_by` is `"init"`
- `meta.learn_sessions` is `0`
- `meta.confidence` is `"skeleton"`
- every capability has `_confidence: "init"`

See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L3).

That matters because `scripts/init.js` generates capabilities from hardcoded UI patterns, not from observed user interactions. See the pattern-to-capability mapping in [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js#L132).

## What `init` actually does

`init` scans pages, recognizes patterns like:

- auth form
- data table
- CRUD page
- generic form
- search/filter

It then writes generic capabilities such as:

- `login_invalid`
- `view_list`
- `sort`
- `submit_form`
- `submit_invalid`

Those capabilities are templates. They are not learned from your app. Examples:

- `data_table.view_list` assumes `table, [role='grid']` and `tbody tr, [role='row']`
- `form_generic.submit_form` assumes a submit action should create a toast
- `form_generic.submit_invalid` assumes validation appears in `[role='alert'], .error, .text-red-500`

See [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js#L151), [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js#L177), and [scripts/init.js](/Users/bones/Documents/rondah/opencode/scripts/init.js#L233).

## What `run-test.js` actually executes

For normal capabilities, `run-test.js` does not replay the interaction text from the model.

It:

1. logs in for `authentication.login`
2. navigates to the capability route
3. captures element counts before and after navigation
4. evaluates verify checks against those counts

See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L325) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L363).

That means these interaction descriptions are not actually performed during `test:full`:

- `fill invalid credentials, click submit`
- `click column header to sort`
- `fill all required fields, click submit`
- `submit form with empty required fields`

They are only strings in the model right now.

## Why the current run failed

Your run had 6 capabilities:

- `authentication.login`
- `authentication.login_invalid`
- `dashboard.view_list`
- `dashboard.sort`
- `practice.submit_form`
- `practice.submit_invalid`

See [qa-results/summary.json](/Users/bones/Documents/rondah/opencode/qa-results/summary.json#L1).

### 1. `authentication.login` passed

This is the only capability with special execution logic. The runner explicitly fills email and password and submits the form. See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L325) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L521).

### 2. `authentication.login_invalid` failed by design

The model says this capability should fill invalid credentials and submit. See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L32).

But `run-test.js` has no special handling for `login_invalid`. It does not fill invalid credentials. It only navigates to the auth route and then checks whether an error element appeared.

Since no invalid submission happened, no error is expected to appear.

There is a second problem: the verify selector is `"[role='alert'], .text-red-500, .error"`, but state capture stores counts only for exact keys in `MONITORED_SELECTORS`. That exact combined selector is not in the monitored list. See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L165) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L585).

Result: this check trends to `0 -> 0` even if the page did show something close to that selector.

### 3. `dashboard.view_list` failed because the skeleton check is too generic and partly incompatible with the runner

The generated capability expects:

- table visible
- rows appear

See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L60).

There are two separate issues here:

- `custom_selector_visible` is not implemented in `runCheck`, so when the runner navigates from another page into `/home/dashboard`, this check is marked as "Unhandled check type: custom_selector_visible (skipped)". See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L574).
- `has_rows` uses selector `"tbody tr, [role='row']"`, but `captureState()` never records counts for that exact combined selector. It records `"tbody tr"` only. See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L165) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L552).

So the check can report `0 -> 0` even when the table is present.

### 4. `dashboard.sort` passed, but it is a false positive

The model says this capability means "click column header to sort". See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L81).

No click happens.

The runner was already on `/home/dashboard`, so it used `runStaticCheck()`. In that mode, `element_count_changed` is treated as "selector exists" rather than "count changed". See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L641) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L669).

That means:

- the sort action was never executed
- the row order was never compared
- the test passed only because `tbody tr` existed

This is not a real sort test.

### 5. `practice.submit_form` failed because no form submission happened

The model says this capability should fill fields and submit, then expect a toast. See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L108).

`run-test.js` does not fill the form or submit it. It only navigates to `/home/notifications/practice`.

Then it runs `toast_appeared`, which compares a synthetic selector key:

- `".toast, [data-sonner-toast], [role='alert']"`

But `captureState()` stores:

- `".toast, [data-sonner-toast]"`
- `"[role='alert']"`

as separate keys, not the combined key used by `toast_appeared`. See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L165) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L624).

So `toast_appeared` is effectively wired to read from a missing counter and commonly returns `0 -> 0`.

### 6. `practice.submit_invalid` failed because no invalid submission happened, and the selector is another exact-key mismatch

The model expects an error after submitting an invalid form. See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L128).

But again:

- no invalid submission is executed
- the check uses exact selector `"[role='alert'], .error, .text-red-500"`
- `captureState()` does not record that exact selector string

So the check reports `0 found`.

## Structural problems in the current implementation

These are the main reasons `init`-only models are unreliable under `test:full`.

### Problem 1. `init` creates guessed capabilities, not learned ones

This is visible in the model metadata and `_confidence: "init"` flags. See [QA_FEATURE_MODEL.json](/Users/bones/Documents/rondah/opencode/QA_FEATURE_MODEL.json#L3).

### Problem 2. `run-test.js` does not execute most capability interactions

Only `authentication.login` has real action logic.

For most capabilities, the runner ignores `interaction` and only navigates plus verifies. See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L325) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L363).

### Problem 3. verify checks depend on exact selector-string matches

`captureState()` stores counts under the selector string it captured. `runCheck()` then reads by exact selector string. If the verify selector is not byte-for-byte identical to a monitored selector, the count is read as zero.

See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L552) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L585).

This affects:

- `"[role='alert'], .text-red-500, .error"`
- `"tbody tr, [role='row']"`
- `"[role='alert'], .error, .text-red-500"`
- `".toast, [data-sonner-toast], [role='alert']"`

### Problem 4. `custom_selector_visible` is inconsistently supported

- `runStaticCheck()` supports it
- `runCheck()` does not

So the result depends on whether the runner was already on the target route.

See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L574) and [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L651).

### Problem 5. `element_count_changed` is downgraded to "element exists" in static mode

That makes actions like sort/search/pagination pass without actually changing anything.

See [scripts/run-test.js](/Users/bones/Documents/rondah/opencode/scripts/run-test.js#L669).

## About the CLI flags in your command

This part is also important:

```bash
npm run test:full -- --url http://localhost:3000 --email john@mail.com --password 123456 --no-headless --slow-mo 300
```

`--slow-mo` is not used by `scripts/run-test.js`.

The current health runner accepts:

- `--url`
- `--email`
- `--password`
- `--model`
- `--suite`
- `--features`
- `--output-dir`
- `--no-headless`
- `--timeout`
- `--include-init`

So `--slow-mo` is harmless here, but ignored.

## Why this is showing up as "init failing"

Strictly speaking, `init` is not failing.

What is failing is this expectation:

- "a skeleton generated from page patterns should already behave like a real full test suite"

The current implementation does not support that expectation.

Today the lifecycle is:

1. `init` creates a draft model
2. `learn` records real health checkpoints and observed behaviors
3. `test:full` becomes meaningful after the model has learned coverage

That lifecycle is already implied in the model metadata and the learn flow.

## Recommended fixes

If the goal is to make `init`-generated models useful immediately, these are the needed changes.

### High priority

1. Implement actual interaction executors for non-login capabilities in `run-test.js`.
2. Stop using exact selector-string keys for state capture.
3. Implement `custom_selector_visible` in `runCheck()`.
4. Fix `toast_appeared` to query the page directly or reuse normalized selector counts.

### Medium priority

1. Make `login_invalid` explicitly submit wrong credentials instead of treating it as a generic route check.
2. Make `submit_invalid` explicitly submit the form without required fields.
3. Make `sort/search/pagination` compare row content or order, not just row existence.

### Product/UX priority

1. Label `init` output everywhere as "draft" or "skeleton".
2. Warn users that `test:full` on a zero-learn model will be approximate.
3. Document that real reliability starts after at least one `learn` session.

## Immediate next steps

If you want accurate failures right now, do this:

1. Run `learn` and record real checkpoints on dashboard and practice pages.
2. Add feature health blocks and observed capabilities.
3. Re-run `test:full`.

If you want `init` alone to be trustworthy, the code needs changes in `run-test.js`, not just better docs.

## Bottom line

The current failures are mostly runner/model mismatches, not proof that the app is broken.

The biggest reasons are:

- skeleton capabilities are guesses
- most interactions are never executed
- several verify selectors cannot be counted by the current state-capture logic
- one check type is skipped entirely in navigation mode
- some passes are false positives
