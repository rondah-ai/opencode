const fs = require("fs")

const DEFAULT_BOOTSTRAP_FILE = "./QA_INIT_BOOTSTRAP.json"
const BOOTSTRAP_STEP_DELAY_MS = 700

function getBootstrapFile(config = {}) {
  return config.bootstrapFile || DEFAULT_BOOTSTRAP_FILE
}

function shouldUseBootstrap(config = {}) {
  if (config.noBootstrap) return false
  if (config.useBootstrap) return true
  return fs.existsSync(getBootstrapFile(config))
}

function loadBootstrap(config = {}) {
  const bootstrapFile = getBootstrapFile(config)
  if (!fs.existsSync(bootstrapFile)) {
    throw new Error(`Bootstrap file not found: ${bootstrapFile}`)
  }
  return JSON.parse(fs.readFileSync(bootstrapFile, "utf8"))
}

async function replayBootstrap(page, bootstrap, config = {}) {
  const baseUrl = bootstrap.baseUrl || config.url
  const timeout = config.timeout || 10000

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout })
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(BOOTSTRAP_STEP_DELAY_MS)
  logBootstrap(config, `page ready at ${page.url()}`)

  const steps = bootstrap.steps || []

  // Steps after the first navigation are post-login setup (dismiss prompts, select org).
  // These may not always appear, so failures after navigation are non-fatal.
  let passedNavigation = false

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const label = describeBootstrapStep(step)

    if (step.type === "submit" && i > 0 && steps[i - 1].type === "click") {
      logBootstrap(config, `[${i + 1}/${steps.length}] skip redundant ${label}`)
      continue
    }

    // Skip click-before-fill — the fill action will focus the input
    if (step.type === "click" && i + 1 < steps.length && steps[i + 1].type === "input" &&
        step.selector && steps[i + 1].selector && step.selector === steps[i + 1].selector) {
      logBootstrap(config, `[${i + 1}/${steps.length}] skip click-before-fill ${label}`)
      continue
    }

    if (step.type === "navigation") {
      logBootstrap(config, `[${i + 1}/${steps.length}] ${label}`)
      await page.goto(resolveBootstrapUrl(step.url, baseUrl), { waitUntil: "domcontentloaded", timeout })
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(BOOTSTRAP_STEP_DELAY_MS)
      passedNavigation = true
      continue
    }

    try {
      if (step.type === "click") {
        const target = await resolveBootstrapTarget(page, step)
        logBootstrap(config, `[${i + 1}/${steps.length}] ${label}`)
        await target.click({ timeout: 10000 })
      } else if (step.type === "input") {
        const value = resolveBootstrapValue(step.value, config)
        const target = await resolveBootstrapTarget(page, step)
        logBootstrap(config, `[${i + 1}/${steps.length}] ${label}`)
        await target.fill(value, { timeout: 10000 })
      } else if (step.type === "select") {
        const value = resolveBootstrapValue(step.value, config)
        const target = await resolveBootstrapTarget(page, step)
        logBootstrap(config, `[${i + 1}/${steps.length}] ${label}`)
        await target.selectOption(value, { timeout: 10000 })
      } else if (step.type === "submit") {
        const target = await resolveBootstrapTarget(page, step)
        logBootstrap(config, `[${i + 1}/${steps.length}] ${label}`)
        await target.evaluate((form) => form.requestSubmit?.())
      } else {
        logBootstrap(config, `[${i + 1}/${steps.length}] unsupported step type: ${step.type}`)
      }
    } catch (err) {
      logBootstrap(config, `[${i + 1}/${steps.length}] FAILED ${label} -> ${err.message}`)
      // Pre-navigation steps (auth) are critical — post-navigation steps (setup) are best-effort
      if (!passedNavigation) {
        throw err
      }
      logBootstrap(config, `[${i + 1}/${steps.length}] (non-fatal, continuing)`)
    }

    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(BOOTSTRAP_STEP_DELAY_MS)
  }

  if (bootstrap.finalRoute) {
    await page.waitForURL((url) => url.pathname === bootstrap.finalRoute, { timeout: 10000 }).catch(() => {})
  }
  if (bootstrap.finalLandmark?.selector && bootstrap.finalLandmark?.text) {
    const locator = page.locator(bootstrap.finalLandmark.selector).first()
    await locator.waitFor({ timeout: 5000 }).catch(() => {})
  }

  logBootstrap(config, `final route: ${new URL(page.url()).pathname}`)
}

function resolveBootstrapUrl(url, baseUrl) {
  if (!url) return baseUrl
  if (url.startsWith("http://") || url.startsWith("https://")) return url
  return new URL(url, baseUrl).href
}

function resolveBootstrapValue(value, config = {}) {
  if (value === "$EMAIL") return config.email || ""
  if (value === "$PASSWORD") return config.password || ""
  return value || ""
}

async function resolveBootstrapTarget(page, step) {
  const candidates = []

  if (step.selector) {
    candidates.push(page.locator(step.selector).first())
  }

  if (step.text && step.type === "click") {
    const escaped = step.text.replace(/["\\]/g, "\\$&")
    candidates.push(page.locator(`button:has-text("${escaped}")`).first())
    candidates.push(page.locator(`a:has-text("${escaped}")`).first())
    candidates.push(page.getByText(step.text, { exact: false }).first())
  }

  for (const locator of candidates) {
    const visible = await locator.isVisible().catch(() => false)
    if (visible) return locator
    const found = await locator.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)
    if (found) return locator
  }

  return candidates[0] || page.locator("body")
}

function describeBootstrapStep(step) {
  if (step.type === "navigation") return `navigate ${step.url || ""}`
  if (step.type === "input") return `fill ${step.selector || ""}`
  if (step.type === "select") return `select ${step.selector || ""}`
  if (step.type === "submit") return `submit ${step.selector || ""}`
  if (step.type === "click") {
    if (step.text) return `click "${step.text}"`
    return `click ${step.selector || ""}`
  }
  return `${step.type} ${step.selector || ""}`.trim()
}

function logBootstrap(config, message) {
  if (config && config.quietBootstrap) return
  console.log(`  bootstrap: ${message}`)
}

module.exports = {
  DEFAULT_BOOTSTRAP_FILE,
  getBootstrapFile,
  shouldUseBootstrap,
  loadBootstrap,
  replayBootstrap,
}
