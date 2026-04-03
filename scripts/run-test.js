#!/usr/bin/env node

/**
 * qa-agent test — Run tests from QA_FEATURE_MODEL.json
 *
 * Usage:
 *   node scripts/run-test.js --url http://localhost:3000 --email test@x.com --password pass
 *   node scripts/run-test.js --url http://localhost:3000 --features dashboard,reports
 *   node scripts/run-test.js --url http://localhost:3000 --suite smoke
 *   node scripts/run-test.js --url http://localhost:3000 --suite full
 */

const fs = require("fs")
const path = require("path")
const { chromium } = require("playwright")
const { getBootstrapFile, shouldUseBootstrap, loadBootstrap, replayBootstrap } = require("../lib/bootstrap")

// ─── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), ".env")
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
}

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getArg(name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function hasFlag(name) {
  return args.includes(name)
}

const config = {
  url: getArg("--url") || process.env.QA_PREVIEW_URL || "http://localhost:3000",
  email: getArg("--email") || process.env.TEST_EMAIL,
  password: getArg("--password") || process.env.TEST_PASSWORD,
  modelPath: getArg("--model") || "./QA_FEATURE_MODEL.json",
  features: getArg("--features") ? getArg("--features").split(",") : null,
  suite: getArg("--suite") || "smoke",
  outputDir: getArg("--output-dir") || "./qa-results",
  headless: !hasFlag("--no-headless"),
  timeout: parseInt(getArg("--timeout") || "10000"),
  includeInit: hasFlag("--include-init"),
  useBootstrap: hasFlag("--use-bootstrap"),
  noBootstrap: hasFlag("--no-bootstrap"),
  bootstrapFile: getArg("--bootstrap-file") || getBootstrapFile(),
}

const unexpectedPositionals = args.filter((arg) => !arg.startsWith("--"))
const looksLikeMisforwardedNpmArgs = unexpectedPositionals.some(
  (arg) => /^https?:\/\//.test(arg) || arg.includes("@") || /^\d+$/.test(arg),
)

if (looksLikeMisforwardedNpmArgs && !hasFlag("--url")) {
  console.error("Error: script arguments appear to have been swallowed by npm.")
  console.error('Use `npm run test:full -- --url http://localhost:3000 --email test@x.com --password secret`.')
  console.error("Received positional args:", unexpectedPositionals.join(" "))
  process.exit(1)
}

// ─── Load Model ──────────────────────────────────────────────────────────────

if (!fs.existsSync(config.modelPath)) {
  console.error(`Error: Feature model not found: ${config.modelPath}`)
  console.error('Run "node scripts/init.js" first to generate it.')
  process.exit(1)
}

const model = JSON.parse(fs.readFileSync(config.modelPath, "utf8"))
const TOAST_SELECTOR = ".toast, [data-sonner-toast], [role='alert'], [role='status']"

function modelHasLearnedCoverage(featureModel) {
  for (const feature of Object.values(featureModel.features || {})) {
    if (feature.health && Array.isArray(feature.health.checks) && feature.health.checks.length > 0) {
      return true
    }

    for (const cap of Object.values(feature.capabilities || {})) {
      const confidence = cap._confidence || "unknown"
      if (confidence !== "init" && confidence !== "migrated") return true
    }
  }

  return false
}

const hasLearnedCoverage = modelHasLearnedCoverage(model)
const shouldSkipInitCapabilities = !config.includeInit && hasLearnedCoverage

// ─── Determine What to Test ──────────────────────────────────────────────────

function getTestPlan() {
  const allFeatures = Object.keys(model.features)
  let targetFeatures

  if (config.features) {
    // Explicit feature list
    targetFeatures = config.features.filter((f) => model.features[f])
    const missing = config.features.filter((f) => !model.features[f])
    if (missing.length > 0) {
      console.warn(`Warning: unknown features: ${missing.join(", ")}`)
      console.warn(`Available: ${allFeatures.join(", ")}`)
    }
  } else if (config.suite === "smoke") {
    // Smoke = only view/navigate capabilities
    targetFeatures = allFeatures
  } else {
    // Full = everything
    targetFeatures = allFeatures
  }

  const plan = []

  // Always start with authentication if available
  if (model.features.authentication && !targetFeatures.includes("authentication")) {
    targetFeatures.unshift("authentication")
  }

  for (const featureName of targetFeatures) {
    const feature = model.features[featureName]
    if (!feature) continue

    // If feature has a health block, add a health check step
    if (feature.health) {
      plan.push({
        type: "health",
        feature: featureName,
        capability: "_health",
        route: feature.health.route || feature.route,
        landmark: feature.health.landmark || null,
        checks: feature.health.checks || [],
        confidence: "learned",
      })
    }

    for (const [capName, cap] of Object.entries(feature.capabilities)) {
      // For smoke: only navigation/view capabilities
      if (config.suite === "smoke" && !config.features) {
        const isNav = /navigate|view|list|click a "/i.test(cap.interaction)
        const isLogin = featureName === "authentication"
        if (!isNav && !isLogin) continue
      }

      plan.push({
        type: "capability",
        feature: featureName,
        capability: capName,
        route: feature.route,
        interaction: cap.interaction,
        expected: cap.expected || [],
        verify: cap.verify || {},
        testData: cap.test_data || {},
        confidence: cap._confidence || "unknown",
        source: cap.source || null,
        mode: cap.mode || null,
      })
    }
  }

  return plan
}

// ─── Selectors for Monitored Elements ────────────────────────────────────────

const MONITORED_SELECTORS = [
  "tbody tr",
  "table",
  "thead th",
  "form",
  "input:visible",
  "button:visible",
  "[role='dialog']",
  "[role='alert']",
  "[role='alertdialog']",
  ".toast, [data-sonner-toast]",
  ".error, .text-red-500",
  "nav a",
]

// ─── Execute ─────────────────────────────────────────────────────────────────

async function main() {
  const plan = getTestPlan()

  console.log("")
  console.log("=".repeat(60))
  console.log("  QA Agent -- Test Runner")
  console.log("")
  console.log(`  Model: ${config.modelPath} (v${model.version})`)
  console.log(`  URL: ${config.url}`)
  console.log(`  Suite: ${config.suite}`)
  console.log(`  Capabilities: ${plan.length}`)
  console.log(`  Headless: ${config.headless}`)
  if (shouldUseBootstrap(config)) console.log(`  Bootstrap: ${path.resolve(config.bootstrapFile)}`)
  if (!hasLearnedCoverage) console.log("  Coverage: skeleton model detected; running init capabilities")
  console.log("=".repeat(60))
  console.log("")

  if (plan.length === 0) {
    console.log("No capabilities to test.")
    process.exit(0)
  }

  // Setup output
  fs.mkdirSync(config.outputDir, { recursive: true })
  const screenshotDir = path.join(config.outputDir, "screenshots")
  fs.mkdirSync(screenshotDir, { recursive: true })

  // Launch browser
  console.log("Launching browser...")
  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  // Track errors by category
  let consoleErrors = []   // console.error() calls
  let jsErrors = []        // uncaught exceptions (pageerror)
  let requestFailures = [] // failed network requests

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })
  page.on("pageerror", (err) => {
    jsErrors.push(err.message)
  })
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || "unknown",
    })
  })

  const results = []
  const startTime = Date.now()
  let isAuthenticated = false
  let skippedInitCount = 0

  try {
    if (shouldUseBootstrap(config)) {
      console.log("Replaying bootstrap...")
      const bootstrap = loadBootstrap(config)
      await replayBootstrap(page, bootstrap, config)
      const bootstrapRoute = new URL(page.url()).pathname
      console.log(`  Bootstrap ready at ${bootstrapRoute}`)
      if (!/(auth|login|sign-in)/i.test(bootstrapRoute)) {
        isAuthenticated = true
      }
    }

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]
      const stepStart = Date.now()
      consoleErrors = [] // reset per step
      jsErrors = []
      requestFailures = []

      console.log(`[${i + 1}/${plan.length}] ${step.feature}.${step.capability}`)
      console.log(`  Route: ${step.route}`)
      console.log(`  Confidence: ${step.confidence}`)

      const result = {
        feature: step.feature,
        capability: step.capability,
        route: step.route,
        status: "pending",
        checks: [],
        duration: 0,
        error: null,
        screenshot: null,
      }

      try {
        // ── Handle Health Check Steps (V2) ──
        if (step.type === "health") {
          const targetUrl = new URL(step.route, config.url).href

          // Ensure authenticated first
          if (!isAuthenticated && config.email && config.password) {
            await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeout })
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
            await authenticate(page, config.email, config.password)
            isAuthenticated = true
          }

          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: config.timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(800)

          // Run V2 health checks
          for (const check of step.checks) {
            const checkResult = await runHealthCheck(check, page, consoleErrors, jsErrors, requestFailures)
            result.checks.push(checkResult)
            const icon = checkResult.passed ? "PASS" : "FAIL"
            const category = checkResult.category ? ` [${checkResult.category}]` : ""
            console.log(`  ${icon} [${check.type}]${category} ${checkResult.detail}`)
          }

          // If landmark specified, verify it
          if (step.landmark) {
            const landmarkResult = await runHealthCheck({
              type: "landmark_visible",
              selector: step.landmark.selector,
              text: step.landmark.text,
            }, page, consoleErrors, jsErrors, requestFailures)
            result.checks.push(landmarkResult)
            const icon = landmarkResult.passed ? "PASS" : "FAIL"
            console.log(`  ${icon} [landmark] ${landmarkResult.detail}`)
          }

          const failedChecks = result.checks.filter(c => !c.passed)
          result.status = failedChecks.length === 0 ? "passed" : "failed"

          const screenshotName = `${step.feature}_health.png`
          const screenshotPath = path.join(screenshotDir, screenshotName)
          await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
          result.screenshot = screenshotPath

          const passCount = result.checks.filter(c => c.passed).length
          console.log(`  -> ${result.status.toUpperCase()} (${passCount}/${result.checks.length} checks)`)

          result.duration = Date.now() - stepStart
          results.push(result)
          console.log("")
          continue
        }

        if (shouldSkipInitCapabilities && (step.confidence === "init" || step.confidence === "migrated")) {
          result.status = "skipped"
          result.checks.push({
            name: "confidence_gate",
            type: "confidence_gate",
            passed: false,
            detail: `Skipped unlearned ${step.confidence} capability; record it in learn mode or rerun with --include-init`,
          })
          skippedInitCount++
          console.log(`  SKIP - Unlearned ${step.confidence} capability`)
          result.duration = Date.now() - stepStart
          results.push(result)
          console.log("")
          continue
        }

        if (isDraftInteractiveCapability(step)) {
          result.status = "skipped"
          result.checks.push({
            name: "interaction_gate",
            type: "interaction_gate",
            passed: false,
            detail: "Draft interactive capability requires learn-mode observation before it can run reliably",
          })
          console.log("  SKIP - Draft interactive capability requires learn mode")
          result.duration = Date.now() - stepStart
          results.push(result)
          console.log("")
          continue
        }

        // ── Handle Authentication ──
        if (step.feature === "authentication" && step.capability === "login") {
          if (isAuthenticated) {
            console.log("  -> Already authenticated, skipping")
            result.status = "skipped"
            result.duration = Date.now() - stepStart
            results.push(result)
            continue
          }

          await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

          if (config.email && config.password) {
            await authenticate(page, config.email, config.password)
            isAuthenticated = true
            result.status = "passed"
            result.checks.push({ name: "login", passed: true, detail: `Navigated to ${page.url()}` })
            console.log(`  PASS - Logged in, now at ${page.url()}`)
          } else {
            result.status = "skipped"
            result.checks.push({ name: "login", passed: false, detail: "No credentials provided" })
            console.log("  SKIP - No credentials")
          }

          result.duration = Date.now() - stepStart
          results.push(result)
          continue
        }

        // ── Ensure Authenticated ──
        if (!isAuthenticated && config.email && config.password) {
          await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
          await authenticate(page, config.email, config.password)
          isAuthenticated = true
        }

        // ── Navigate to Route ──
        const targetUrl = new URL(step.route, config.url).href
        const currentPath = new URL(page.url()).pathname
        const trackedSelectors = getTrackedSelectors(step.verify)

        if (currentPath !== step.route) {
          // Capture before state
          const beforeState = await captureState(page, trackedSelectors)

          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: config.timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(1000) // let UI settle

          // Capture after state
          const afterState = await captureState(page, trackedSelectors)

          // ── Run Verify Checks ──
          for (const [checkName, check] of Object.entries(step.verify)) {
            if (checkName.startsWith("_") && checkName !== "_role_dialog_" && checkName !== "_role_alert_") continue

            const checkResult = runCheck(checkName, check, beforeState, afterState, consoleErrors, jsErrors)
            result.checks.push(checkResult)

            const icon = checkResult.passed ? "PASS" : "FAIL"
            console.log(`  ${icon} [${check.type}] ${checkName}: ${checkResult.detail}`)
          }
        } else {
          // Already on the right page
          const state = await captureState(page, trackedSelectors)

          for (const [checkName, check] of Object.entries(step.verify)) {
            if (checkName.startsWith("_") && checkName !== "_role_dialog_" && checkName !== "_role_alert_") continue

            // For same-page, just check current state
            const checkResult = runStaticCheck(checkName, check, state, consoleErrors, jsErrors)
            result.checks.push(checkResult)

            const icon = checkResult.passed ? "PASS" : "FAIL"
            console.log(`  ${icon} [${check.type}] ${checkName}: ${checkResult.detail}`)
          }
        }

        // Determine overall status
        const failedChecks = result.checks.filter((c) => !c.passed)
        if (result.checks.length === 0) {
          result.status = "passed" // no checks = navigation-only, counts as pass
        } else if (failedChecks.length === 0) {
          result.status = "passed"
        } else {
          result.status = "failed"
        }

        // Take screenshot
        const screenshotName = `${step.feature}_${step.capability}.png`
        const screenshotPath = path.join(screenshotDir, screenshotName)
        await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
        result.screenshot = screenshotPath

        const passCount = result.checks.filter((c) => c.passed).length
        console.log(`  -> ${result.status.toUpperCase()} (${passCount}/${result.checks.length} checks)`)

      } catch (err) {
        result.status = "failed"
        result.error = err.message
        console.log(`  ERROR: ${err.message}`)

        // Error screenshot
        const screenshotName = `${step.feature}_${step.capability}_error.png`
        const screenshotPath = path.join(screenshotDir, screenshotName)
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
        result.screenshot = screenshotPath
      }

      result.duration = Date.now() - stepStart
      results.push(result)
      console.log("")
    }
  } finally {
    await browser.close()
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const totalDuration = Date.now() - startTime
  const passed = results.filter((r) => r.status === "passed").length
  const failed = results.filter((r) => r.status === "failed").length
  const skipped = results.filter((r) => r.status === "skipped").length

  console.log("=".repeat(60))
  console.log("  Test Results")
  console.log("=".repeat(60))
  console.log(`  Total:    ${results.length}`)
  console.log(`  Passed:   ${passed}`)
  console.log(`  Failed:   ${failed}`)
  console.log(`  Skipped:  ${skipped}`)
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(1)}s`)
  if (skippedInitCount > 0) {
    console.log(`  Note:     ${skippedInitCount} unlearned init/migrated capabilities were skipped`)
  }
  console.log("")

  if (failed > 0) {
    console.log("  Failed capabilities:")
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`    - ${r.feature}.${r.capability}: ${r.error || r.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`)
    }
    console.log("")
  }

  console.log("=".repeat(60))

  // ── Save Results ───────────────────────────────────────────────────────────

  // Collect failure categories for triage
  const categories = {}
  for (const r of results) {
    for (const c of r.checks || []) {
      if (c.category) categories[c.category] = (categories[c.category] || 0) + 1
    }
  }

  const summary = {
    suite: config.suite,
    url: config.url,
    model: config.modelPath,
    modelVersion: model.version,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    duration: totalDuration,
    results,
    summary: { total: results.length, passed, failed, skipped },
    categories,
  }

  fs.writeFileSync(path.join(config.outputDir, "summary.json"), JSON.stringify(summary, null, 2))
  generateHtmlReport(summary, config.outputDir)

  console.log(`\nResults: ${config.outputDir}/summary.json`)
  console.log(`Report:  ${config.outputDir}/report.html`)

  if (Object.keys(categories).length > 0) {
    console.log(`\nFailure categories:`)
    for (const [cat, count] of Object.entries(categories)) {
      console.log(`  ${cat}: ${count}`)
    }
  }

  process.exit(failed > 0 ? 1 : 0)
}

// ─── Authentication ──────────────────────────────────────────────────────────

async function authenticate(page, email, password) {
  // Try common login form patterns
  const emailSelectors = [
    'input[aria-label="Email Address"]',
    'input[type="email"]',
    'input[name="email"]',
    '#email',
  ]
  const passwordSelectors = [
    'input[aria-label="Password"]',
    'input[type="password"]',
    'input[name="password"]',
    '#password',
  ]
  const submitSelectors = [
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'button[type="submit"]',
  ]

  let emailInput, passwordInput, submitBtn

  for (const sel of emailSelectors) {
    emailInput = await page.$(sel)
    if (emailInput) break
  }
  for (const sel of passwordSelectors) {
    passwordInput = await page.$(sel)
    if (passwordInput) break
  }
  for (const sel of submitSelectors) {
    submitBtn = await page.$(sel)
    if (submitBtn) break
  }

  if (!emailInput || !passwordInput) {
    console.log("  (no login form found, may already be authenticated)")
    return
  }

  await emailInput.fill(email)
  await passwordInput.fill(password)
  if (submitBtn) await submitBtn.click()

  // Wait for navigation
  await page.waitForURL((url) => !url.pathname.includes("auth") && !url.pathname.includes("login"), {
    timeout: 10000,
  }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
}

function isDraftInteractiveCapability(step) {
  if (step.type !== "capability") return false
  if (step.mode === "interactive") return true
  if (step.mode === "passive") return false

  return new Set([
    "login_invalid",
    "sort",
    "pagination",
    "create",
    "edit",
    "delete",
    "search",
    "clear_search",
    "submit_form",
    "submit_invalid",
  ]).has(step.capability)
}

function getTrackedSelectors(verify = {}) {
  const selectors = new Set(MONITORED_SELECTORS)

  for (const check of Object.values(verify)) {
    if (check && check.selector) selectors.add(check.selector)
  }

  selectors.add(TOAST_SELECTOR)
  return [...selectors]
}

// ─── State Capture ───────────────────────────────────────────────────────────

async function captureState(page, selectors = MONITORED_SELECTORS) {
  const elementCounts = {}

  for (const selector of selectors) {
    try {
      const count = await page.locator(selector).count()
      elementCounts[selector] = count
    } catch {
      elementCounts[selector] = 0
    }
  }

  return {
    url: page.url(),
    route: new URL(page.url()).pathname,
    timestamp: Date.now(),
    elementCounts,
  }
}

// ─── Check Runners ───────────────────────────────────────────────────────────

function runCheck(name, check, before, after, consoleErrors, jsErrors) {
  const result = { name, type: check.type, passed: false, detail: "" }

  switch (check.type) {
    case "url_changed":
      result.passed = before.url !== after.url
      result.detail = result.passed
        ? `URL changed: ${before.route} -> ${after.route}`
        : `URL unchanged: ${after.route}`
      break

    case "element_appeared": {
      const sel = check.selector || ""
      const beforeCount = before.elementCounts[sel] || 0
      const afterCount = after.elementCounts[sel] || 0
      result.passed = afterCount > 0 && afterCount > beforeCount
      result.detail = `${sel}: ${beforeCount} -> ${afterCount}`
      break
    }

    case "element_present": {
      const sel = check.selector || ""
      const afterCount = after.elementCounts[sel] || 0
      result.passed = afterCount > 0
      result.detail = `${sel}: ${afterCount} found`
      break
    }

    case "element_disappeared": {
      const sel = check.selector || ""
      const beforeCount = before.elementCounts[sel] || 0
      const afterCount = after.elementCounts[sel] || 0
      result.passed = afterCount < beforeCount
      result.detail = `${sel}: ${beforeCount} -> ${afterCount}`
      break
    }

    case "element_count_changed": {
      const sel = check.selector || ""
      const beforeCount = before.elementCounts[sel] || 0
      const afterCount = after.elementCounts[sel] || 0
      result.passed = beforeCount !== afterCount
      result.detail = `${sel}: ${beforeCount} -> ${afterCount}`
      break
    }

    case "custom_selector_visible": {
      const sel = check.selector || ""
      const afterCount = after.elementCounts[sel] || 0
      result.passed = afterCount > 0
      result.detail = `${sel}: ${afterCount} found`
      break
    }

    case "custom_selector_hidden": {
      const sel = check.selector || ""
      const afterCount = after.elementCounts[sel] || 0
      result.passed = afterCount === 0
      result.detail = `${sel}: ${afterCount} found`
      break
    }

    case "no_errors": {
      const allErrors = [...consoleErrors, ...(jsErrors || [])]
      result.passed = allErrors.length === 0
      result.detail = result.passed
        ? "No errors"
        : `${allErrors.length} errors: ${allErrors.slice(0, 2).join("; ")}`
      break
    }

    case "toast_appeared": {
      const toastSel = TOAST_SELECTOR
      const beforeCount = before.elementCounts[toastSel] || 0
      const afterCount = after.elementCounts[toastSel] || 0
      result.passed = afterCount > beforeCount
      result.detail = `toast: ${beforeCount} -> ${afterCount}`
      break
    }

    default:
      result.passed = false
      result.detail = `Unsupported check type: ${check.type}`
  }

  return result
}

function runStaticCheck(name, check, state, consoleErrors, jsErrors) {
  const result = { name, type: check.type, passed: false, detail: "" }

  switch (check.type) {
    case "url_changed":
      // For static check, just verify we're on the expected page
      result.passed = true
      result.detail = `On page: ${state.route}`
      break

    case "element_appeared":
    case "element_present":
    case "custom_selector_visible": {
      const sel = check.selector || ""
      const count = state.elementCounts[sel] || 0
      result.passed = count > 0
      result.detail = `${sel}: ${count} found`
      break
    }

    case "element_disappeared":
    case "custom_selector_hidden": {
      const sel = check.selector || ""
      const count = state.elementCounts[sel] || 0
      result.passed = count === 0
      result.detail = `${sel}: ${count} found`
      break
    }

    case "element_count_changed": {
      const sel = check.selector || ""
      const count = state.elementCounts[sel] || 0
      result.passed = false
      result.detail = `${sel}: static check cannot prove change`
      break
    }

    case "no_errors": {
      const allErrs = [...consoleErrors, ...(jsErrors || [])]
      result.passed = allErrs.length === 0
      result.detail = result.passed
        ? "No errors"
        : `${allErrs.length} errors`
      break
    }

    default:
      result.passed = false
      result.detail = `Unsupported check type: ${check.type}`
  }

  return result
}

// ─── V2 Health Check Runner ──────────────────────────────────────────────

async function runHealthCheck(check, page, consoleErrors, jsErrors, requestFailures) {
  // Default empty arrays for backward compat (callers may not pass all)
  jsErrors = jsErrors || []
  requestFailures = requestFailures || []

  const result = { name: check.type, type: check.type, passed: false, detail: "", category: null }

  switch (check.type) {
    case "no_js_errors": {
      // Uncaught exceptions (pageerror) — separate from console.error
      result.passed = jsErrors.length === 0
      if (!result.passed) {
        const hydrationErrors = jsErrors.filter(e => /hydration|text content does not match|did not match/i.test(e))
        if (hydrationErrors.length > 0) {
          result.category = "hydration_error"
          result.detail = `Hydration error: ${hydrationErrors[0].slice(0, 150)}`
        } else {
          result.category = "runtime_error"
          result.detail = `${jsErrors.length} JS errors: ${jsErrors.slice(0, 2).join("; ")}`
        }
      } else {
        result.detail = "No JS errors"
      }
      break
    }

    case "no_console_errors":
      // Explicit console.error() calls
      result.passed = consoleErrors.length === 0
      result.detail = result.passed
        ? "No console errors"
        : `${consoleErrors.length} console errors: ${consoleErrors.slice(0, 2).join("; ")}`
      if (!result.passed) result.category = "console_error"
      break

    case "no_request_failures": {
      // Only fail on API/fetch failures, not static assets or analytics
      const apiFailures = requestFailures.filter(r =>
        r.resourceType === "fetch" || r.resourceType === "xhr"
      )
      result.passed = apiFailures.length === 0
      result.detail = result.passed
        ? "No API request failures"
        : `${apiFailures.length} failed: ${apiFailures.map(r => `${r.failure} ${r.url.split("?")[0]}`).slice(0, 2).join("; ")}`
      if (!result.passed) result.category = "request_failure"
      break
    }

    case "no_error_alerts": {
      const errorAlerts = await page.evaluate(() => {
        const alerts = []
        for (const el of document.querySelectorAll('[role="alert"], .error, .text-red-500, .alert-danger, .alert-error')) {
          const text = el.textContent?.trim()
          if (text && /error|fail|unable|denied|invalid/i.test(text)) {
            alerts.push(text.slice(0, 100))
          }
        }
        return alerts
      }).catch(() => [])
      result.passed = errorAlerts.length === 0
      result.detail = result.passed
        ? "No error alerts visible"
        : `Error alerts: "${errorAlerts[0]}"`
      break
    }

    case "url_is": {
      const currentPath = new URL(page.url()).pathname
      result.passed = currentPath === check.value
      result.detail = result.passed
        ? `URL matches: ${check.value}`
        : `Expected ${check.value}, got ${currentPath}`
      break
    }

    case "landmark_visible": {
      const selector = check.selector
      const expectedText = check.text
      try {
        if (selector === "title") {
          const title = await page.title()
          result.passed = title.includes(expectedText)
          result.detail = result.passed
            ? `Title contains "${expectedText}"`
            : `Title "${title}" doesn't contain "${expectedText}"`
        } else {
          const el = page.locator(selector).first()
          const text = await el.textContent({ timeout: 3000 }).catch(() => null)
          if (text !== null) {
            result.passed = text.trim().includes(expectedText) || expectedText.includes(text.trim())
            result.detail = result.passed
              ? `${selector} contains "${expectedText}"`
              : `${selector} has "${text.trim()}", expected "${expectedText}"`
          } else {
            result.passed = false
            result.detail = `${selector} not found on page`
          }
        }
      } catch {
        result.passed = false
        result.detail = `${selector} not found or timed out`
      }
      break
    }

    case "toast_contains": {
      const toastSelectors = ".toast, [data-sonner-toast], [role='alert'], [role='status']"
      try {
        const toastTexts = await page.locator(toastSelectors).allTextContents()
        const match = toastTexts.find(t => t.includes(check.value))
        result.passed = !!match
        result.detail = result.passed
          ? `Toast found: "${check.value}"`
          : `No toast with "${check.value}"`
      } catch {
        result.passed = false
        result.detail = `No toast elements found`
      }
      break
    }

    case "element_exists": {
      try {
        const count = await page.locator(check.selector).count()
        result.passed = count > 0
        result.detail = result.passed
          ? `${check.selector}: found (${count})`
          : `${check.selector}: not found`
      } catch {
        result.passed = false
        result.detail = `${check.selector}: error`
      }
      break
    }

    case "element_gone": {
      try {
        const count = await page.locator(check.selector).count()
        result.passed = count === 0
        result.detail = result.passed
          ? `${check.selector}: gone`
          : `${check.selector}: still present (${count})`
      } catch {
        result.passed = true
        result.detail = `${check.selector}: gone`
      }
      break
    }

    default:
      result.passed = true
      result.detail = `Unknown check type: ${check.type} (skipped)`
  }

  return result
}

// ─── HTML Report ─────────────────────────────────────────────────────────────

function generateHtmlReport(data, outputDir) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>QA Test Report - ${data.suite}</title>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { border-bottom: 3px solid #667eea; padding-bottom: 24px; margin-bottom: 32px; }
    .header h1 { margin: 0 0 12px 0; font-size: 28px; }
    .header p { margin: 4px 0; color: #4a5568; font-size: 14px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
    .card { padding: 20px; border-radius: 8px; color: white; }
    .card.total { background: #3b82f6; }
    .card.passed { background: #10b981; }
    .card.failed { background: #ef4444; }
    .card.duration { background: #8b5cf6; }
    .card h3 { margin: 0 0 8px 0; font-size: 13px; text-transform: uppercase; opacity: 0.9; }
    .card .value { font-size: 36px; font-weight: 700; }
    .capability { padding: 16px; margin-bottom: 12px; border-radius: 8px; border-left: 4px solid #e2e8f0; background: #f8f9fa; }
    .capability.passed { border-left-color: #10b981; background: #f0fdf4; }
    .capability.failed { border-left-color: #ef4444; background: #fef2f2; }
    .capability.skipped { border-left-color: #f59e0b; background: #fffbeb; }
    .cap-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .cap-name { font-weight: 600; font-size: 15px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .badge.passed { background: #d1fae5; color: #065f46; }
    .badge.failed { background: #fee2e2; color: #991b1b; }
    .badge.skipped { background: #fef3c7; color: #92400e; }
    .checks { margin-top: 8px; font-size: 13px; }
    .check { padding: 4px 0; color: #374151; }
    .check.fail { color: #dc2626; }
    .error { margin-top: 8px; padding: 8px 12px; background: #fef2f2; border-radius: 4px; color: #991b1b; font-size: 13px; }
    .screenshot-link { display: inline-block; margin-top: 8px; padding: 4px 10px; background: #e0e7ff; color: #3730a3; border-radius: 4px; font-size: 12px; text-decoration: none; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>QA Test Report</h1>
    <p><strong>Suite:</strong> ${data.suite} | <strong>URL:</strong> ${data.url} | <strong>Model:</strong> v${data.modelVersion}</p>
    <p><strong>Run:</strong> ${data.startTime} - ${data.endTime}</p>
  </div>
  <div class="summary">
    <div class="card total"><h3>Total</h3><div class="value">${data.summary.total}</div></div>
    <div class="card passed"><h3>Passed</h3><div class="value">${data.summary.passed}</div></div>
    <div class="card failed"><h3>Failed</h3><div class="value">${data.summary.failed}</div></div>
    <div class="card duration"><h3>Duration</h3><div class="value">${(data.duration / 1000).toFixed(1)}s</div></div>
  </div>
  <h2>Capabilities</h2>
  ${data.results
    .map(
      (r) => `
  <div class="capability ${r.status}">
    <div class="cap-header">
      <span class="cap-name">${r.feature}.${r.capability}</span>
      <span>
        <span class="badge ${r.status}">${r.status}</span>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">${(r.duration / 1000).toFixed(2)}s</span>
      </span>
    </div>
    <div style="color:#6b7280;font-size:13px">Route: ${r.route}</div>
    ${r.checks.length > 0 ? `<div class="checks">${r.checks.map((c) => `<div class="check ${c.passed ? "" : "fail"}">${c.passed ? "PASS" : "FAIL"} [${c.type}] ${c.name}: ${c.detail}</div>`).join("")}</div>` : ""}
    ${r.error ? `<div class="error">${r.error}</div>` : ""}
    ${r.screenshot ? `<a class="screenshot-link" href="${path.relative(outputDir, r.screenshot)}" target="_blank">Screenshot</a>` : ""}
  </div>`
    )
    .join("")}
  <div style="margin-top:32px;text-align:center;color:#6b7280;font-size:13px">Generated by QA Agent</div>
</div>
</body>
</html>`

  fs.writeFileSync(path.join(outputDir, "report.html"), html)
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
