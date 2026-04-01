#!/usr/bin/env node

/**
 * qa-agent e2e — Replay recorded E2E flows from QA_RECORDED_FLOWS.json
 *
 * Usage:
 *   node scripts/run-e2e.js --url http://localhost:3000 --email test@x.com --password pass
 *   node scripts/run-e2e.js --url http://localhost:3000 --flow login_flow
 *   node scripts/run-e2e.js --url http://localhost:3000 --tag smoke
 *   node scripts/run-e2e.js --url http://localhost:3000 --stop-on-fail --no-headless
 *   node scripts/run-e2e.js --url http://localhost:3000 --demo
 */

const fs = require("fs")
const path = require("path")
const { chromium } = require("playwright")
const { capturePageState, hasBlockingOverlay, dismissBlockingOverlays } = require("../lib/page-state")
const { resolveValue } = require("../lib/resolve-value")

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
const demoMode = args.includes("--demo")

function getArg(name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function hasFlag(name) {
  return args.includes(name)
}

// Parse --var key=value pairs
function getVars() {
  const vars = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--var" && args[i + 1]) {
      const [key, ...rest] = args[i + 1].split("=")
      if (key) vars[key] = rest.join("=")
    }
  }
  return vars
}

const config = {
  url: getArg("--url") || process.env.QA_PREVIEW_URL || "http://localhost:3000",
  email: getArg("--email") || process.env.TEST_EMAIL,
  password: getArg("--password") || process.env.TEST_PASSWORD,
  flowsPath: getArg("--flows") || "./QA_RECORDED_FLOWS.json",
  flowFilter: getArg("--flow") || null,
  tagFilter: getArg("--tag") || null,
  outputDir: getArg("--output-dir") || "./qa-results",
  headless: demoMode ? false : !hasFlag("--no-headless"),
  stopOnFail: hasFlag("--stop-on-fail"),
  heal: hasFlag("--heal"),
  timeout: parseInt(getArg("--timeout") || "10000"),
  slowMo: parseInt(getArg("--slow-mo") || (demoMode ? "250" : "0"), 10),
  stepDelay: parseInt(getArg("--step-delay") || (demoMode ? "600" : "0"), 10),
  demo: demoMode,
  vars: getVars(),
}

// Selector healing tracker — records which selectors worked/failed/healed
const selectorHealth = {
  total: 0,
  primary: 0,
  fallback: 0,
  healed: 0,
  failed: 0,
  healedActions: [], // { flowName, stepNumber, actionIndex, original, healed }
}

// ─── Load Flows ──────────────────────────────────────────────────────────────

if (!fs.existsSync(config.flowsPath)) {
  console.error(`Error: Flows file not found: ${config.flowsPath}`)
  console.error('Run "qa-agent learn" and record flows with [r]/[f] first.')
  process.exit(1)
}

const flowData = JSON.parse(fs.readFileSync(config.flowsPath, "utf8"))
let flows = flowData.flows || []

// Filter flows
if (config.flowFilter) {
  flows = flows.filter(f => f.name === config.flowFilter || f.name.includes(config.flowFilter))
}
if (config.tagFilter) {
  flows = flows.filter(f => f.tags && f.tags.includes(config.tagFilter))
}

// ─── Warn on known-broken flows ─────────────────────────────────────────────

for (const flow of flows) {
  if (flow._validationStatus === "failed") {
    console.log(`  ⚠ Flow "${flow.name}" has known validation issues:`)
    for (const issue of flow._validationIssues || []) {
      console.log(`    - ${issue}`)
    }
  }
}

// ─── Selector Resolver (with auto-healing) ─────────────────────────────────

const DYNAMIC_ID_PATTERN = /^#(radix|rc-|headlessui|downshift|mui|:)/

async function resolveSelector(page, action) {
  selectorHealth.total++
  const isDynamic = action.selector && DYNAMIC_ID_PATTERN.test(action.selector)

  // Helper: quick check if selector finds anything (1s timeout max)
  async function quickCount(sel) {
    try {
      const loc = page.locator(sel)
      await loc.first().waitFor({ state: "attached", timeout: 1000 }).catch(() => {})
      return await loc.count()
    } catch { return 0 }
  }

  // 1. Try primary selector (unless it's a known dynamic ID)
  if (action.selector && !isDynamic) {
    if (await quickCount(action.selector) > 0) {
      selectorHealth.primary++
      return { selector: action.selector, method: "primary" }
    }
  }

  // 2. Try fallbacks
  if (action.selectorFallbacks) {
    for (const fallback of action.selectorFallbacks) {
      if (DYNAMIC_ID_PATTERN.test(fallback)) continue
      if (await quickCount(fallback) > 0) {
        selectorHealth.fallback++
        return { selector: fallback, method: "fallback" }
      }
    }
  }

  // 3. Try text-based selector
  if (action.text) {
    const textSel = `text="${action.text}"`
    if (await quickCount(textSel) > 0) {
      selectorHealth.fallback++
      return { selector: textSel, method: "text" }
    }
  }

  // 4. Fuzzy healing — scan the page for similar elements
  const healed = await fuzzyFindElement(page, action)
  if (healed) {
    selectorHealth.healed++
    return { selector: healed, method: "healed" }
  }

  // 5. Nothing worked
  selectorHealth.failed++
  return { selector: action.selector || "", method: "failed" }
}

// ─── Fuzzy Element Finder ───────────────────────────────────────────────────

async function fuzzyFindElement(page, action) {
  // Quick check helper (500ms timeout per attempt)
  async function qc(sel) {
    try {
      const loc = page.locator(sel)
      await loc.first().waitFor({ state: "attached", timeout: 500 }).catch(() => {})
      return await loc.count()
    } catch { return 0 }
  }

  // Strategy 1: Find by tag + partial text match
  if (action.text && action.text.length > 1) {
    const tag = action.tag || guessTagFromAction(action)
    const escapedText = action.text.replace(/"/g, '\\"')
    const tags = tag ? [tag, "button", "a"] : ["button", "a", "div", "span"]
    for (const t of tags) {
      const sel = `${t}:has-text("${escapedText}")`
      const c = await qc(sel)
      if (c > 0 && c < 5) return sel
    }

    // Try role-based with text
    for (const role of ["button", "link", "menuitem", "option", "tab", "combobox"]) {
      const sel = `[role="${role}"]:has-text("${escapedText}")`
      const c = await qc(sel)
      if (c > 0 && c < 5) return sel
    }
  }

  // Strategy 2: Find by aria-label
  const ariaMatch = (action.selector || "").match(/aria-label="([^"]+)"/)
  if (ariaMatch) {
    const sel = `[aria-label="${ariaMatch[1]}"]`
    if (await qc(sel) > 0) return sel
  }

  // Strategy 3: Find by field name (for inputs)
  if (action.field && action.type === "fill") {
    for (const sel of [
      `input[placeholder*="${action.field}" i]`,
      `input[name*="${action.field}" i]`,
      `input[aria-label*="${action.field}" i]`,
      `textarea[placeholder*="${action.field}" i]`,
    ]) {
      if (await qc(sel) > 0) return sel
    }
  }

  // Strategy 4: Find by href
  const hrefMatch = (action.selector || "").match(/href="([^"]+)"/)
  if (hrefMatch) {
    const sel = `a[href="${hrefMatch[1]}"]`
    if (await qc(sel) > 0) return sel
  }

  // Strategy 5: Find by data-testid partial match
  const testIdMatch = (action.selector || "").match(/data-testid="([^"]+)"/)
  if (testIdMatch) {
    const partial = testIdMatch[1].split("-").slice(0, 2).join("-")
    const sel = `[data-testid*="${partial}"]`
    const c = await qc(sel)
    if (c > 0 && c < 5) return sel
  }

  return null
}

function guessTagFromAction(action) {
  if (action.type === "fill") return "input"
  if (action.type === "click") return action.tag || "button"
  if (action.type === "select") return "select"
  return null
}

// ─── Action Executor ────────────────────────────────────────────────────────

async function executeAction(page, action, cfg, healContext) {
  const resolved = await resolveSelector(page, action)
  const selector = resolved.selector
  const method = resolved.method
  const value = resolveValue(action.value, cfg)

  // Track healing
  if (method === "healed" || method === "fallback" || method === "text") {
    if (healContext) {
      selectorHealth.healedActions.push({
        flowName: healContext.flowName,
        stepNumber: healContext.stepNumber,
        actionIndex: healContext.actionIndex,
        original: action.selector,
        healed: selector,
        method,
      })
    }
  }

  // Build result base
  const mkResult = (extra) => ({
    action: action.type,
    selector,
    status: "ok",
    selectorMethod: method,
    originalSelector: method !== "primary" ? action.selector : undefined,
    ...extra,
  })

  try {
    return await executeActionInner(page, action, selector, value, cfg, mkResult)
  } catch (err) {
    // If blocked by overlay, try dismiss + retry once
    if (err.message.includes("intercepts pointer events")) {
      console.log(`      ↳ blocked by overlay, attempting dismiss...`)
      const dismissed = await dismissBlockingOverlays(page)
      if (dismissed) {
        console.log(`      ↳ overlay dismissed, retrying action...`)
        return await executeActionInner(page, action, selector, value, cfg, mkResult)
      }
      // Last resort: force click for click/submit actions
      if (action.type === "click" || action.type === "submit") {
        console.log(`      ↳ force-clicking...`)
        await page.locator(selector).first().click({ force: true, timeout: cfg.timeout })
        return mkResult()
      }
    }
    throw err
  }
}

async function executeActionInner(page, action, selector, value, cfg, mkResult) {
  switch (action.type) {
    case "fill":
      await page.locator(selector).first().fill(value, { timeout: cfg.timeout })
      return mkResult({ value: action.value === "$PASSWORD" ? "***" : value })

    case "click":
      await page.locator(selector).first().click({ timeout: cfg.timeout })
      return mkResult()

    case "select": {
      // For select actions, resolve the TRIGGER selector (not the option selector)
      // The option element doesn't exist on page until the dropdown is open
      const triggerResolved = await resolveSelector(page, {
        selector: action.triggerSelector || action.selector,
        text: action.triggerText,
        tag: "button",
        type: "click",
        selectorFallbacks: [
          ...(action.triggerText ? [
            `button:has-text('${action.triggerText}')`,
            `[role="combobox"]:has-text('${action.triggerText}')`,
          ] : []),
          ...(action.selectorFallbacks || []),
        ],
      })

      // Check for native <select>
      let isNative = false
      try {
        const tagName = await page.locator(triggerResolved.selector).first().evaluate(e => e.tagName).catch(() => "")
        isNative = tagName === "SELECT"
      } catch {}

      if (isNative) {
        const pos = action.position || 1
        await page.locator(triggerResolved.selector).first().selectOption({ index: pos - 1 }, { timeout: cfg.timeout })
      } else {
        // Custom dropdown — click the trigger to open, then pick by position
        await page.locator(triggerResolved.selector).first().click({ timeout: cfg.timeout })
        await page.waitForTimeout(500)

        const pos = action.position || 1
        const optionLoc = page.locator('[role="option"], [role="menuitem"], [role="listbox"] li, [cmdk-item], [data-value]')
        await optionLoc.first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {})
        const optCount = await optionLoc.count()
        if (optCount >= pos) {
          await optionLoc.nth(pos - 1).click({ timeout: cfg.timeout })
        } else if (optCount > 0) {
          await optionLoc.first().click({ timeout: cfg.timeout })
        } else {
          throw new Error(`No dropdown options found after clicking trigger "${triggerResolved.selector}"`)
        }
      }
      return mkResult({ selector: triggerResolved.selector, value: `option ${action.position || 1}`, selectorMethod: triggerResolved.method })
    }

    case "hover":
      await page.locator(selector).first().hover({ timeout: cfg.timeout })
      return mkResult()

    case "press":
      if (selector) {
        await page.locator(selector).first().press(action.key, { timeout: cfg.timeout })
      } else {
        await page.keyboard.press(action.key)
      }
      return mkResult({ key: action.key })

    case "waitForURL":
      await page.waitForURL(`**${value}`, { timeout: cfg.timeout })
      return { action: action.type, value, status: "ok", selectorMethod: "n/a" }

    case "submit":
      await page.locator(selector).first().click({ timeout: cfg.timeout })
      return mkResult()

    default:
      return { action: action.type, status: "skipped", detail: `Unknown action type: ${action.type}`, selectorMethod: "n/a" }
  }
}

// ─── Verify Check Runner ────────────────────────────────────────────────────

async function runVerifyCheck(check, page, consoleErrors) {
  const result = { type: check.type, passed: false, detail: "" }

  switch (check.type) {
    case "text_visible": {
      try {
        const loc = page.locator(`text="${check.value}"`)
        const count = await loc.count()
        result.passed = count > 0
        result.detail = result.passed
          ? `"${check.value}" visible`
          : `"${check.value}" not found`
      } catch {
        result.passed = false
        result.detail = `"${check.value}" not found`
      }
      break
    }

    case "toast_contains": {
      const toastSelectors = ".toast, [data-sonner-toast], [role='alert'], [role='status']"
      try {
        const texts = await page.locator(toastSelectors).allTextContents()
        const match = texts.find(t => t.includes(check.value))
        result.passed = !!match
        result.detail = result.passed
          ? `Toast: "${check.value}"`
          : `No toast with "${check.value}"`
      } catch {
        result.passed = false
        result.detail = "No toast elements found"
      }
      break
    }

    case "url_is": {
      const currentPath = new URL(page.url()).pathname
      result.passed = currentPath === check.value
      result.detail = result.passed
        ? `URL: ${check.value}`
        : `Expected ${check.value}, got ${currentPath}`
      break
    }

    case "landmark_visible": {
      try {
        if (check.selector === "title") {
          const title = await page.title()
          result.passed = title.includes(check.text)
          result.detail = result.passed
            ? `Title contains "${check.text}"`
            : `Title "${title}" missing "${check.text}"`
        } else {
          const el = page.locator(check.selector).first()
          const text = await el.textContent({ timeout: 3000 }).catch(() => null)
          if (text !== null) {
            result.passed = text.trim().includes(check.text) || check.text.includes(text.trim())
            result.detail = result.passed
              ? `${check.selector} = "${check.text}"`
              : `${check.selector} has "${text.trim()}", expected "${check.text}"`
          } else {
            result.passed = false
            result.detail = `${check.selector} not found`
          }
        }
      } catch {
        result.passed = false
        result.detail = `${check.selector} not found`
      }
      break
    }

    case "element_exists": {
      try {
        const count = await page.locator(check.selector).count()
        result.passed = count > 0
        result.detail = result.passed
          ? `${check.selector}: found`
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
          : `${check.selector}: still present`
      } catch {
        result.passed = true
        result.detail = `${check.selector}: gone`
      }
      break
    }

    case "no_js_errors":
    case "no_console_errors": {
      result.passed = consoleErrors.length === 0
      result.detail = result.passed
        ? "No errors"
        : `${consoleErrors.length} errors: ${consoleErrors.slice(0, 2).join("; ")}`
      break
    }

    case "no_error_alerts": {
      const errorAlerts = await page.evaluate(() => {
        const alerts = []
        for (const el of document.querySelectorAll('[role="alert"], .error, .text-red-500, .alert-danger')) {
          const text = el.textContent?.trim()
          if (text && /error|fail|unable|denied|invalid/i.test(text)) {
            alerts.push(text.slice(0, 100))
          }
        }
        return alerts
      }).catch(() => [])
      result.passed = errorAlerts.length === 0
      result.detail = result.passed
        ? "No error alerts"
        : `Error: "${errorAlerts[0]}"`
      break
    }

    default:
      result.passed = true
      result.detail = `Unknown check: ${check.type} (skipped)`
  }

  return result
}

// ─── Page Stability ─────────────────────────────────────────────────────────

async function waitForStableState(page) {
  // Wait for network
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

  // Wait for animations to finish (max 2s)
  await page.evaluate(() => {
    return new Promise(resolve => {
      const anims = document.getAnimations()
      if (anims.length === 0) return resolve()
      Promise.allSettled(anims.map(a => a.finished)).then(resolve)
      setTimeout(resolve, 2000)
    })
  }).catch(() => {})

  // Brief settle
  await page.waitForTimeout(300)
}

// ─── Step Executor ──────────────────────────────────────────────────────────

async function executeStep(page, step, cfg, consoleErrors, flowName) {
  const stepResult = {
    stepNumber: step.stepNumber,
    description: step.description || `Step ${step.stepNumber}`,
    route: step.route,
    status: "pending",
    actionsExecuted: [],
    checks: [],
    duration: 0,
    error: null,
    screenshot: null,
  }

  const stepStart = Date.now()

  try {
    // Dismiss any blocking overlays before starting this step
    const preState = await capturePageState(page)
    if (hasBlockingOverlay(preState)) {
      console.log(`      ↳ overlay detected before step, dismissing...`)
      const dismissed = await dismissBlockingOverlays(page)
      if (dismissed) {
        console.log(`      ↳ overlay dismissed`)
      } else {
        console.log(`      ↳ WARNING: could not dismiss overlay, proceeding anyway`)
      }
    }

    // Execute all actions in order
    for (let ai = 0; ai < (step.actions || []).length; ai++) {
      const action = step.actions[ai]
      const healContext = { flowName, stepNumber: step.stepNumber, actionIndex: ai }
      const actionResult = await executeAction(page, action, cfg, healContext)
      stepResult.actionsExecuted.push(actionResult)

      const val = actionResult.value ? ` "${actionResult.value}"` : ""
      const key = actionResult.key ? ` ${actionResult.key}` : ""
      const healTag = actionResult.selectorMethod !== "primary" && actionResult.selectorMethod !== "n/a"
        ? ` [${actionResult.selectorMethod}]`
        : ""
      console.log(`      ${actionResult.status === "ok" ? "ok" : "!!"} ${actionResult.action} ${actionResult.selector || ""}${val}${key}${healTag}`)

      if (cfg.stepDelay > 0) {
        await page.waitForTimeout(cfg.stepDelay)
      }
    }

    // Wait for page to stabilize
    await waitForStableState(page)

    // Run verify checks
    if (step.verify && step.verify.length > 0) {
      for (const check of step.verify) {
        const checkResult = await runVerifyCheck(check, page, consoleErrors)
        stepResult.checks.push(checkResult)
        const icon = checkResult.passed ? "PASS" : "FAIL"
        console.log(`      ${icon} [${check.type}] ${checkResult.detail}`)
      }
    }

    // Determine step status
    const failedChecks = stepResult.checks.filter(c => !c.passed)
    stepResult.status = failedChecks.length > 0 ? "failed" : "passed"

  } catch (err) {
    stepResult.status = "failed"
    stepResult.error = err.message
    console.log(`      ERROR: ${err.message}`)
  }

  stepResult.duration = Date.now() - stepStart
  return stepResult
}

// ─── Authentication ─────────────────────────────────────────────────────────

async function authenticate(page, email, password, timeout) {
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
    console.log("    (no login form found, may already be authenticated)")
    return false
  }

  await emailInput.fill(email)
  await passwordInput.fill(password)
  if (submitBtn) await submitBtn.click()

  await page.waitForURL((url) => !url.pathname.includes("auth") && !url.pathname.includes("login"), {
    timeout: timeout || 10000,
  }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

  return true
}

// ─── Flow Executor ──────────────────────────────────────────────────────────

async function executeFlow(browser, flow, cfg) {
  const flowResult = {
    flow: flow.name,
    startRoute: flow.startRoute,
    status: "pending",
    stepsTotal: flow.steps.length,
    stepsPassed: 0,
    stepsFailed: 0,
    duration: 0,
    steps: [],
  }

  const flowStart = Date.now()

  // Fresh context per flow (clean cookies/state)
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  // Track console errors per step
  let consoleErrors = []
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })
  page.on("pageerror", (err) => {
    consoleErrors.push(err.message)
  })

  try {
    // Check if the flow itself contains login actions (fill email/password)
    const flowHasLogin = flow.steps.some(step =>
      (step.actions || []).some(a =>
        a.type === "fill" && (a.value === "$EMAIL" || a.value === "$PASSWORD" || /email|password/i.test(a.field || ""))
      )
    )

    // Navigate to app
    const startRoute = flow.startRoute || "/"
    const startUrl = new URL(startRoute, cfg.url).href
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: cfg.timeout })
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

    // Only auto-authenticate if the flow doesn't already handle login
    if (!flowHasLogin && cfg.email && cfg.password) {
      const didAuth = await authenticate(page, cfg.email, cfg.password, cfg.timeout)
      if (didAuth) console.log(`    Authenticated`)

      // Navigate to flow start route after auth if needed
      if (startRoute !== "/") {
        const currentPath = new URL(page.url()).pathname
        if (currentPath !== startRoute) {
          await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: cfg.timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
        }
      }
    }

    // Execute each step
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      consoleErrors = [] // reset per step

      console.log(`    Step ${step.stepNumber || i + 1}: ${step.description || "..."}`)

      const stepResult = await executeStep(page, step, cfg, consoleErrors, flow.name)

      // Screenshot
      const screenshotDir = path.join(cfg.outputDir, "screenshots")
      fs.mkdirSync(screenshotDir, { recursive: true })
      const safeName = flow.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const screenshotName = `e2e_${safeName}_step${step.stepNumber || i + 1}.png`
      const screenshotPath = path.join(screenshotDir, screenshotName)
      await page.screenshot({ path: screenshotPath, fullPage: stepResult.status === "failed" }).catch(() => {})
      stepResult.screenshot = screenshotPath

      flowResult.steps.push(stepResult)

      if (stepResult.status === "passed") {
        flowResult.stepsPassed++
        console.log(`    -> PASS (${(stepResult.duration / 1000).toFixed(2)}s)`)
      } else {
        flowResult.stepsFailed++
        console.log(`    -> FAIL (${(stepResult.duration / 1000).toFixed(2)}s)`)

        if (cfg.stopOnFail) {
          console.log(`    Stopping flow (--stop-on-fail)`)
          break
        }
      }
      console.log("")
    }

  } catch (err) {
    console.log(`    FLOW ERROR: ${err.message}`)
    flowResult.status = "failed"
    flowResult.error = err.message
  } finally {
    await context.close()
  }

  flowResult.duration = Date.now() - flowStart
  flowResult.status = flowResult.stepsFailed > 0 ? "failed" : "passed"

  return flowResult
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("")
  console.log("=".repeat(60))
  console.log("  QA Agent — E2E Replay Runner")
  console.log("")
  console.log(`  Flows file: ${config.flowsPath}`)
  console.log(`  URL: ${config.url}`)
  console.log(`  Flows: ${flows.length}`)
  console.log(`  Headless: ${config.headless}`)
  console.log(`  Slow Mo: ${config.slowMo}ms`)
  console.log(`  Step Delay: ${config.stepDelay}ms`)
  if (config.demo) console.log(`  Demo Mode: true`)
  if (config.flowFilter) console.log(`  Filter: --flow ${config.flowFilter}`)
  if (config.tagFilter) console.log(`  Filter: --tag ${config.tagFilter}`)
  console.log("=".repeat(60))
  console.log("")

  if (flows.length === 0) {
    console.log("No flows to run.")
    if (config.flowFilter) console.log(`  No flow matching "${config.flowFilter}"`)
    if (config.tagFilter) console.log(`  No flow with tag "${config.tagFilter}"`)
    process.exit(0)
  }

  // Setup output
  fs.mkdirSync(config.outputDir, { recursive: true })

  // Launch browser
  console.log("Launching browser...")
  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })

  const allResults = []
  const startTime = Date.now()

  try {
    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i]

      console.log(`\n[${ i + 1}/${flows.length}] Flow: "${flow.name}" (${flow.steps.length} steps)`)
      console.log(`  Start route: ${flow.startRoute || "/"}`)
      console.log("")

      const flowResult = await executeFlow(browser, flow, config)
      allResults.push(flowResult)

      const icon = flowResult.status === "passed" ? "PASS" : "FAIL"
      console.log(`  ${icon} "${flow.name}" — ${flowResult.stepsPassed}/${flowResult.stepsTotal} steps passed (${(flowResult.duration / 1000).toFixed(1)}s)`)

      if (flowResult.status === "failed" && config.stopOnFail) {
        console.log("\nStopping (--stop-on-fail)")
        break
      }
    }
  } finally {
    await browser.close()
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const totalDuration = Date.now() - startTime
  const flowsPassed = allResults.filter(r => r.status === "passed").length
  const flowsFailed = allResults.filter(r => r.status === "failed").length
  const totalSteps = allResults.reduce((sum, r) => sum + r.stepsTotal, 0)
  const stepsPassed = allResults.reduce((sum, r) => sum + r.stepsPassed, 0)

  console.log("")
  console.log("=".repeat(60))
  console.log("  E2E Results")
  console.log("=".repeat(60))
  console.log(`  Flows:      ${allResults.length} (${flowsPassed} passed, ${flowsFailed} failed)`)
  console.log(`  Steps:      ${totalSteps} (${stepsPassed} passed, ${totalSteps - stepsPassed} failed)`)
  console.log(`  Duration:   ${(totalDuration / 1000).toFixed(1)}s`)
  console.log("")

  // Selector health report
  console.log("  Selectors:")
  console.log(`    Total:    ${selectorHealth.total}`)
  console.log(`    Primary:  ${selectorHealth.primary} (original selector worked)`)
  console.log(`    Fallback: ${selectorHealth.fallback} (used fallback/text)`)
  console.log(`    Healed:   ${selectorHealth.healed} (fuzzy match found)`)
  console.log(`    Failed:   ${selectorHealth.failed} (nothing worked)`)

  if (selectorHealth.healedActions.length > 0) {
    console.log("")
    console.log("  Healed selectors:")
    for (const h of selectorHealth.healedActions) {
      console.log(`    "${h.flowName}" step ${h.stepNumber}:`)
      console.log(`      ${h.original} -> ${h.healed} [${h.method}]`)
    }
  }
  console.log("")

  if (flowsFailed > 0) {
    console.log("  Failed flows:")
    for (const r of allResults.filter(r => r.status === "failed")) {
      const failedSteps = r.steps.filter(s => s.status === "failed")
      console.log(`    - "${r.flow}": ${failedSteps.length} step(s) failed`)
      for (const s of failedSteps) {
        const detail = s.error || s.checks.filter(c => !c.passed).map(c => c.detail).join("; ")
        console.log(`      Step ${s.stepNumber}: ${detail}`)
      }
    }
    console.log("")
  }

  console.log("=".repeat(60))

  // ── Heal: write updated selectors back to flows file ────────────────────
  if (config.heal && selectorHealth.healedActions.length > 0) {
    const freshData = JSON.parse(fs.readFileSync(config.flowsPath, "utf8"))
    let healCount = 0

    for (const h of selectorHealth.healedActions) {
      const flow = freshData.flows.find(f => f.name === h.flowName)
      if (!flow) continue
      const step = flow.steps.find(s => s.stepNumber === h.stepNumber)
      if (!step || !step.actions || !step.actions[h.actionIndex]) continue

      const action = step.actions[h.actionIndex]
      // Demote old primary to fallback, promote healed to primary
      if (!action.selectorFallbacks) action.selectorFallbacks = []
      if (action.selector && !action.selectorFallbacks.includes(action.selector)) {
        action.selectorFallbacks.push(action.selector)
      }
      action.selector = h.healed
      action._healedAt = new Date().toISOString()
      action._healedFrom = h.original
      healCount++
    }

    if (healCount > 0) {
      freshData._lastHealed = new Date().toISOString()
      freshData._healCount = (freshData._healCount || 0) + healCount
      fs.writeFileSync(config.flowsPath, JSON.stringify(freshData, null, 2))
      console.log(`\n  Healed ${healCount} selector(s) in ${config.flowsPath}`)
    }
  } else if (selectorHealth.healedActions.length > 0 && !config.heal) {
    console.log(`\n  ${selectorHealth.healedActions.length} selector(s) could be healed. Run with --heal to update flows file.`)
  }

  // ── Save Results ──────────────────────────────────────────────────────────

  const summary = {
    url: config.url,
    flowsFile: config.flowsPath,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    duration: totalDuration,
    flows: allResults,
    summary: {
      flowsTotal: allResults.length,
      flowsPassed,
      flowsFailed,
      stepsTotal: totalSteps,
      stepsPassed,
      stepsFailed: totalSteps - stepsPassed,
    },
    selectorHealth: { ...selectorHealth },
  }

  fs.writeFileSync(path.join(config.outputDir, "e2e-summary.json"), JSON.stringify(summary, null, 2))
  generateE2eReport(summary, config.outputDir)

  console.log(`\nResults: ${config.outputDir}/e2e-summary.json`)
  console.log(`Report:  ${config.outputDir}/e2e-report.html`)

  process.exit(flowsFailed > 0 ? 1 : 0)
}

// ─── HTML Report ────────────────────────────────────────────────────────────

function generateE2eReport(data, outputDir) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>E2E Replay Report</title>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { border-bottom: 3px solid #8b5cf6; padding-bottom: 24px; margin-bottom: 32px; }
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
    .flow { margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; }
    .flow-header { padding: 16px 20px; background: #f8f9fa; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
    .flow-header.passed { border-left: 4px solid #10b981; }
    .flow-header.failed { border-left: 4px solid #ef4444; }
    .flow-name { font-weight: 700; font-size: 16px; }
    .flow-meta { color: #6b7280; font-size: 13px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .badge.passed { background: #d1fae5; color: #065f46; }
    .badge.failed { background: #fee2e2; color: #991b1b; }
    .step { padding: 12px 20px; border-bottom: 1px solid #f0f0f0; }
    .step:last-child { border-bottom: none; }
    .step-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .step-name { font-weight: 600; font-size: 14px; }
    .step-duration { color: #6b7280; font-size: 12px; }
    .actions { margin: 6px 0; padding-left: 16px; }
    .action { font-size: 13px; color: #374151; padding: 2px 0; font-family: monospace; }
    .checks { margin: 6px 0; padding-left: 16px; }
    .check { font-size: 13px; padding: 2px 0; }
    .check.pass { color: #059669; }
    .check.fail { color: #dc2626; }
    .error { padding: 8px 12px; background: #fef2f2; border-radius: 4px; color: #991b1b; font-size: 13px; margin-top: 6px; }
    .screenshot-link { display: inline-block; margin-top: 6px; padding: 3px 8px; background: #e0e7ff; color: #3730a3; border-radius: 4px; font-size: 12px; text-decoration: none; }
    .action.healed { color: #d97706; }
    .action .heal-tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; margin-left: 6px; }
    .heal-tag.fallback { background: #fef3c7; color: #92400e; }
    .heal-tag.healed { background: #fce7f3; color: #9d174d; }
    .heal-tag.text { background: #e0e7ff; color: #3730a3; }
    .selector-health { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .sh-card { padding: 14px; border-radius: 8px; background: #f8f9fa; border: 1px solid #e2e8f0; text-align: center; }
    .sh-card .sh-val { font-size: 24px; font-weight: 700; }
    .sh-card .sh-label { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .sh-card.primary .sh-val { color: #059669; }
    .sh-card.fallback .sh-val { color: #d97706; }
    .sh-card.healed .sh-val { color: #db2777; }
    .sh-card.failed .sh-val { color: #dc2626; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>E2E Replay Report</h1>
    <p><strong>URL:</strong> ${data.url} | <strong>Flows:</strong> ${data.summary.flowsTotal}</p>
    <p><strong>Run:</strong> ${data.startTime} — ${data.endTime}</p>
  </div>

  <div class="summary">
    <div class="card total"><h3>Flows</h3><div class="value">${data.summary.flowsTotal}</div></div>
    <div class="card passed"><h3>Passed</h3><div class="value">${data.summary.flowsPassed}</div></div>
    <div class="card failed"><h3>Failed</h3><div class="value">${data.summary.flowsFailed}</div></div>
    <div class="card duration"><h3>Duration</h3><div class="value">${(data.duration / 1000).toFixed(1)}s</div></div>
  </div>

  ${data.selectorHealth ? `
  <h2>Selector Health</h2>
  <div class="selector-health">
    <div class="sh-card primary"><div class="sh-val">${data.selectorHealth.primary}</div><div class="sh-label">Primary OK</div></div>
    <div class="sh-card fallback"><div class="sh-val">${data.selectorHealth.fallback}</div><div class="sh-label">Used Fallback</div></div>
    <div class="sh-card healed"><div class="sh-val">${data.selectorHealth.healed}</div><div class="sh-label">Auto-Healed</div></div>
    <div class="sh-card failed"><div class="sh-val">${data.selectorHealth.failed}</div><div class="sh-label">Failed</div></div>
  </div>
  ` : ""}

  <h2>Flows</h2>

  ${data.flows.map(flow => `
  <div class="flow">
    <div class="flow-header ${flow.status}">
      <div>
        <span class="flow-name">${flow.flow}</span>
        <span class="flow-meta"> — ${flow.stepsPassed}/${flow.stepsTotal} steps, ${(flow.duration / 1000).toFixed(1)}s</span>
      </div>
      <span class="badge ${flow.status}">${flow.status}</span>
    </div>
    ${flow.steps.map(step => `
    <div class="step">
      <div class="step-header">
        <span class="step-name">Step ${step.stepNumber}: ${step.description}</span>
        <span>
          <span class="badge ${step.status}">${step.status}</span>
          <span class="step-duration">${(step.duration / 1000).toFixed(2)}s</span>
        </span>
      </div>
      ${step.actionsExecuted.length > 0 ? `
      <div class="actions">
        ${step.actionsExecuted.map(a => {
          const val = a.value ? ` "${a.value}"` : ""
          const key = a.key ? ` ${a.key}` : ""
          const m = a.selectorMethod || "primary"
          const isHealed = m !== "primary" && m !== "n/a"
          const healTag = isHealed ? `<span class="heal-tag ${m}">${m}</span>` : ""
          return `<div class="action${isHealed ? " healed" : ""}">${a.status === "ok" ? "✓" : "✗"} ${a.action} ${a.selector || ""}${val}${key}${healTag}</div>`
        }).join("")}
      </div>` : ""}
      ${step.checks.length > 0 ? `
      <div class="checks">
        ${step.checks.map(c => `<div class="check ${c.passed ? "pass" : "fail"}">${c.passed ? "PASS" : "FAIL"} [${c.type}] ${c.detail}</div>`).join("")}
      </div>` : ""}
      ${step.error ? `<div class="error">${step.error}</div>` : ""}
      ${step.screenshot ? `<a class="screenshot-link" href="${path.relative(outputDir, step.screenshot)}" target="_blank">Screenshot</a>` : ""}
    </div>`).join("")}
  </div>`).join("")}

  <div style="margin-top:32px;text-align:center;color:#6b7280;font-size:13px">Generated by QA Agent — E2E Replay</div>
</div>
</body>
</html>`

  fs.writeFileSync(path.join(outputDir, "e2e-report.html"), html)
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err.message)
  process.exit(1)
})
