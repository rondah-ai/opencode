#!/usr/bin/env node

/**
 * qa-agent migrate — Convert legacy QA_FLOWS.json + QA_ANCHOR_POINTS.json
 * to QA_FEATURE_MODEL.json
 *
 * Usage:
 *   npx qa-agent migrate
 *   npx qa-agent migrate --flows ./QA_FLOWS.json --anchors ./QA_ANCHOR_POINTS.json
 *   npx qa-agent migrate --output ./QA_FEATURE_MODEL.json
 */

const fs = require("fs")
const path = require("path")

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getArg(name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

const config = {
  flowsPath: getArg("--flows") || "./QA_FLOWS.json",
  anchorsPath: getArg("--anchors") || "./QA_ANCHOR_POINTS.json",
  outputPath: getArg("--output") || "./QA_FEATURE_MODEL.json",
}

// ─── Validation ──────────────────────────────────────────────────────────────

if (!fs.existsSync(config.flowsPath)) {
  console.error(`Error: Flows file not found: ${config.flowsPath}`)
  process.exit(1)
}

console.log("QA Agent -- Migrate")
console.log("=".repeat(50))
console.log(`Flows:   ${config.flowsPath}`)
console.log(`Anchors: ${fs.existsSync(config.anchorsPath) ? config.anchorsPath : "(not found, optional)"}`)
console.log(`Output:  ${config.outputPath}`)
console.log("=".repeat(50))
console.log("")

// ─── Load ────────────────────────────────────────────────────────────────────

const flowsRaw = JSON.parse(fs.readFileSync(config.flowsPath, "utf-8"))
const flows = flowsRaw.flows || flowsRaw

let anchors = null
if (fs.existsSync(config.anchorsPath)) {
  anchors = JSON.parse(fs.readFileSync(config.anchorsPath, "utf-8"))
}

// ─── Convert ─────────────────────────────────────────────────────────────────

const features = {}
const shared = {}
let totalCaps = 0

// Walk the flows tree: flows.authentication.login, flows.callLogs.viewCallList, etc.
function walkFlows(obj, parentPath = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value && value.steps && Array.isArray(value.steps)) {
      // This is a flow definition
      const featureName = parentPath[0] || key
      const capName = parentPath.length > 0 ? key : "default"
      convertFlow(featureName, capName, value)
    } else if (typeof value === "object" && value !== null && !Array.isArray(value) && !value.steps) {
      // Nested group
      walkFlows(value, [...parentPath, key])
    }
  }
}

function convertFlow(featureName, capName, flow) {
  // Determine route from navigate steps
  const navigateStep = flow.steps.find((s) => s.action === "navigate")
  const route = navigateStep?.target || navigateStep?.url || ""

  // Convert feature name to snake_case
  const normalizedFeature = featureName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()

  // Convert cap name to snake_case
  const normalizedCap = capName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()

  // Ensure feature exists
  if (!features[normalizedFeature]) {
    features[normalizedFeature] = {
      description: flow.description || `${normalizedFeature.replace(/_/g, " ")} feature`,
      route: resolveRoute(normalizedFeature, route),
      requires: [],
      capabilities: {},
    }
  }

  // Detect if this needs authentication
  if (route && !route.includes("login") && !route.includes("sign-in") && !route.includes("auth")) {
    if (!features[normalizedFeature].requires.includes("authenticated")) {
      features[normalizedFeature].requires.push("authenticated")
    }
  }

  // Convert steps to interaction description
  const interaction = buildInteractionFromSteps(flow.steps)

  // Convert verify steps to verify checks
  const verify = buildVerifyFromSteps(flow.steps)

  // Extract expected from verify steps
  const expected = flow.steps
    .filter((s) => s.action === "verify")
    .map((s) => s.description || `verify ${s.target}`)

  if (expected.length === 0) {
    expected.push("action completes without errors")
  }

  // Extract test data from parameterized values
  const testData = extractTestData(flow)

  // Determine preconditions
  const preconditions = []
  if (normalizedCap !== "login" && normalizedCap !== "default") {
    // If there's a view step before the action, it's a precondition
    const hasViewCap = features[normalizedFeature]?.capabilities.view_list ||
      features[normalizedFeature]?.capabilities.view_call_list ||
      features[normalizedFeature]?.capabilities.default
    if (hasViewCap) {
      const viewCapName = Object.keys(features[normalizedFeature].capabilities).find(
        (n) => n.startsWith("view") || n === "default"
      )
      if (viewCapName && viewCapName !== normalizedCap) {
        preconditions.push(viewCapName)
      }
    }
  }

  features[normalizedFeature].capabilities[normalizedCap] = {
    interaction,
    expected,
    verify,
    ...(preconditions.length > 0 && { preconditions }),
    ...(Object.keys(testData).length > 0 && { test_data: testData }),
    ...(flow.priority && { _priority: flow.priority }),
    _confidence: "migrated",
    _observed: 0,
  }

  totalCaps++
}

function buildInteractionFromSteps(steps) {
  const actions = []

  for (const step of steps) {
    if (step.action === "navigate") {
      // Skip navigate — it's implicit
      continue
    } else if (step.action === "type" || step.action === "fill") {
      const field = describeSelector(step.target)
      const value = step.value?.startsWith("{") ? "(parameter)" : `"${step.value}"`
      actions.push(`type ${value} in ${field}`)
    } else if (step.action === "click") {
      const target = describeSelector(step.target)
      actions.push(`click ${target}`)
    } else if (step.action === "select") {
      const target = describeSelector(step.target)
      actions.push(`select option in ${target}`)
    } else if (step.action === "wait") {
      // Skip explicit waits
      continue
    } else if (step.action === "verify") {
      // Verify handled separately
      continue
    } else if (step.action === "screenshot") {
      continue
    } else if (step.action === "hover") {
      actions.push(`hover over ${describeSelector(step.target)}`)
    } else if (step.action === "press") {
      actions.push(`press ${step.value || "Enter"}`)
    }
  }

  return actions.length > 0 ? actions.join(", ") : "navigate to page"
}

function buildVerifyFromSteps(steps) {
  const verify = {}
  let checkIndex = 0

  for (const step of steps) {
    if (step.action !== "verify") continue

    checkIndex++
    const name = `check_${checkIndex}`

    if (step.target === "url" && step.contains) {
      verify[name] = { type: "url_changed" }
    } else if (step.contains) {
      verify[name] = {
        type: "text_appeared",
        value: step.contains,
      }
    } else if (step.exists !== undefined) {
      verify[name] = {
        type: step.exists ? "custom_selector_visible" : "custom_selector_hidden",
        selector: step.target,
      }
    } else if (step.minCount !== undefined) {
      verify[name] = {
        type: "count_equals",
        selector: step.target,
        value: String(step.minCount),
      }
    } else if (step.target) {
      verify[name] = {
        type: "custom_selector_visible",
        selector: convertSelector(step.target),
      }
    }
  }

  // Always add no_errors
  if (!Object.values(verify).some((v) => v.type === "no_errors")) {
    verify.no_errors = { type: "no_errors" }
  }

  return verify
}

function extractTestData(flow) {
  const data = {}

  if (flow.requiredParams) {
    for (const param of flow.requiredParams) {
      if (param === "email") data.email = "$TEST_EMAIL"
      else if (param === "password") data.password = "$TEST_PASSWORD"
      else data[param] = "TODO"
    }
  }

  // Also extract from step values
  for (const step of flow.steps) {
    if (step.value && step.value.startsWith("{") && step.value.endsWith("}")) {
      const param = step.value.slice(1, -1)
      if (!data[param]) {
        if (param === "email") data[param] = "$TEST_EMAIL"
        else if (param === "password") data[param] = "$TEST_PASSWORD"
        else data[param] = "TODO"
      }
    }
  }

  return data
}

function describeSelector(selector) {
  if (!selector) return "element"

  // :contains('text') → "text" button/element
  const containsMatch = selector.match(/:contains\(['"]([^'"]+)['"]\)/)
  if (containsMatch) {
    const text = containsMatch[1]
    const tag = selector.split(":")[0] || "element"
    return `${tag} "${text}"`
  }

  // button:has-text("text") → "text" button
  const hasTextMatch = selector.match(/:has-text\("([^"]+)"\)/)
  if (hasTextMatch) {
    const text = hasTextMatch[1]
    const tag = selector.split(":")[0] || "element"
    return `${tag} "${text}"`
  }

  // input[type='email'] → email input
  const typeMatch = selector.match(/input\[type=['"](\w+)['"]\]/)
  if (typeMatch) return `${typeMatch[1]} input`

  // input[name='field'] → field input
  const nameMatch = selector.match(/\[name=['"](\w+)['"]\]/)
  if (nameMatch) return `${nameMatch[1]} field`

  // Simple tag → tag
  if (/^[a-z]+$/.test(selector)) return selector

  return `"${selector.slice(0, 50)}"`
}

function convertSelector(selector) {
  if (!selector) return selector
  // Convert :contains() to :has-text()
  return selector.replace(/:contains\(['"]([^'"]+)['"]\)/g, ':has-text("$1")')
}

function resolveRoute(featureName, navTarget) {
  // Try to get route from anchor points
  if (anchors?.routes) {
    // camelCase lookup
    const camelName = featureName.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (typeof anchors.routes[camelName] === "string") {
      return anchors.routes[camelName]
    }
    // Direct lookup
    if (typeof anchors.routes[featureName] === "string") {
      return anchors.routes[featureName]
    }
  }

  // Fall back to navigate target from flow
  if (navTarget && navTarget.startsWith("/")) return navTarget

  return `/${featureName.replace(/_/g, "-")}`
}

// ─── Run ─────────────────────────────────────────────────────────────────────

walkFlows(flows)

// Handle authentication specially — create shared.authenticated
if (features.authentication?.capabilities?.login) {
  const loginCap = features.authentication.capabilities.login
  shared.authenticated = {
    how: loginCap.interaction,
    verify: "URL changes from login page",
    route: features.authentication.route,
  }
}

// Build final model
const model = {
  version: "1.0",
  meta: {
    generated_by: "migrate",
    migrated_from: {
      flows: config.flowsPath,
      anchors: fs.existsSync(config.anchorsPath) ? config.anchorsPath : null,
    },
    learn_sessions: 0,
    confidence: "migrated",
    migrated_at: new Date().toISOString(),
  },
  features,
  shared,
}

// Write output
fs.writeFileSync(config.outputPath, JSON.stringify(model, null, 2))

// Print summary
console.log("Migration complete!")
console.log("")
console.log("Feature model summary:")
for (const [name, feature] of Object.entries(features)) {
  const caps = Object.keys(feature.capabilities)
  console.log(`  ${name} (${feature.route}) -- ${caps.length} capabilities`)
  for (const cap of caps) {
    const conf = feature.capabilities[cap]._confidence
    console.log(`    - ${cap} [${conf}]`)
  }
}
console.log("")
console.log(`Total: ${Object.keys(features).length} features, ${totalCaps} capabilities`)
console.log(`Written: ${config.outputPath}`)

// Count TODOs
let todoCount = 0
for (const feature of Object.values(features)) {
  for (const cap of Object.values(feature.capabilities)) {
    if (cap.test_data) {
      for (const v of Object.values(cap.test_data)) {
        if (v === "TODO") todoCount++
      }
    }
  }
}
if (todoCount > 0) {
  console.log(`\nNote: ${todoCount} test_data fields need real values (search for "TODO")`)
}

console.log("")
console.log("Next steps:")
console.log("  1. Review QA_FEATURE_MODEL.json")
console.log("  2. Fill in TODO test data values")
console.log("  3. Run: npx qa-agent learn --url $URL (to upgrade from 'migrated' confidence)")
console.log("  4. All migrated capabilities start at 'migrated' confidence")
console.log("     Run learn sessions to upgrade them to 'observed_1x' and beyond")
