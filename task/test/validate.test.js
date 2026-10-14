const test = require("node:test")
const assert = require("node:assert/strict")
const { taskFor } = require("./fixture-portal")

test("importing the task entrypoint performs no work and exports the API", () => {
  const api = require("../index.js")
  assert.equal(typeof api.runTask, "function")
  assert.equal(typeof api.validateTask, "function")
  assert.ok(api.FAILURE_CODES.includes("duplicate_target"))
})

test("validateTask accepts the fixture recipe and rejects unknown fields and bad origins", () => {
  const { validateTask, TaskValidationError } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  assert.equal(validateTask(task), task)
  for (const checkpoint of ["authenticated_list", "matched_client"]) {
    assert.equal(validateTask({ ...task, checkpoint }).checkpoint, checkpoint)
  }
  assert.throws(() => validateTask({ ...task, checkpoint: "details" }), /checkpoint/)
  assert.throws(() => validateTask({ ...task, evaluate: "alert(1)" }), TaskValidationError)
  assert.throws(() => validateTask({ ...task, origins: { login: ["http://portal.example"], list: task.origins.list } }), /loopback/)
  assert.throws(() => validateTask({ ...task, schemaVersion: 2 }), /schemaVersion/)
  assert.throws(() => validateTask({ ...task, list: { ...task.list, fields: { ...task.list.fields, pgid: { position: 1 } } } }), /labelText/)
})

test("runTask rejects a missing parameter or sensitive input before launching a browser", async () => {
  const { runTask } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  await assert.rejects(runTask({ execution: { runId: "r", taskDigest: "d" }, task, parameters: {}, sensitiveInputs: { PORTAL_USERNAME: "u", PORTAL_PASSWORD: "p" } }), { code: "missing_parameter" })
  await assert.rejects(runTask({ execution: { runId: "r", taskDigest: "d" }, task, parameters: { PGID: "9876" }, sensitiveInputs: {} }), { code: "missing_sensitive_input" })
})

test("details checkpoint requires its narrow configuration and validates total-count format", () => {
  const { validateTask } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  task.checkpoint = "details_opened"
  assert.throws(() => validateTask(task), /task.details/)
  task.details = { linkSelector: "a", pathPrefix: "/happy/integration-clients/", markers: ["h1"], pgid: { labelText: "PGID" } }
  task.list.pagination.advertisedTotalFormat = "total_items"
  assert.equal(validateTask(task), task)
  task.list.pagination.advertisedTotalFormat = "loose"
  assert.throws(() => validateTask(task), /advertisedTotalFormat/)
})

test("optional viewport accepts bounded positive dimensions", () => {
  const { validateTask } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  task.viewport = { width: 700, height: 1000 }
  assert.equal(validateTask(task), task)
  assert.throws(() => validateTask({ ...task, viewport: { width: 0, height: 4097 } }), /task.viewport/)
})

test("screenshot configuration requires expected masks outside login", () => {
  const { validateTask } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  task.screenshots = { login: { requiredMaskSelectors: [] }, authenticated_list: { requiredMaskSelectors: [".sensitive"] } }
  assert.equal(validateTask(task), task)
  assert.throws(() => validateTask({ ...task, screenshots: { authenticated_list: { requiredMaskSelectors: [] } } }), /requiredMaskSelectors/)
})

test("details output requires an explicit field and cannot be combined with a checkpoint", () => {
  const { validateTask } = require("../index.js")
  const task = taskFor("http://127.0.0.1:1", "happy")
  task.output.source = "details"
  assert.throws(() => validateTask(task), /task.details/)
  task.details = { linkSelector: "a", pathPrefix: "/happy/integration-clients/", markers: ["h1"], pgid: { labelText: "PGID" } }
  assert.throws(() => validateTask(task), /task.details.clientId/)
  task.details.clientId = { labelText: "Client ID" }
  assert.equal(validateTask(task), task)
  assert.throws(() => validateTask({ ...task, checkpoint: "details_opened" }), /cannot be combined/)
})
