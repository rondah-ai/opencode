#!/usr/bin/env node

/**
 * qa-agent init — Generate feature model from live app
 *
 * Scans every page, recognizes patterns, drafts QA_FEATURE_MODEL.json
 * and QA_INSTRUCTIONS.json using deterministic pattern→capability mapping.
 *
 * Usage:
 *   npx qa-agent init --url https://app.example.com --email test@x.com --password pass123
 *   npx qa-agent init --url https://app.example.com --instructions  (instructions only)
 *   npx qa-agent init --url https://app.example.com --max-pages 30
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { chromium } = require("playwright")
const { getBootstrapFile, shouldUseBootstrap, loadBootstrap, replayBootstrap } = require("../lib/bootstrap")

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
  url: getArg("--url") || process.env.QA_PREVIEW_URL,
  email: getArg("--email") || process.env.TEST_EMAIL,
  password: getArg("--password") || process.env.TEST_PASSWORD,
  maxPages: parseInt(getArg("--max-pages") || "20", 10),
  outputDir: getArg("--output-dir") || ".",
  excludeRoutes: (getArg("--exclude") || "").split(",").filter(Boolean),
  instructionsOnly: hasFlag("--instructions"),
  timeout: parseInt(getArg("--timeout") || "30000", 10),
  headless: !hasFlag("--no-headless") && getArg("--headless") !== "false",
  recordBootstrap: hasFlag("--record-bootstrap"),
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
  console.error("Use `npm run init -- --url http://localhost:3000 --email test@x.com --password secret`.")
  console.error("Received positional args:", unexpectedPositionals.join(" "))
  process.exit(1)
}

if (!config.url) {
  console.error("Error: --url is required (or set QA_PREVIEW_URL env variable)")
  console.error("")
  console.error("Usage:")
  console.error("  npx qa-agent init --url https://app.example.com --email test@x.com --password pass123")
  process.exit(1)
}

console.log("QA Agent — Init")
console.log("=".repeat(50))
console.log(`URL:        ${config.url}`)
console.log(`Max pages:  ${config.maxPages}`)
console.log(`Auth:       ${config.email ? "yes" : "no"}`)
console.log(`Output:     ${path.resolve(config.outputDir)}`)
if (config.recordBootstrap) console.log(`Bootstrap:  recording -> ${path.resolve(config.bootstrapFile)}`)
if (!config.recordBootstrap && shouldUseBootstrap(config)) console.log(`Bootstrap:  using ${path.resolve(config.bootstrapFile)}`)
console.log("=".repeat(50))
console.log("")

const TRACKER_SCRIPT = `
(() => {
  if (window.__qaBootstrapTracker) return;
  window.__qaBootstrapTracker = {
    events: [],
    init() {
      document.addEventListener('click', (e) => {
        const target = e.target.closest('button, a, input, select, textarea, li, [role="button"], [role="tab"], [role="menuitem"], [role="combobox"], [role="option"], [data-value], [cmdk-item]');
        if (!target) return;
        this.events.push({
          type: 'click',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          text: (target.textContent || '').trim().slice(0, 100),
          url: window.location.href,
        });
      }, { capture: true });
      document.addEventListener('input', (e) => {
        const target = e.target;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        this.events.push({
          type: 'input',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          value: target.type === 'password' ? '***' : target.value,
          field: target.placeholder || target.name || target.id || target.getAttribute('aria-label') || 'unknown',
          url: window.location.href,
        });
      }, { capture: true });
      document.addEventListener('change', (e) => {
        const target = e.target;
        if (target.tagName !== 'SELECT') return;
        this.events.push({
          type: 'select',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          value: target.value,
          text: target.options[target.selectedIndex] ? target.options[target.selectedIndex].textContent.trim() : target.value,
          url: window.location.href,
        });
      }, { capture: true });
      document.addEventListener('submit', (e) => {
        this.events.push({
          type: 'submit',
          timestamp: Date.now(),
          selector: this.getSelector(e.target),
          url: window.location.href,
        });
      }, { capture: true });
      const orig = history.pushState;
      const tracker = this;
      history.pushState = function() {
        orig.apply(this, arguments);
        tracker.events.push({ type: 'navigation', timestamp: Date.now(), selector: '', url: window.location.href });
      };
      window.addEventListener('popstate', () => {
        tracker.events.push({ type: 'navigation', timestamp: Date.now(), selector: '', url: window.location.href });
      });
    },
    flush() {
      const events = [...this.events];
      this.events = [];
      return events;
    },
    getSelector(el) {
      if (!el) return '';
      if (el.id && !el.id.match(/^(:|react|ember|vue|radix|rc-|headlessui|downshift|mui)/)) return '#' + el.id;
      const testId = el.getAttribute && el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      const dataValue = el.getAttribute && el.getAttribute('data-value');
      if (dataValue) return '[data-value="' + dataValue + '"]';
      if (el.getAttribute && el.getAttribute('aria-label')) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
      if (el.getAttribute && el.getAttribute('role') === 'option') {
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
        if (text) return '[role="option"]:has-text("' + text.replace(/"/g, '\\"') + '")';
      }
      if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
      if (el.type) return el.tagName.toLowerCase() + '[type="' + el.type + '"]';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      if (text && ['button', 'a'].includes(el.tagName.toLowerCase())) return el.tagName.toLowerCase() + ':has-text("' + text.replace(/"/g, '\\"') + '")';
      return el.tagName.toLowerCase();
    }
  };
  window.__qaBootstrapTracker.init();
})();
`

// ─── Pattern Recognition (inline — mirrors qa/patterns.ts) ──────────────────

const UI_PATTERN_SIGNALS = {
  auth_form: {
    signals: [
      "input[type='email'], input[name='email'], input[type='text'][name*='user']",
      "input[type='password']",
      "button[type='submit'], input[type='submit']",
    ],
    minMatch: 2,
  },
  data_table: {
    signals: [
      "table, [role='grid']",
      "thead th, [role='columnheader']",
      "tbody tr, [role='row']",
    ],
    minMatch: 2,
  },
  nav_sidebar: {
    signals: [
      "nav a[href], [role='navigation'] a[href]",
      "aside nav, aside [role='navigation']",
      "[role='navigation'], nav",
    ],
    minMatch: 2,
  },
  crud_page: {
    signals: [
      "button:has-text('Add'), button:has-text('Create'), button:has-text('New')",
      "table, [role='grid']",
      "button[aria-label='Edit'], button:has-text('Edit'), a:has-text('Edit')",
    ],
    minMatch: 2,
  },
  form_generic: {
    signals: [
      "form",
      "label",
      "input:not([type='hidden']), select, textarea",
      "button[type='submit'], input[type='submit']",
    ],
    minMatch: 3,
  },
  search_filter: {
    signals: [
      "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i]",
      "button:has-text('Search'), button:has-text('Filter'), button:has-text('Apply')",
    ],
    minMatch: 1,
  },
  modal_dialog: {
    signals: [
      "[role='dialog'], dialog",
      "[aria-modal='true']",
      "[class*='modal'], [class*='dialog']",
    ],
    minMatch: 1,
  },
  toast_notification: {
    signals: [
      "[role='alert']",
      "[role='status']",
      "[aria-live='polite'], [aria-live='assertive']",
    ],
    minMatch: 1,
  },
}

// ─── Pattern → Capability Mapping ────────────────────────────────────────────

const PATTERN_CAPABILITY_MAP = {
  auth_form: {
    login: {
      interaction: "fill email and password fields, click submit",
      expected: ["redirect away from login page", "navigation or dashboard visible"],
      verify: {
        redirected: { type: "url_changed" },
        no_errors: { type: "no_errors" },
      },
    },
  },
  data_table: {
    view_list: {
      interaction: "navigate to page",
      expected: ["page loads without errors"],
      verify: {
        no_errors: { type: "no_errors" },
      },
    },
  },
  crud_page: {
    view_list: {
      interaction: "navigate to page",
      expected: ["page loads without errors"],
      verify: {
        no_errors: { type: "no_errors" },
      },
    },
  },
}

const STRUCTURAL_PATTERNS = new Set(["nav_sidebar", "modal_dialog", "toast_notification"])

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let browser

  try {
    // Launch browser
    browser = await chromium.launch({ headless: config.recordBootstrap ? false : config.headless })

    const hasCreds = config.email && config.password
    const origin = new URL(config.url).origin
    let authRoute = null
    let preAuthModel = {}
    let postAuthModel = {}
    let stepNum = 1

    // ── Bootstrap recording (separate context — discarded after recording) ──
    if (config.recordBootstrap) {
      const recordCtx = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
      })
      const recordPage = await recordCtx.newPage()

      console.log(`Step ${stepNum}: Recording bootstrap setup...`)
      const bootstrap = await recordBootstrap(recordPage, config.url)
      saveBootstrap(bootstrap)
      console.log(`  Saved: ${path.resolve(config.bootstrapFile)}`)
      console.log("")
      stepNum++

      // Close recording context entirely — its auth state must not leak into replay
      await recordPage.close()
      await recordCtx.close()
    }

    // ── Fresh context for scanning (and bootstrap replay if needed) ──
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()

    // Collect console errors per page
    const consoleErrors = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push({ type: "error", text: msg.text(), url: page.url() })
      }
    })
    page.on("pageerror", (err) => {
      consoleErrors.push({ type: "pageerror", text: err.message, url: page.url() })
    })

    if (shouldUseBootstrap(config)) {
      console.log(`Step ${stepNum}: Replaying bootstrap setup...`)
      const bootstrap = loadBootstrap(config)
      await replayBootstrap(page, bootstrap, config)
      console.log(`  Ready at: ${new URL(page.url()).pathname}`)
      console.log("")
      stepNum++
    }

    const bootstrapLandedAuthenticated = shouldUseBootstrap(config) && !/(auth|login|sign-in)/i.test(new URL(page.url()).pathname)

    // ── Phase A: Pre-auth crawl (shallow if creds provided) ──
    const preAuthMaxPages = hasCreds && !bootstrapLandedAuthenticated ? Math.min(config.maxPages, 10) : config.maxPages
    const preAuthMaxDepth = hasCreds && !bootstrapLandedAuthenticated ? 3 : Infinity
    console.log(`Step ${stepNum}: Scanning ${hasCreds && !bootstrapLandedAuthenticated ? "public" : ""} pages...`)
    const crawlStartUrl = shouldUseBootstrap(config) ? page.url() : config.url
    const preAuthResult = await crawlPages(page, [crawlStartUrl], origin, {
      maxPages: preAuthMaxPages,
      maxDepth: preAuthMaxDepth,
      timeout: config.timeout,
      excludeRoutes: config.excludeRoutes,
      consoleErrors,
    })
    preAuthModel = preAuthResult.siteModel
    console.log(`\n  Scanned ${Object.keys(preAuthModel).length} ${hasCreds && !bootstrapLandedAuthenticated ? "public " : ""}pages`)
    stepNum++

    if (hasCreds && bootstrapLandedAuthenticated) {
      console.log(`\nStep ${stepNum}: Bootstrap provided authenticated context...`)
      console.log(`  Continuing from: ${new URL(page.url()).pathname}`)
      stepNum++
    } else if (hasCreds) {
      // ── Phase B: Find login page ──
      console.log(`\nStep ${stepNum}: Finding login page...`)
      const loginPage = await findLoginPage(preAuthModel, page, origin, config.timeout)
      stepNum++

      if (loginPage) {
        console.log(`  Found login page: ${loginPage.route} (via ${loginPage.source})`)

        // ── Phase C: Authenticate ──
        console.log("  Authenticating...")
        authRoute = await authenticate(page, loginPage.url, config.email, config.password, config.timeout)

        if (authRoute) {
          const postLoginPath = new URL(page.url()).pathname
          console.log(`  Authenticated. Now on: ${postLoginPath}`)

          // ── Phase D: Post-auth crawl (full) ──
          console.log(`\nStep ${stepNum}: Scanning authenticated pages...`)
          const postAuthResult = await crawlPages(page, [page.url()], origin, {
            maxPages: config.maxPages,
            maxDepth: Infinity,
            timeout: config.timeout,
            excludeRoutes: config.excludeRoutes,
            consoleErrors,
            visited: preAuthResult.visited,
          })
          postAuthModel = postAuthResult.siteModel
          console.log(`\n  Scanned ${Object.keys(postAuthModel).length} authenticated pages`)
          stepNum++
        } else {
          console.log("  Warning: Authentication failed. Continuing with public pages only.")
        }
      } else {
        console.log("  Warning: No login page found. Continuing with public pages only.")
      }
    }

    // ── Phase E: Merge ──
    const siteModel = { ...preAuthModel }
    for (const [route, scan] of Object.entries(postAuthModel)) {
      if (!siteModel[route]) {
        siteModel[route] = { ...scan, requiresAuth: true }
      }
    }

    const publicCount = Object.keys(preAuthModel).length
    const authCount = Object.keys(postAuthModel).length
    if (hasCreds && authCount > 0) {
      console.log(`\n  Total: ${Object.keys(siteModel).length} pages (${publicCount} public, ${authCount} authenticated)`)
    }

    // Summarize patterns
    const patternCounts = {}
    for (const scan of Object.values(siteModel)) {
      for (const p of scan.patterns) {
        patternCounts[p.type] = (patternCounts[p.type] || 0) + 1
      }
    }
    console.log(
      `  Patterns recognized: ${Object.entries(patternCounts)
        .map(([t, c]) => `${t}${c > 1 ? ` (x${c})` : ""}`)
        .join(", ")}`
    )
    console.log("")

    // Generate feature model
    if (!config.instructionsOnly) {
      console.log(`\nStep ${stepNum}: Generating feature model...`)
      stepNum++
      const featureModel = generateFeatureModel(siteModel, {
        authRoute,
        excludeRoutes: config.excludeRoutes,
      })

      const modelPath = path.join(config.outputDir, "QA_FEATURE_MODEL.json")
      fs.writeFileSync(modelPath, JSON.stringify(featureModel, null, 2))
      console.log(`  Generated: ${modelPath}`)

      // Print summary
      const featureNames = Object.keys(featureModel.features)
      let totalCaps = 0
      let todoCount = 0
      console.log("")
      console.log("  Feature model summary:")
      for (const name of featureNames) {
        const feat = featureModel.features[name]
        const capNames = Object.keys(feat.capabilities)
        totalCaps += capNames.length
        // Count TODOs
        for (const cap of Object.values(feat.capabilities)) {
          if (cap.test_data) {
            for (const v of Object.values(cap.test_data)) {
              if (v === "TODO") todoCount++
            }
          }
        }
        const patternHint = Object.values(siteModel)
          .find((s) => s.route === feat.route)
          ?.patterns.map((p) => p.type)
          .filter((t) => !STRUCTURAL_PATTERNS.has(t))
          .join(" + ") || ""
        const padding = " ".repeat(Math.max(0, 22 - name.length))
        console.log(
          `    ${name}${padding}-- ${capNames.length} capabilities (${capNames.join(", ")})${patternHint ? `  [${patternHint}]` : ""}`
        )
      }
      console.log("")
      console.log(`  Total: ${featureNames.length} features, ${totalCaps} capabilities`)
      console.log("")

      console.log("  Quality: SKELETON")
      console.log("    [x] All pages discovered")
      console.log("    [x] Patterns recognized")
      console.log("    [ ] Interactions are guesses (not observed)")
      console.log("    [ ] Verify checks are generic defaults")
      if (todoCount > 0) console.log(`    [ ] ${todoCount} test_data fields need real values (search for "TODO")`)
      console.log("    [ ] No cleanup steps verified")
      console.log("    [ ] No edge cases")
      console.log("")
    }

    // Generate instructions
    console.log(`Step ${stepNum}: Generating instructions...`)
    const instructions = generateInstructions(siteModel, {
      excludeRoutes: config.excludeRoutes,
      hasAuth: !!authRoute,
    })

    const instructionsPath = path.join(config.outputDir, "QA_INSTRUCTIONS.json")
    fs.writeFileSync(instructionsPath, JSON.stringify(instructions, null, 2))
    console.log(`  Generated: ${instructionsPath}`)

    // Print auto-detected findings
    const findings = []
    if (Object.keys(instructions.global.customSelectors).length > 0)
      findings.push(`${Object.keys(instructions.global.customSelectors).length} custom selector override(s)`)
    if (instructions.scope.exclude_routes.length > 0)
      findings.push(`${instructions.scope.exclude_routes.length} excluded route pattern(s)`)
    if (instructions.known_issues.length > 0)
      findings.push(`${instructions.known_issues.length} known issue(s)`)
    if (instructions.timing.page_load_buffer > 1000)
      findings.push("slow transitions detected")
    if (findings.length > 0) {
      console.log("")
      console.log("  Auto-detected:")
      for (const f of findings) console.log(`    - ${f}`)
    }

    // Next steps
    console.log("")
    console.log("=".repeat(50))
    console.log("Next steps:")
    if (!config.instructionsOnly) {
      console.log('  1. Open QA_FEATURE_MODEL.json and review')
      console.log('  2. Fill in TODO test data values')
      console.log("  3. Run: npx qa-agent learn --url $URL (to improve with observations)")
    } else {
      console.log("  1. Review QA_INSTRUCTIONS.json")
      console.log("  2. Add any known issues from your bug tracker")
      console.log("  3. Add agent_hints for any interaction quirks")
    }

  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  } finally {
    if (browser) await browser.close()
  }
}

function saveBootstrap(bootstrap) {
  fs.writeFileSync(config.bootstrapFile, JSON.stringify(bootstrap, null, 2))
}

async function recordBootstrap(page, startUrl) {
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: config.timeout })
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
  await page.addInitScript(TRACKER_SCRIPT)
  await page.evaluate(TRACKER_SCRIPT).catch(() => {})

  readline.emitKeypressEvents(process.stdin)
  const wasRaw = !!process.stdin.isRaw
  if (process.stdin.isTTY && !wasRaw) process.stdin.setRawMode(true)
  let done = false
  let eventCount = 0

  console.log("  Perform any required setup now in the browser.")
  console.log("  Examples: sign in, select practice, choose org, dismiss onboarding.")
  console.log("  Press [d] when the app is ready for scanning. Press [Ctrl+C] to cancel.\n")

  const recordedEvents = []
  const pollTimer = setInterval(async () => {
    try {
      const events = await page.evaluate(() => {
        if (!window.__qaBootstrapTracker) return []
        return window.__qaBootstrapTracker.flush()
      })
      if (Array.isArray(events) && events.length > 0) {
        recordedEvents.push(...events)
        eventCount += events.length
        process.stdout.write(`  Recorded ${eventCount} bootstrap events...\r`)
      }
    } catch { /* page navigating */ }
  }, 400)

  await new Promise((resolve, reject) => {
    const onKeypress = (_str, key) => {
      if (key?.sequence?.toLowerCase() === "d") {
        done = true
        process.stdin.off("keypress", onKeypress)
        resolve()
        return
      }
      if (key?.ctrl && key?.name === "c") {
        process.stdin.off("keypress", onKeypress)
        reject(new Error("Bootstrap recording cancelled"))
      }
    }

    process.stdin.on("keypress", onKeypress)
  })

  clearInterval(pollTimer)
  process.stdout.write("\n")
  if (process.stdin.isTTY && !wasRaw) process.stdin.setRawMode(false)

  if (!done) {
    throw new Error("Bootstrap recording did not complete")
  }

  try {
    const finalEvents = await page.evaluate(() => {
      if (!window.__qaBootstrapTracker) return []
      return window.__qaBootstrapTracker.flush()
    })
    if (Array.isArray(finalEvents) && finalEvents.length > 0) recordedEvents.push(...finalEvents)
  } catch { /* ignore */ }

  const finalUrl = page.url()
  const finalRoute = new URL(finalUrl).pathname
  const finalLandmark = await detectBootstrapLandmark(page)

  return {
    version: "1.0",
    baseUrl: config.url,
    createdAt: new Date().toISOString(),
    finalUrl,
    finalRoute,
    finalLandmark,
    steps: compressBootstrapEvents(recordedEvents),
  }
}


function compressBootstrapEvents(events) {
  const steps = []

  for (const event of events) {
    if (!event || !event.type) continue
    if (event.type === "navigation") {
      if (steps.length === 0 || steps[steps.length - 1].type !== "navigation" || steps[steps.length - 1].url !== event.url) {
        steps.push({ type: "navigation", url: event.url })
      }
      continue
    }

    if (event.type === "input" || event.type === "select") {
      const value = parameterizeBootstrapValue(event.value)
      const last = steps[steps.length - 1]
      if (last && last.type === event.type && last.selector === event.selector) {
        last.value = value
      } else {
        steps.push({ type: event.type, selector: event.selector, value, field: event.field || undefined })
      }
      continue
    }

    if (event.type === "click" || event.type === "submit") {
      if (event.type === "submit" && steps.length > 0 && steps[steps.length - 1].type === "click") {
        continue
      }
      steps.push({ type: event.type, selector: event.selector, text: event.text || undefined })
    }
  }

  return steps
}

function parameterizeBootstrapValue(value) {
  if (config.email && value === config.email) return "$EMAIL"
  if (config.password && value === "***") return "$PASSWORD"
  return value
}

async function detectBootstrapLandmark(page) {
  const heading = await page.locator("h1:visible").first().textContent().catch(() => null)
  if (heading && heading.trim()) {
    return { type: "landmark_visible", selector: "h1", text: heading.trim().slice(0, 120) }
  }

  const title = await page.title().catch(() => "")
  if (title) {
    return { type: "landmark_visible", selector: "title", text: title.slice(0, 120) }
  }

  return null
}

// ─── Crawl & Discovery ──────────────────────────────────────────────────────

async function crawlPages(page, startUrls, origin, options = {}) {
  const {
    maxPages = 20,
    maxDepth = Infinity,
    timeout = 30000,
    excludeRoutes = [],
    consoleErrors = [],
    visited = new Set(),
  } = options

  const siteModel = {}
  const queue = startUrls.map((url) => ({ url, depth: 0 }))
  let scanned = 0

  while (queue.length > 0 && visited.size < maxPages) {
    const { url, depth } = queue.shift()
    if (depth > maxDepth) continue

    const normalized = normalizeUrl(url)
    if (visited.has(normalized)) continue
    if (isExcluded(normalized, excludeRoutes, origin)) continue

    visited.add(normalized)
    scanned++
    process.stdout.write(`  Scanning page ${scanned}/${maxPages}: ${new URL(normalized).pathname}...\r`)

    const scanResult = await scanPage(page, url, origin, timeout, consoleErrors)
    siteModel[scanResult.route] = scanResult

    if (scanResult.success) {
      // Queue outbound routes
      for (const outRoute of scanResult.outboundRoutes) {
        const outUrl = origin + outRoute
        const outNorm = normalizeUrl(outUrl)
        if (!visited.has(outNorm) && !isExcluded(outNorm, excludeRoutes, origin)) {
          queue.push({ url: outUrl, depth: depth + 1 })
        }
      }

      // Queue nav sidebar links
      const navLinks = scanResult.navLinks || []
      for (const href of navLinks) {
        try {
          const linkUrl = new URL(href, origin).href
          if (!linkUrl.startsWith(origin)) continue
          const linkNorm = normalizeUrl(linkUrl)
          if (!visited.has(linkNorm) && !isExcluded(linkNorm, excludeRoutes, origin)) {
            queue.push({ url: linkUrl, depth: depth + 1 })
          }
        } catch { /* invalid URL */ }
      }
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 500))
  }

  return { siteModel, visited }
}

async function findLoginPage(siteModel, page, origin, timeout) {
  // Strategy 1: Check already-crawled pages for auth_form pattern
  for (const [route, scan] of Object.entries(siteModel)) {
    if (scan.patterns && scan.patterns.some((p) => p.type === "auth_form")) {
      return { url: scan.url, route, source: "crawl" }
    }
  }

  // Strategy 2: Try common login paths
  const commonPaths = ["/login", "/signin", "/sign-in", "/auth", "/auth/login", "/account/login"]
  for (const loginPath of commonPaths) {
    try {
      const resp = await page.goto(origin + loginPath, { waitUntil: "domcontentloaded", timeout })
      if (resp && resp.status() < 400) {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
        const patterns = await matchPatterns(page)
        if (patterns.some((p) => p.type === "auth_form")) {
          return { url: page.url(), route: new URL(page.url()).pathname, source: "common_path" }
        }
      }
    } catch { /* path doesn't exist */ }
  }

  // Strategy 3: Look for login links in already-crawled pages
  for (const scan of Object.values(siteModel)) {
    const allLinks = [
      ...(scan.navLinks || []),
      ...(scan.outboundRoutes || []).map((r) => origin + r),
    ]
    for (const link of allLinks) {
      const lower = typeof link === "string" ? link.toLowerCase() : ""
      if (lower.includes("login") || lower.includes("signin") || lower.includes("sign-in")) {
        const url = link.startsWith("http") ? link : origin + link
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
          const patterns = await matchPatterns(page)
          if (patterns.some((p) => p.type === "auth_form")) {
            return { url: page.url(), route: new URL(page.url()).pathname, source: "link_text" }
          }
        } catch { /* invalid link */ }
      }
    }
  }

  return null
}

// ─── Scan Functions ──────────────────────────────────────────────────────────

async function authenticate(page, url, email, password, timeout) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout })
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

    const loginRoute = new URL(page.url()).pathname

    // Find email and password inputs
    const emailInput = page.locator(
      "input[type='email'], input[name='email'], input[type='text'][name*='user']"
    )
    const passwordInput = page.locator("input[type='password']")

    if ((await emailInput.count()) === 0 || (await passwordInput.count()) === 0) {
      return null
    }

    await emailInput.first().fill(email)
    await passwordInput.first().fill(password)

    // Submit
    const submitBtn = page.locator("button[type='submit'], input[type='submit']")
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click()
    } else {
      await passwordInput.first().press("Enter")
    }

    // Wait for navigation away from login
    await page
      .waitForURL((u) => !u.pathname.includes("login") && !u.pathname.includes("sign-in"), {
        timeout: 10000,
      })
      .catch(() => {})

    const currentUrl = page.url()
    if (currentUrl.includes("login") || currentUrl.includes("sign-in")) {
      return null
    }

    return loginRoute
  } catch {
    return null
  }
}

async function scanPage(page, url, origin, timeout, globalConsoleErrors) {
  const startTime = Date.now()
  const pageConsoleErrors = []

  // Capture errors during this page's load
  const errorsBefore = globalConsoleErrors.length

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout })
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

    const title = await page.title()
    const finalUrl = page.url()
    const route = new URL(finalUrl).pathname

    // Pattern matching
    const patterns = await matchPatterns(page)

    // Extract nav links if nav_sidebar found
    let navLinks = []
    if (patterns.some((p) => p.type === "nav_sidebar")) {
      navLinks = await extractNavLinks(page, origin)
    }

    // Extract pagination info for data_table patterns
    for (const p of patterns) {
      if (p.type === "data_table") {
        const paginationCount = await page
          .locator("nav[aria-label='pagination'], [class*='pagination'], [class*='pager']")
          .count()
          .catch(() => 0)
        p.details = { ...(p.details || {}), pagination: { present: paginationCount > 0 } }

        // Extract column headers
        const headers = []
        const headerLocator = page.locator("thead th, [role='columnheader']")
        const headerCount = await headerLocator.count()
        for (let i = 0; i < Math.min(headerCount, 20); i++) {
          const text = (await headerLocator.nth(i).textContent().catch(() => ""))?.trim()
          if (text) headers.push(text)
        }
        if (headers.length > 0) p.details.headers = headers

        // Row count
        const rowCount = await page.locator("tbody tr, [role='row']").count().catch(() => 0)
        p.details.rows = { count: rowCount }
      }
    }

    // Interactive elements (lightweight)
    const buttons = []
    const btnLocator = page.locator("button:visible")
    const btnCount = Math.min(await btnLocator.count(), 20)
    for (let i = 0; i < btnCount; i++) {
      try {
        const text = ((await btnLocator.nth(i).textContent()) || "").trim()
        if (text && text.length < 80) buttons.push({ text })
      } catch { /* stale */ }
    }

    const inputs = []
    const inputLocator = page.locator("input:visible:not([type='hidden']), select:visible, textarea:visible")
    const inputCount = Math.min(await inputLocator.count(), 20)
    for (let i = 0; i < inputCount; i++) {
      try {
        const el = inputLocator.nth(i)
        inputs.push({
          type: (await el.getAttribute("type")) || (await el.evaluate((e) => e.tagName.toLowerCase())),
          name: (await el.getAttribute("name")) || "",
          placeholder: (await el.getAttribute("placeholder")) || "",
        })
      } catch { /* stale */ }
    }

    // Capture landmark candidates for health block generation
    const landmarks = await page.evaluate(() => {
      const h1 = document.querySelector("h1")?.textContent?.trim() || ""
      const h2 = document.querySelector("h2")?.textContent?.trim() || ""
      const dataPages = Array.from(document.querySelectorAll("[data-page]"))
        .map(el => el.getAttribute("data-page")).filter(Boolean)
      const dataTestIds = Array.from(document.querySelectorAll("[data-testid]"))
        .map(el => el.getAttribute("data-testid")).filter(Boolean).slice(0, 5)
      return { h1, h2, dataPages, dataTestIds }
    }).catch(() => ({ h1: "", h2: "", dataPages: [], dataTestIds: [] }))

    // Outbound routes
    const outboundRoutes = await collectOutboundRoutes(page, origin)

    // Console errors for this page
    const errorsAfter = globalConsoleErrors.length
    const consoleErrors = globalConsoleErrors.slice(errorsBefore, errorsAfter).map((e) => ({
      type: e.type,
      text: e.text,
    }))

    return {
      url: finalUrl,
      route,
      title,
      patterns,
      interactiveElements: { buttons, inputs, links: await page.locator("a[href]").count() },
      outboundRoutes,
      navLinks,
      landmarks,
      consoleErrors,
      scanDuration: Date.now() - startTime,
      success: true,
    }
  } catch (err) {
    return {
      url,
      route: new URL(url).pathname,
      title: "",
      patterns: [],
      interactiveElements: { buttons: [], inputs: [], links: 0 },
      outboundRoutes: [],
      navLinks: [],
      landmarks: { h1: "", h2: "", dataPages: [], dataTestIds: [] },
      consoleErrors: [],
      scanDuration: Date.now() - startTime,
      success: false,
      error: err.message,
    }
  }
}

async function matchPatterns(page) {
  const matches = []

  for (const [patternName, pattern] of Object.entries(UI_PATTERN_SIGNALS)) {
    let signalHits = 0
    let rootSelector = ""

    for (const signal of pattern.signals) {
      const selectors = signal.split(",").map((s) => s.trim())
      for (const selector of selectors) {
        try {
          const count = await page.locator(selector).count()
          if (count > 0) {
            signalHits++
            if (!rootSelector) rootSelector = selector
            break
          }
        } catch { /* invalid selector */ }
      }
    }

    if (signalHits >= (pattern.minMatch || 1)) {
      matches.push({
        type: patternName,
        confidence: Math.round((signalHits / pattern.signals.length) * 100) / 100,
        rootSelector,
        signalHits,
        totalSignals: pattern.signals.length,
        details: {},
      })
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence)
}

async function extractNavLinks(page, origin) {
  const links = []
  const locator = page.locator("nav a[href], [role='navigation'] a[href]")
  const count = await locator.count()

  for (let i = 0; i < Math.min(count, 50); i++) {
    try {
      const href = await locator.nth(i).getAttribute("href")
      if (href) {
        const absolute = new URL(href, origin).href
        if (absolute.startsWith(origin)) links.push(absolute)
      }
    } catch { /* stale */ }
  }

  return links
}

async function collectOutboundRoutes(page, origin) {
  const links = page.locator("a[href]")
  const count = await links.count()
  const routes = new Set()

  for (let i = 0; i < Math.min(count, 100); i++) {
    try {
      const href = await links.nth(i).getAttribute("href")
      if (!href) continue
      const absolute = new URL(href, origin).href
      if (!absolute.startsWith(origin)) continue
      const pathname = new URL(absolute).pathname
      if (pathname && pathname !== "#") routes.add(pathname)
    } catch { /* stale/invalid */ }
  }

  return Array.from(routes).sort()
}

// ─── Feature Model Generation ────────────────────────────────────────────────

function generateFeatureModel(siteModel, options = {}) {
  const features = {}
  const hasAuth = Object.values(siteModel).some((p) =>
    p.patterns.some((m) => m.type === "auth_form")
  )

  let authRoute = options.authRoute
  if (!authRoute && hasAuth) {
    const authPage = Object.values(siteModel).find((p) =>
      p.patterns.some((m) => m.type === "auth_form")
    )
    authRoute = authPage?.route
  }

  // Shared capabilities
  const shared = {}
  if (hasAuth && authRoute) {
    shared.authenticated = {
      how: "fill email and password on login page, submit form",
      verify: "URL no longer contains login/sign-in path",
      route: authRoute,
    }
  }

  for (const [route, pageScan] of Object.entries(siteModel)) {
    if (!pageScan.success) continue
    if (options.excludeRoutes?.some((ex) => route.startsWith(ex))) continue

    const featureName = routeToFeatureName(route)
    if (!featureName) continue

    const isAuthPage = pageScan.patterns.some((m) => m.type === "auth_form")
    if (isAuthPage) {
      features.authentication = generateAuthFeature(pageScan, route)
      continue
    }

    const requires = []
    if (hasAuth && !isAuthPage) requires.push("authenticated")

    const meaningfulPatterns = pageScan.patterns.filter((p) => !STRUCTURAL_PATTERNS.has(p.type))
    const capabilities = meaningfulPatterns.length > 0
      ? generateCapabilities(meaningfulPatterns, pageScan)
      : {}

    // Every successfully crawled route gets a health block
    const health = buildHealthBlock(route, pageScan)

    if (features[featureName]) {
      Object.assign(features[featureName].capabilities, capabilities)
      if (!features[featureName].health) features[featureName].health = health
    } else {
      features[featureName] = {
        description: generateDescription(featureName, pageScan),
        route,
        requires,
        capabilities,
        health,
      }
    }
  }

  return {
    version: "1.0",
    meta: {
      generated_by: "init",
      learn_sessions: 0,
      confidence: "skeleton",
      generated_at: new Date().toISOString(),
    },
    features,
    shared,
  }
}

function generateCapabilities(patterns, pageScan) {
  const capabilities = {}
  const seen = new Set()

  for (const pattern of patterns) {
    const templateMap = PATTERN_CAPABILITY_MAP[pattern.type]
    if (!templateMap) continue

    for (const [capName, template] of Object.entries(templateMap)) {
      if (seen.has(capName)) continue
      seen.add(capName)

      capabilities[capName] = {
        interaction: template.interaction,
        expected: [...template.expected],
        verify: JSON.parse(JSON.stringify(template.verify)),
        ...(template.preconditions && { preconditions: [...template.preconditions] }),
        ...(template.cleanup && { cleanup: template.cleanup }),
        ...(template.test_data && { test_data: { ...template.test_data } }),
        source: "init",
        mode: "passive",
        _confidence: "init",
        _observed: 0,
      }
    }
  }

  return capabilities
}

function generateAuthFeature(pageScan, route) {
  const templates = PATTERN_CAPABILITY_MAP.auth_form
  const capabilities = {}

  for (const [capName, template] of Object.entries(templates)) {
    capabilities[capName] = {
      interaction: template.interaction,
      expected: [...template.expected],
      verify: JSON.parse(JSON.stringify(template.verify)),
      ...(template.test_data && { test_data: { ...template.test_data } }),
      source: "init",
      mode: "passive",
      _confidence: "init",
      _observed: 0,
    }
  }

  return {
    description: "User login and session management",
    route,
    requires: [],
    capabilities,
  }
}

function buildHealthBlock(route, pageScan) {
  const landmark = pickInitLandmark(pageScan)
  return {
    route,
    ...(landmark && { landmark }),
    checks: [
      { type: "url_is", value: route },
      { type: "no_js_errors" },
      { type: "no_console_errors" },
      { type: "no_error_alerts" },
    ],
  }
}

function pickInitLandmark(pageScan) {
  const lm = pageScan.landmarks
  if (lm?.dataPages?.length > 0) {
    return { selector: `[data-page="${lm.dataPages[0]}"]`, text: lm.dataPages[0] }
  }
  if (lm?.dataTestIds?.length > 0) {
    return { selector: `[data-testid="${lm.dataTestIds[0]}"]`, text: lm.dataTestIds[0] }
  }
  if (lm?.h1 && lm.h1.length > 1 && !/loading/i.test(lm.h1)) {
    return { selector: "h1", text: lm.h1 }
  }
  if (lm?.h2 && lm.h2.length > 1 && !/loading/i.test(lm.h2)) {
    return { selector: "h2", text: lm.h2 }
  }
  if (pageScan.title && pageScan.title.length > 2 && !/loading/i.test(pageScan.title)) {
    return { selector: "title", text: pageScan.title }
  }
  return null
}

function routeToFeatureName(route) {
  const cleaned = route
    .replace(/^\/home\//, "")
    .replace(/^\/app\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "")

  if (!cleaned || cleaned === "/") return "home"

  const segments = cleaned.split("/").filter(Boolean)
  const last = segments[segments.length - 1]

  return last.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()
}

function generateDescription(featureName, pageScan) {
  const title = pageScan.title
  const patternTypes = pageScan.patterns.map((p) => p.type)

  if (title && !title.toLowerCase().includes("loading") && title.length > 2) return title

  const name = featureName.replace(/_/g, " ")
  if (patternTypes.includes("crud_page")) return `Manage ${name}`
  if (patternTypes.includes("data_table")) return `View and manage ${name}`
  if (patternTypes.includes("form_generic")) return `${name} settings`
  return `${name.charAt(0).toUpperCase() + name.slice(1)} page`
}

// ─── Instructions Generation ─────────────────────────────────────────────────

function generateInstructions(siteModel, options = {}) {
  const pages = Object.values(siteModel)
  const pageCount = pages.filter((p) => p.success).length

  // Detect known issues from console errors
  const knownIssues = []
  const errorPatterns = new Map()
  for (const pg of pages) {
    for (const err of pg.consoleErrors) {
      if (err.text.includes("ResizeObserver loop")) {
        if (!errorPatterns.has("ResizeObserver loop")) {
          errorPatterns.set("ResizeObserver loop", new Set())
        }
        errorPatterns.get("ResizeObserver loop").add(pg.route)
      }
    }
  }
  for (const [pattern, routes] of errorPatterns) {
    for (const route of routes) {
      knownIssues.push({
        page: route,
        issue: "console_error",
        pattern,
        action: "ignore",
        reason: "Benign browser warning detected during scan",
      })
    }
  }

  // Detect exclude routes
  const excludeRoutes = [...(options.excludeRoutes || [])]
  for (const pg of pages) {
    if (!pg.success && pg.route) excludeRoutes.push(pg.route)
  }
  if (pages.some((p) => p.route.startsWith("/api"))) excludeRoutes.push("/api/*")

  // Custom selectors
  const customSelectors = {}
  if (pages.some((p) => p.patterns.some((m) => m.type === "toast_notification"))) {
    customSelectors.toast = "[data-sonner-toast], [role='status'], [role='alert']"
  }

  // Timing
  const scanDurations = pages.filter((p) => p.success).map((p) => p.scanDuration || 0)
  const avgScanTime = scanDurations.length > 0
    ? scanDurations.reduce((a, b) => a + b, 0) / scanDurations.length
    : 0
  const pageLoadBuffer = avgScanTime > 2000 ? 1500 : 1000

  const hints = []
  if (avgScanTime > 3000) {
    hints.push(`Pages are slow to load (~${Math.round(avgScanTime / 1000)}s average). Be patient with transitions.`)
  }

  return {
    version: "1.0",
    global: {
      viewport: { width: 1920, height: 1080 },
      defaultTimeout: avgScanTime > 5000 ? 15000 : 10000,
      waitAfterAction: 500,
      toastTimeout: 5000,
      screenshotsOn: ["failure", "capability_complete"],
      customSelectors,
    },
    scope: {
      exclude_routes: [...new Set(excludeRoutes)],
      exclude_capabilities: [],
      include_only: null,
      max_pages: Math.max(pageCount + 5, 20),
    },
    timing: {
      slow_transitions: [],
      toast_appear_delay: 3000,
      page_load_buffer: pageLoadBuffer,
    },
    known_issues: knownIssues,
    auth: {
      strategy: "form",
      session_duration: "30m",
      reauth_on_redirect: true,
      mfa: false,
    },
    environment_overrides: {},
    agent_hints: hints,
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url)
    u.hash = ""
    u.pathname = u.pathname.replace(/\/$/, "") || "/"
    u.searchParams.sort()
    return u.toString()
  } catch {
    return url
  }
}

function isExcluded(url, excludePatterns, origin) {
  try {
    const pathname = new URL(url).pathname
    return excludePatterns.some((pattern) => {
      if (pattern.endsWith("/*")) return pathname.startsWith(pattern.slice(0, -2))
      return pathname.startsWith(pattern)
    })
  } catch {
    return false
  }
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
