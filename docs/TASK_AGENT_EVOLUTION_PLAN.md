# Task Agent Evolution Plan

> Evolve Rondar from a QA-oriented flow recorder/replayer into a "show once, repeat later" browser task agent.

---

## Goal

Current Rondar is strongest at:

- recording browser interactions
- replaying deterministic flows
- validating outcomes
- healing selectors

The next product step is broader:

> A user demonstrates a workflow once, gives it a name, and the agent can later repeat that workflow as an operational task, not just as a QA test.

Examples:

- "Open Reports for Practice A and set the date range to last 7 days"
- "Go to Practice Details and review the PMS Connector section"
- "Dismiss onboarding prompts and navigate to Analytics"
- "Repeat the same dashboard setup I showed you yesterday"

---

## Product Shift

### What changes

QA agent mindset:

- Did the app behave correctly?
- Did the expected landmark appear?
- Did this step pass or fail?

Task agent mindset:

- What was the user trying to accomplish?
- Which actions were required vs optional?
- If the app is already in the right state, can the agent skip ahead?
- If a prompt appears or disappears, can the agent adapt?
- Can the task be resumed from current state instead of replayed from zero?

### Key principle

Do not replace the current flow runner.

Instead:

1. Keep the existing recorded flow/action format as the execution substrate
2. Add a higher-level task layer above it
3. Let task metadata guide smarter execution, skipping, branching, and recovery

---

## Current Foundation In This Repo

Already available:

- `scripts/learn.js`
  - records actions and steps
  - warns on overlays
  - supports step splitting
  - validates flows before save
- `scripts/run-e2e.js`
  - replays steps
  - heals selectors
  - dismisses blocking overlays
  - supports visible pacing via `--slow-mo`, `--step-delay`, `--demo`
- `QA_RECORDED_FLOWS.json`
  - stable persisted format for action sequences

This is enough to build a first task layer without starting over.

---

## Gaps Between QA Replay And Task Replay

### 1. No intent model

The system knows what the user clicked, but not whether it was:

- required
- optional
- dismissive
- exploratory
- confirmation
- verification-only

### 2. No state-aware skipping

If a user already is on the target page, the runner still replays the navigation path literally.

### 3. No optional action handling

Actions like `Maybe Later`, `Close`, `Skip`, or onboarding banners are often conditional and should not fail the whole task.

### 4. No resumability

Execution assumes a fresh replay from the start route instead of "continue from where I am now."

### 5. No parameterized task model

Flows can store values, but not first-class task parameters like:

- practice name
- date range
- patient name
- report type

### 6. No branching

A real task often has equivalent UI paths or optional detours.

---

## Proposed Architecture

Add a new layer:

```text
Task Definition
  -> references recorded steps/actions
  -> adds intent, parameters, optionality, success conditions

Task Planner
  -> decides what steps to run from current state
  -> skips already-complete steps
  -> chooses recovery/branch path when needed

Task Executor
  -> uses the existing replay engine to execute concrete actions
  -> keeps selector healing, overlay handling, pacing, screenshots
```

### New core idea

Flows become low-level action recipes.
Tasks become reusable operational procedures built from those recipes.

---

## Phase 1: Task Metadata On Top Of Existing Flows

> Goal: make current recorded flows more task-aware without changing the core runner.

### Add task semantics to steps

Extend recorded steps with optional metadata fields:

```json
{
  "stepNumber": 2,
  "description": "click a \"Reports\", navigate to /home/reports",
  "intent": "navigate",
  "optional": false,
  "skippableIf": {
    "type": "url_is",
    "value": "/home/reports"
  },
  "successChecks": [
    { "type": "url_is", "value": "/home/reports" },
    { "type": "landmark_visible", "selector": "h1", "text": "Reports" }
  ]
}
```

### Initial intents

- `navigate`
- `dismiss_optional`
- `open_panel`
- `select_value`
- `fill_form`
- `submit`
- `verify`
- `unknown`

### First implementation rule

Do not require AI for this.

Use deterministic inference from current actions:

- link click + `waitForURL` -> `navigate`
- click text like `Maybe Later`, `Close`, `Skip`, `Dismiss` -> `dismiss_optional`
- select/dropdown operations -> `select_value`
- fill actions -> `fill_form`

### Deliverable

Recorded flows still work in `run-e2e.js`, but now carry enough semantics for smarter task replay later.

---

## Phase 2: Optional And Conditional Steps

> Goal: allow the agent to perform tasks robustly even when the UI varies.

### Add optional step semantics

Examples:

- `Maybe Later`
- cookie banners
- onboarding popups
- feature announcements

Represent them as:

```json
{
  "intent": "dismiss_optional",
  "optional": true,
  "skipIfMissing": true
}
```

### Replay behavior

If an optional step target does not exist:

- log `SKIP optional step`
- continue

If a required step fails:

- stop or recover depending on task mode

### Deliverable

Task replay no longer fails just because a dismissive prompt was absent.

---

## Phase 3: State-Aware Step Skipping

> Goal: do not replay actions that are already satisfied.

### Add pre-step evaluation

Before executing a step, evaluate:

- is the success condition already true?
- is the page already at the desired route?
- is the dialog already closed?
- is the dropdown already set?

### Examples

If step says:

```json
{
  "intent": "navigate",
  "skippableIf": { "type": "url_is", "value": "/home/reports" }
}
```

and current page is already `/home/reports`, skip the step.

### Needed code

Add a `canSkipStep(page, step)` helper that reuses existing verify checks.

### Deliverable

The agent starts behaving like a task performer instead of a strict macro replayer.

---

## Phase 4: Resumable Task Execution

> Goal: start from current app state, not always from step 1.

### New mode

Add task execution modes:

- `fresh`
  - start from `startRoute`
  - current QA replay behavior
- `resume`
  - inspect current page
  - find nearest matching step boundary
  - continue from there

### Resume strategy

1. Evaluate each step's `successChecks` against current page state
2. Find the latest step whose success state is already true
3. Resume at the next step

### Example

If steps 1-3 are already complete and the user is currently on `Practice Details`, begin at step 4.

### Deliverable

A user can say: "continue this task from here."

---

## Phase 5: Parameterized Tasks

> Goal: make learned tasks reusable across inputs.

### Move from hardcoded values to task parameters

Examples:

- practice name
- date range
- patient name
- report type

### Task definition format

```json
{
  "name": "open_reports_for_practice",
  "parameters": [
    { "name": "PRACTICE_NAME", "type": "string", "required": true },
    { "name": "DATE_RANGE", "type": "string", "required": false }
  ]
}
```

### How to infer parameters

From recorded actions:

- text/value selections become candidate parameters
- user can confirm parameter names after recording

### Replay

Run task with:

```bash
node scripts/run-task.js --task open_reports_for_practice --var PRACTICE_NAME="Acme Dental"
```

### Deliverable

A task becomes a reusable operational procedure, not a one-off replay.

---

## Phase 6: Task Definition File

> Goal: create a first-class file for learned operational tasks.

Introduce:

- `QA_TASKS.json`

Suggested shape:

```json
{
  "version": "1.0",
  "tasks": [
    {
      "name": "open_reports_for_practice",
      "sourceFlow": "reports navigation",
      "startRoute": "/home/call-logs",
      "parameters": [
        { "name": "PRACTICE_NAME", "type": "string", "required": true }
      ],
      "steps": [],
      "tags": ["task", "reports"]
    }
  ]
}
```

### Why separate file

- keeps QA flow history intact
- lets one flow produce multiple tasks
- allows task-specific metadata without bloating replay-only flows

---

## Phase 7: New Task Runner

> Goal: expose the new behavior without overloading `run-e2e.js`.

Add:

- `scripts/run-task.js`

Responsibilities:

- load `QA_TASKS.json`
- resolve parameters
- inspect current browser state
- skip optional/already-complete steps
- reuse existing action execution helpers
- reuse selector healing and overlay handling

### CLI examples

```bash
# Run task from scratch
node scripts/run-task.js --task open_reports_for_practice --var PRACTICE_NAME="Acme Dental"

# Resume from current visible browser state
node scripts/run-task.js --task open_reports_for_practice --resume --no-headless

# Human-observable run
node scripts/run-task.js --task open_reports_for_practice --demo
```

---

## Phase 8: Teach-Task UX

> Goal: make task teaching explicit in the recorder.

Current recorder UX:

- record flow

Future task UX:

- record task
- name task
- mark parameters
- mark optional steps
- define completion state

### Proposed interactive commands

- `t` -> start task recording
- `p` -> mark last selected value as a parameter
- `o` -> mark last step optional
- `g` -> mark current page state as task goal

This can be added after the task data model is stable.

---

## Phase 9: AI Assistance As An Enhancement

> Goal: use AI only where deterministic logic is too weak.

Possible AI uses:

- infer step intent from raw actions
- identify optional vs required actions
- summarize a task in user language
- propose parameter names
- detect exploratory/noisy actions that should be dropped

Rules:

- AI should not be required for core execution
- task execution must still work deterministically without API access

---

## Implementation Order

1. Add step intent metadata to current flows
2. Add optional-step support in replay
3. Add pre-step skip checks
4. Add resumable execution mode
5. Add task parameter support
6. Introduce `QA_TASKS.json`
7. Build `run-task.js`
8. Add teach-task UX
9. Add optional AI assistance

---

## First Concrete Milestone

Ship a minimal task agent that can do this:

1. User records a workflow in `learn.js`
2. System labels steps as `navigate`, `dismiss_optional`, `select_value`, etc.
3. Replay can skip missing optional prompts
4. Replay can skip steps whose success state is already satisfied
5. User can run the workflow as a task, not just as a test

That is the point where Rondar stops being "only a QA recorder" and starts being a browser task agent.

---

## Success Criteria

The evolution is successful when:

1. A user can demonstrate a workflow once and rerun it later as an operational task.
2. Optional prompts no longer break task execution.
3. The agent can skip steps already satisfied by current app state.
4. The agent can resume from the current browser state.
5. Task runs can accept parameters instead of requiring identical hardcoded values.
6. The existing QA replay engine remains usable and backward-compatible.
