// task/validate.js
//
// Boundary validation for the fixed task document. Rejects unknown fields, unsupported versions,
// non-HTTPS/loopback origins and undeclared inputs before any browser is launched. Hand-written on
// purpose: public declarations stay plain types and no validator instance is shared with callers.

const { TaskValidationError } = require("./errors")

const METHODS = new Set(["GET", "POST"])
const BLOCK_CATEGORIES = new Set(["detail", "secret", "mutation"])
const FIELD_NAMES = ["integrationName", "status", "pgid", "clientId"]

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

function isAllowedOrigin(value) {
  try {
    const url = new URL(value)
    if (url.origin !== value) return false
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  } catch {
    return false
  }
}

function checkKeys(issues, path, object, allowed) {
  if (!isPlainObject(object)) {
    issues.push(`${path} must be an object`)
    return false
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not a known field`)
  }
  return true
}

function checkAllowRule(issues, path, rule) {
  if (!checkKeys(issues, path, rule, ["origin", "methods", "pathExact", "pathPrefix", "resourceTypes"])) return
  if (!isAllowedOrigin(rule.origin)) issues.push(`${path}.origin must be an https or loopback origin`)
  if (!Array.isArray(rule.methods) || rule.methods.length === 0 || !rule.methods.every(m => METHODS.has(m))) {
    issues.push(`${path}.methods must list GET and/or POST`)
  }
  for (const key of ["pathExact", "pathPrefix"]) {
    if (rule[key] !== undefined && (!isNonEmptyString(rule[key]) || !rule[key].startsWith("/"))) {
      issues.push(`${path}.${key} must be an absolute path`)
    }
  }
  if (rule.resourceTypes !== undefined && (!Array.isArray(rule.resourceTypes) || !rule.resourceTypes.every(isNonEmptyString))) {
    issues.push(`${path}.resourceTypes must be a list of resource types`)
  }
}

function checkBlockRule(issues, path, rule) {
  if (!checkKeys(issues, path, rule, ["pathRegex", "category"])) return
  try {
    new RegExp(rule.pathRegex)
  } catch {
    issues.push(`${path}.pathRegex must be a valid regular expression`)
  }
  if (!BLOCK_CATEGORIES.has(rule.category)) issues.push(`${path}.category must be detail, secret or mutation`)
}

function checkFieldLocator(issues, path, locator) {
  if (!isPlainObject(locator)) {
    issues.push(`${path} must be an object`)
    return
  }
  const keys = Object.keys(locator).filter(key => key !== "value")
  if (locator.value !== undefined && locator.value !== true) issues.push(`${path}.value must be true`)
  const byLabel = keys.length === 1 && keys[0] === "labelText" && isNonEmptyString(locator.labelText)
  const bySelector = keys.length === 1 && keys[0] === "selector" && isNonEmptyString(locator.selector)
  if (!byLabel && !bySelector) issues.push(`${path} must be { labelText } or { selector }`)
}

function validateTask(task) {
  const issues = []
  if (!checkKeys(issues, "task", task, [
    "schemaVersion", "name", "version", "checkpoint", "viewport", "screenshots", "startUrl", "origins", "auth", "requestPolicy", "list", "match", "details", "output", "limits",
  ])) {
    throw new TaskValidationError(issues)
  }
  if (task.checkpoint !== undefined && !["authenticated_list", "matched_client", "details_opened"].includes(task.checkpoint)) {
    issues.push("task.checkpoint must be authenticated_list, matched_client or details_opened")
  }
  if (task.viewport !== undefined && checkKeys(issues, "task.viewport", task.viewport, ["width", "height"])) {
    for (const dimension of ["width", "height"]) {
      if (!isPositiveInt(task.viewport[dimension]) || task.viewport[dimension] > 4096) {
        issues.push(`task.viewport.${dimension} must be an integer between 1 and 4096`)
      }
    }
  }
  if (task.screenshots !== undefined && checkKeys(issues, "task.screenshots", task.screenshots, ["login", "authenticated_list", "matched_client", "details_opened"])) {
    for (const [stage, config] of Object.entries(task.screenshots)) {
      if (checkKeys(issues, `task.screenshots.${stage}`, config, ["requiredMaskSelectors"])) {
        if (!Array.isArray(config.requiredMaskSelectors) || !config.requiredMaskSelectors.every(isNonEmptyString) ||
            (stage !== "login" && config.requiredMaskSelectors.length === 0)) {
          issues.push(`task.screenshots.${stage}.requiredMaskSelectors must list expected sensitive-field masks`)
        }
      }
    }
  }
  if (task.schemaVersion !== 1) issues.push("task.schemaVersion must be 1")
  if (!isNonEmptyString(task.name)) issues.push("task.name is required")
  if (!isNonEmptyString(task.version)) issues.push("task.version is required")

  let startOrigin = null
  try {
    startOrigin = new URL(task.startUrl).origin
  } catch {
    issues.push("task.startUrl must be a URL")
  }
  if (checkKeys(issues, "task.origins", task.origins, ["login", "list"])) {
    for (const key of ["login", "list"]) {
      const origins = task.origins[key]
      if (!Array.isArray(origins) || origins.length === 0 || !origins.every(isAllowedOrigin)) {
        issues.push(`task.origins.${key} must list https or loopback origins`)
      }
    }
    if (startOrigin && Array.isArray(task.origins.list) && !task.origins.list.includes(startOrigin)) {
      issues.push("task.startUrl must be on a list origin")
    }
  }
  if (checkKeys(issues, "task.auth", task.auth, [
    "mode", "loginOrigin", "usernameSelector", "passwordSelector", "submitSelector", "usernameInput", "passwordInput", "maxWaitMs",
  ])) {
    if (task.auth.mode !== "env" && task.auth.mode !== "manual") issues.push("task.auth.mode must be env or manual")
    if (!isAllowedOrigin(task.auth.loginOrigin)) issues.push("task.auth.loginOrigin must be an https or loopback origin")
    for (const key of ["usernameSelector", "passwordSelector", "submitSelector", "usernameInput", "passwordInput"]) {
      if (!isNonEmptyString(task.auth[key])) issues.push(`task.auth.${key} is required`)
    }
    if (!isPositiveInt(task.auth.maxWaitMs)) issues.push("task.auth.maxWaitMs must be a positive integer")
  }
  if (checkKeys(issues, "task.requestPolicy", task.requestPolicy, ["login", "list", "action", "blocked"])) {
    for (const key of ["login", "list"]) {
      const rules = task.requestPolicy[key]
      if (!Array.isArray(rules) || rules.length === 0) issues.push(`task.requestPolicy.${key} must be a non-empty list`)
      else rules.forEach((rule, index) => checkAllowRule(issues, `task.requestPolicy.${key}[${index}]`, rule))
    }
    if (task.requestPolicy.action !== undefined) {
      const rules = task.requestPolicy.action
      if (!Array.isArray(rules) || rules.length !== 1) issues.push("task.requestPolicy.action must contain exactly one rule")
      else for (const rule of rules) {
        if (!checkKeys(issues, "task.requestPolicy.action", rule, ["origin", "methods", "pathTemplate", "resourceTypes", "emptyQuery", "maxCount"])) continue
        if (!isAllowedOrigin(rule.origin) || !task.origins?.list?.includes(rule.origin)) issues.push("action origin must be a list origin")
        if (JSON.stringify(rule.methods) !== '["GET"]') issues.push("action methods must be GET only")
        if (!Array.isArray(rule.resourceTypes) || rule.resourceTypes.length === 0 || !rule.resourceTypes.every(type => ["fetch", "xhr"].includes(type))) issues.push("action resourceTypes must be fetch or xhr")
        if (rule.emptyQuery !== true || rule.maxCount !== 1) issues.push("action must require emptyQuery and maxCount 1")
        if (typeof rule.pathTemplate !== "string" || !/^\/(?:[A-Za-z0-9_-]+|\{integrationId\}|\{pgid\})(?:\/(?:[A-Za-z0-9_-]+|\{integrationId\}|\{pgid\}))*$/.test(rule.pathTemplate) ||
            rule.pathTemplate.split("{integrationId}").length !== 2 || rule.pathTemplate.split("{pgid}").length !== 2) issues.push("action pathTemplate must bind integrationId and pgid exactly once")
      }
      if (!task.details?.actions?.length) issues.push("action policy requires details actions")
    }
    if (!Array.isArray(task.requestPolicy.blocked)) issues.push("task.requestPolicy.blocked must be a list")
    else task.requestPolicy.blocked.forEach((rule, index) => checkBlockRule(issues, `task.requestPolicy.blocked[${index}]`, rule))
  }
  if (checkKeys(issues, "task.list", task.list, ["pathPrefix", "markers", "recordSelector", "fields", "pagination"])) {
    if (!isNonEmptyString(task.list.pathPrefix) || !task.list.pathPrefix.startsWith("/")) issues.push("task.list.pathPrefix must be an absolute path")
    if (!Array.isArray(task.list.markers) || task.list.markers.length === 0 || !task.list.markers.every(isNonEmptyString)) {
      issues.push("task.list.markers must be a non-empty list of selectors")
    }
    if (!isNonEmptyString(task.list.recordSelector)) issues.push("task.list.recordSelector is required")
    if (checkKeys(issues, "task.list.fields", task.list.fields, FIELD_NAMES)) {
      for (const name of FIELD_NAMES) checkFieldLocator(issues, `task.list.fields.${name}`, task.list.fields[name])
    }
    if (checkKeys(issues, "task.list.pagination", task.list.pagination, ["nextSelector", "advertisedTotalSelector", "advertisedTotalFormat", "maxPages"])) {
      const { nextSelector, advertisedTotalSelector, advertisedTotalFormat, maxPages } = task.list.pagination
      if (advertisedTotalFormat !== undefined && !["digits", "total_items"].includes(advertisedTotalFormat)) {
        issues.push("task.list.pagination.advertisedTotalFormat must be digits or total_items")
      }
      if (nextSelector !== null && !isNonEmptyString(nextSelector)) issues.push("task.list.pagination.nextSelector must be a selector or null")
      if (advertisedTotalSelector !== null && !isNonEmptyString(advertisedTotalSelector)) {
        issues.push("task.list.pagination.advertisedTotalSelector must be a selector or null")
      }
      if (!isPositiveInt(maxPages) || maxPages > 50) issues.push("task.list.pagination.maxPages must be between 1 and 50")
    }
  }
  if (checkKeys(issues, "task.match", task.match, ["pgid", "status", "integrationName"])) {
    if (!isPlainObject(task.match.pgid) || !isNonEmptyString(task.match.pgid.parameter) || Object.keys(task.match.pgid).length !== 1) {
      issues.push("task.match.pgid must be { parameter }")
    }
    if (!isNonEmptyString(task.match.status)) issues.push("task.match.status is required")
    if (!isNonEmptyString(task.match.integrationName)) issues.push("task.match.integrationName is required")
  }
  if (task.details !== undefined || task.checkpoint === "details_opened" || task.output?.source === "details") {
    if (checkKeys(issues, "task.details", task.details, ["linkSelector", "pathPrefix", "markers", "pgid", "clientId", "clientSecret", "integrationId", "expect", "actions"])) {
      if (!isNonEmptyString(task.details.linkSelector)) issues.push("task.details.linkSelector is required")
      if (!isNonEmptyString(task.details.pathPrefix) || !task.details.pathPrefix.startsWith("/") || /[?#]/.test(task.details.pathPrefix)) {
        issues.push("task.details.pathPrefix must be an absolute path without query or fragment")
      }
      if (!Array.isArray(task.details.markers) || task.details.markers.length === 0 || !task.details.markers.every(isNonEmptyString)) {
        issues.push("task.details.markers must be a non-empty list of selectors")
      }
      checkFieldLocator(issues, "task.details.pgid", task.details.pgid)
      if (task.details.clientSecret !== undefined) checkFieldLocator(issues, "task.details.clientSecret", task.details.clientSecret)
      if (task.details.expect !== undefined && checkKeys(issues, "task.details.expect", task.details.expect, ["field", "sensitiveInput"])) {
        checkFieldLocator(issues, "task.details.expect.field", task.details.expect.field)
        if (!isNonEmptyString(task.details.expect.sensitiveInput)) issues.push("details.expect.sensitiveInput is required")
      }
      if (task.details.actions !== undefined) {
        if (task.checkpoint !== undefined || task.screenshots !== undefined) issues.push("actions cannot use checkpoints or screenshots")
        if (!task.requestPolicy?.action || !task.details.expect) issues.push("actions require action policy and expected sensitive value")
        if (task.output?.source !== "details") issues.push("actions require details output")
        checkFieldLocator(issues, "task.details.integrationId", task.details.integrationId)
        const actions = task.details.actions
        if (!Array.isArray(actions) || actions.length === 0 || actions.length > 20) issues.push("actions must contain 1 to 20 steps")
        else {
          if (actions.filter(action => action?.mutation === true).length !== 1) issues.push("actions require exactly one mutation click")
          actions.forEach((action, index) => {
            if (!checkKeys(issues, `details.actions[${index}]`, action, ["type", "selector", "mutation"])) return
            if (!["click", "waitFor", "dismiss"].includes(action.type) || !isNonEmptyString(action.selector)) issues.push("action requires supported type and selector")
            if (action.mutation !== undefined && (action.mutation !== true || action.type !== "click")) issues.push("mutation is only allowed on a click")
          })
        }
      }
      if (task.details.clientId !== undefined || task.output?.source === "details" && task.output.field === "clientId") {
        checkFieldLocator(issues, "task.details.clientId", task.details.clientId)
      }
    }
  }
  if (checkKeys(issues, "task.output", task.output, ["name", "field", "format", "source"])) {
    if (task.output.source !== undefined && !["list", "details"].includes(task.output.source)) {
      issues.push("task.output.source must be list or details")
    }
    if (task.output.source === "details" && task.checkpoint !== undefined) {
      issues.push("task.output.source details cannot be combined with a checkpoint")
    }
    if (!isNonEmptyString(task.output.name)) issues.push("task.output.name is required")
    if (!["clientId", "clientSecret"].includes(task.output.field)) issues.push("task.output.field must be clientId or clientSecret")
    if (task.output.field === "clientSecret" && (task.output.source !== "details" || !task.details?.clientSecret || !task.details?.actions)) issues.push("clientSecret requires details actions and field")
    if (task.output.format !== "uuid") {
      if (checkKeys(issues, "task.output.format", task.output.format, ["exactLength", "rejectValues"])) {
        if (!isPositiveInt(task.output.format.exactLength) || task.output.format.exactLength > 4096) issues.push("output exactLength must be between 1 and 4096")
        if (!Array.isArray(task.output.format.rejectValues) || !task.output.format.rejectValues.every(isNonEmptyString)) issues.push("output rejectValues must be strings")
      }
    }
  }
  if (checkKeys(issues, "task.limits", task.limits, ["actionTimeoutMs", "totalTimeoutMs", "cleanupTimeoutMs"])) {
    for (const key of ["actionTimeoutMs", "totalTimeoutMs", "cleanupTimeoutMs"]) {
      if (!isPositiveInt(task.limits[key])) issues.push(`task.limits.${key} must be a positive integer`)
    }
  }
  if (issues.length) throw new TaskValidationError(issues)
  return task
}

function validateInputs(task, parameters, sensitiveInputs) {
  const issues = []
  const pgidParameter = task.match.pgid.parameter
  if (!isPlainObject(parameters) || !isNonEmptyString(parameters[pgidParameter])) {
    issues.push(`parameter ${pgidParameter} is required`)
  }
  if (task.auth.mode === "env") {
    for (const name of [task.auth.usernameInput, task.auth.passwordInput]) {
      if (!isPlainObject(sensitiveInputs) || !isNonEmptyString(sensitiveInputs[name])) {
        issues.push(`sensitive input ${name} is required for env login`)
      }
    }
  }
  if (task.details?.expect && (!isPlainObject(sensitiveInputs) || !isNonEmptyString(sensitiveInputs[task.details.expect.sensitiveInput]))) {
    issues.push("sensitive input for expected details value is required")
  }
  return issues
}

module.exports = { validateTask, validateInputs, isAllowedOrigin }
