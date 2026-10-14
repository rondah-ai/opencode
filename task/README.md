# `@rondah-ai/rondar/task`

Guarded task execution for provisioning probes, added for the Rondah Core `apps/pms-provisioning` service. It is separate from the QA runner: no healing, no `.first()` fallback, no screenshots, traces, HAR, console or storage capture, and no process exit.

```js
const { runTask } = require("@rondah-ai/rondar/task")

const result = await runTask({
  execution: { runId, taskDigest },
  task, // fixed recipe document, validated before launch
  parameters: { PGID: "9876" },
  sensitiveInputs: { PORTAL_USERNAME, PORTAL_PASSWORD }, // env login only; never logged
  signal, // AbortSignal
  browser: { headless: true },
  hooks: {
    onEvent: event => {}, // { type: "stage", stage }
    onSensitiveOutput: async ({ runId, outputId, value }) => {}, // the one extracted value
  },
})
```

What the runner does: launches a fresh Chromium, installs request guards on the context before the first navigation, follows the login redirect (fills the declared inputs in `env` mode, or waits a bounded time for a human in `manual` mode), confirms the authenticated list page by origin, path and markers, reads every advertised page of visible records, requires exactly one record with the exact PGID and the expected status and integration name, returns to and revalidates that record, extracts its ID, checks the UUID format, and delivers it only through `onSensitiveOutput`. Blocked rules (detail, secret, mutation) are refused before dispatch in every phase; after login only reviewed GET list traffic is allowed. Any blocked attempt before a mutation turns an otherwise successful run into `prohibited_request_attempted`.

The result carries status, a code from `FAILURE_CODES`, counts and the cleanup outcome. It never carries the value, a page, a URL query or a raw error message.

Tests: `npm run test:task` (Node's built-in test runner, synthetic loopback portal only).

Optional `task.checkpoint` accepts `authenticated_list` (login and list markers ready)
or `matched_client` (complete list scan, unique exact match, status/integration check,
and record revalidation). These runs return `completedCheckpoint` when reached and
`outputs: {}`; they never read the client ID or invoke `onSensitiveOutput`. Omitting
it retains extraction. Cleanup still sets the final `stage` to `done`.

Checkpoint runs include up to ten sanitized `blockedRequests.samples`; unknown path
segments are masked, and undeclared origins become `external`. Only configured static
path segments may be retained, excluding sensitive inputs and identifier-like segments.
The `authenticated_list` checkpoint also returns `listStructure` for the three matching
fields and a `totalItems` marker count, using bounded HTML tag and Bootstrap layout
metadata only. No field values, page text, markup, headers, or bodies are returned.

Stylesheet samples on declared origins may retain a letters/punctuation-only `.css`
basename after sensitive-input masking. Structure metadata also includes
`lastLabelStructure` so responsive record labels can be distinguished from headers.

`details_opened` additionally requires `task.details` with `linkSelector`, `pathPrefix`,
`markers`, and a `pgid` field locator. After record revalidation it opens one visible
link on the same list origin, with no query, fragment or URL credentials. Only that
exact GET document is permitted; secret/mutation blocks and other document blocks
remain active. The result confirms the details markers and PGID without extraction.
`list.pagination.advertisedTotalFormat: "total_items"` accepts only `Total N items`;
omission or `"digits"` retains the existing digits-only count format.

`authenticated_list` also reports `recordCandidates` (selector count, existing
Playwright visibility count, first computed display category, and whether the first
candidate has a visible descendant). Last-label ancestors include allowlisted display
categories. These diagnostics do not alter record visibility or matching behavior.
For label-based recipes, each last-label ancestor also reports exact known-label
counts for integration name, status and PGID, without reading their values.

Optional `task.viewport: { width, height }` selects the browser viewport for responsive
layouts. Both dimensions must be integers from 1 through 4096. Omission preserves
Playwright's default viewport; scanner visibility rules remain unchanged.

Screenshots are opt-in through `task.screenshots`, a partial map of `login`,
`authenticated_list`, `matched_client`, and `details_opened` to
`{ requiredMaskSelectors: string[] }`. Expected masks must have a visible match; all
matching elements and input controls are masked before capture. Non-login stages
require at least one expected mask. The matched image crops the revalidated record.
`hooks.onScreenshot({ stage, png })` receives a PNG Buffer and is awaited; missing
masks or a failing hook stop the run. The package saves no image files.
Visible text matching a supplied sensitive input is also masked automatically,
including reflected login names; no input values are copied into the task or result.

Details actions are an explicit opt-in for one irreversible request. They cannot be
combined with screenshots or checkpoints. `details.expect` pairs a field with a
sensitive input before actions; a locator with `value: true` reads an input value,
including unique hidden fields. `details.integrationId` must be a safe path segment
(letters, digits, underscore or hyphen); it is read from the selected detail page
and binds the allowed API route independently of the detail URL record ID.
`details.pgid` must equal the requested PGID. The exact selected URL, integration
ID, PGID and expected field value are rechecked after authorization.

`details.actions` is an ordered list of `{ type: "click" | "waitFor" | "dismiss",
selector }` steps, each bounded by `actionTimeoutMs` and requiring one visible
match. Exactly one click has `mutation: true`. The required awaited
`hooks.onBeforeMutation()` must durably record authorization before returning;
a rejected or absent hook prevents the request. Optional `onBeforeAction` receives
`{ index, type, mutation }` and is also awaited.

`requestPolicy.action` contains exactly one rule with `origin`, `methods: ["GET"]`,
`pathTemplate` containing `{integrationId}` and `{pgid}`, `resourceTypes` limited to
`fetch`/`xhr`, `emptyQuery: true`, and `maxCount: 1`. The endpoint family is reserved
throughout the run, including login, so a broad ordinary GET rule cannot authorize
this mutation. Existing blocked rules still win. The request is armed only after
the acknowledgement and fresh page identity checks.

`output.field` can be `clientSecret`, with a corresponding details locator, and
`output.format` can be `{ exactLength: 32, rejectValues: ["*************"] }`.
After actual dispatch the runner emits `mutation_dispatched`, ignores cancellation,
and delivers sensitive output despite later blocked requests or dialog failures.
Dialog failures still produce a failed result after delivery. Results report
`mutationDispatched` and sanitized blocked counts, never the value. Extraction is
bounded by `actionTimeoutMs`. If the total deadline expires after dispatch, delivery
gets one additional budget of `min(60000, actionTimeoutMs * (actions.length + 2))`;
callers must include that grace plus cleanup in their process watchdog.
