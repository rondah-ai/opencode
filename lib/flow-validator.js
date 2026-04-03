// lib/flow-validator.js
//
// Replays a recorded flow in a headless browser to validate it works.
// Stops on first structural failure. Returns actionable issues and fixes.

const { capturePageState, hasBlockingOverlay, dismissBlockingOverlays } = require("./page-state")
const { shouldUseBootstrap, loadBootstrap, replayBootstrap } = require("./bootstrap")

async function validateFlow(flow, config, executeActionFn, authenticateFn) {
  const { chromium } = require("playwright")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()

  const result = {
    flow: flow.name,
    valid: true,
    issues: [],
    fixes: [],
    steps: [],
  }

  try {
    if (shouldUseBootstrap(config)) {
      const bootstrap = loadBootstrap(config)
      await replayBootstrap(page, bootstrap, config)
    } else {
      await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeout })
    }

    if (!shouldUseBootstrap(config) && authenticateFn && config.email && config.password) {
      await authenticateFn(page, config.email, config.password, config.timeout)
    }

    if (flow.startRoute) {
      const startUrl = new URL(flow.startRoute, config.url).href
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: config.timeout })
    }

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      const stepResult = { stepNumber: step.stepNumber || i + 1, status: "passed", actions: [] }

      // Check for blocking overlay BEFORE step
      const preState = await capturePageState(page)
      if (hasBlockingOverlay(preState)) {
        result.valid = false
        result.issues.push({
          type: "OVERLAY_BLOCKING",
          step: stepResult.stepNumber,
          detail: "Blocking UI left open from previous step",
        })
        result.fixes.push({
          type: "INSERT_DISMISS",
          beforeStep: stepResult.stepNumber,
          action: { type: "press", key: "Escape", _autoInserted: true },
        })
        await dismissBlockingOverlays(page)
      }

      // Execute each action
      for (const action of step.actions || []) {
        try {
          await executeActionFn(page, action, config)
          stepResult.actions.push({ type: action.type, selector: action.selector, status: "ok" })
        } catch (err) {
          stepResult.status = "failed"
          stepResult.actions.push({ type: action.type, selector: action.selector, status: "failed", error: err.message })
          result.valid = false
          result.issues.push({
            type: err.message.includes("intercepts pointer events") ? "OVERLAY_BLOCKING" : "ACTION_FAILED",
            step: stepResult.stepNumber,
            detail: `${action.type} ${action.selector || ""} failed: ${err.message}`,
          })
          break
        }
      }

      result.steps.push(stepResult)
      if (stepResult.status === "failed") break
    }
  } catch (err) {
    result.valid = false
    result.issues.push({ type: "SETUP_FAILED", step: 0, detail: err.message })
  } finally {
    await browser.close()
  }

  return result
}

/**
 * Applies auto-fixes to a flow (e.g., inserting dismiss actions).
 * Returns a new flow object — does not mutate the original.
 */
function applyFixes(flow, fixes) {
  const fixed = JSON.parse(JSON.stringify(flow))
  const sorted = [...fixes].sort((a, b) => b.beforeStep - a.beforeStep)

  for (const fix of sorted) {
    if (fix.type !== "INSERT_DISMISS") continue
    const step = fixed.steps[fix.beforeStep - 1]
    if (!step) continue
    step.actions.unshift(fix.action)
    step.description = `[auto-dismiss] ${step.description}`
  }

  return fixed
}

module.exports = { validateFlow, applyFixes }
