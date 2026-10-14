// task/errors.js
//
// Allowlisted failure codes for task mode. A result carries one of these codes and never a raw
// Playwright message, page text, URL query or input value.

const CODES = Object.freeze([
  "invalid_task",
  "missing_parameter",
  "missing_sensitive_input",
  "browser_launch_failed",
  "navigation_failed",
  "login_form_ambiguous",
  "login_failed",
  "login_challenge",
  "login_timeout",
  "unexpected_page",
  "unexpected_origin",
  "list_markers_missing",
  "record_field_ambiguous",
  "pagination_ambiguous",
  "pagination_repeated",
  "pagination_incomplete",
  "list_count_mismatch",
  "advertised_count_invalid",
  "target_not_found",
  "duplicate_target",
  "target_inactive",
  "target_wrong_integration",
  "record_revalidation_failed",
  "detail_link_ambiguous",
  "detail_destination_invalid",
  "detail_markers_missing",
  "detail_pgid_mismatch",
  "detail_expected_mismatch",
  "detail_integration_mismatch",
  "action_failed",
  "mutation_authorization_failed",
  "mutation_not_dispatched",
  "screenshot_mask_missing",
  "screenshot_capture_failed",
  "screenshot_delivery_failed",
  "output_missing",
  "output_invalid",
  "output_delivery_failed",
  "prohibited_request_attempted",
  "total_timeout",
  "cancelled",
  "unexpected_error",
])

class TaskFailure extends Error {
  constructor(code, stage) {
    super(code)
    this.name = "TaskFailure"
    this.code = CODES.includes(code) ? code : "unexpected_error"
    this.stage = stage
  }
}

class TaskValidationError extends Error {
  constructor(issues) {
    super(`invalid task: ${issues.join("; ")}`)
    this.name = "TaskValidationError"
    this.code = "invalid_task"
    this.issues = issues
  }
}

module.exports = { CODES, TaskFailure, TaskValidationError }
