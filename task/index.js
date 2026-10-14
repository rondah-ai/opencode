// @rondah-ai/rondar/task
//
// Import-safe task entrypoint. Requiring this module launches no browser, reads no environment,
// writes no file and never exits the process. See task/README.md.

const { CODES, TaskFailure, TaskValidationError } = require("./errors")
const { createRequestGuard } = require("./request-guard")
const { runTask } = require("./runner")
const { validateTask } = require("./validate")

module.exports = { runTask, validateTask, createRequestGuard, TaskValidationError, TaskFailure, FAILURE_CODES: CODES }
