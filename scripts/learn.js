#!/usr/bin/env node

/**
 * qa-agent learn — Iterative feature model refinement
 *
 * Opens a visible browser. You use the app. The agent watches.
 * Each session improves QA_FEATURE_MODEL.json.
 *
 * Usage:
 *   npx qa-agent learn --url https://app.example.com --email test@x.com --password pass123
 *   npx qa-agent learn --url https://app.example.com --resume
 *   npx qa-agent learn --history
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { chromium } = require("playwright")

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
  url: getArg("--url") || process.env.QA_PREVIEW_URL,
  email: getArg("--email") || process.env.TEST_EMAIL,
  password: getArg("--password") || process.env.TEST_PASSWORD,
  modelPath: getArg("--model") || "./QA_FEATURE_MODEL.json",
  resume: hasFlag("--resume"),
  history: hasFlag("--history"),
  sessionFile: ".qa-learn-session.json",
  timeout: parseInt(getArg("--timeout") || "30000", 10),
}

// ─── History Command ─────────────────────────────────────────────────────────

if (config.history) {
  showHistory()
  process.exit(0)
}

function showHistory() {
  const historyDir = ".qa-learn-history"
  if (!fs.existsSync(historyDir)) {
    console.log("No learn sessions found.")
    return
  }
  const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort()
  if (files.length === 0) {
    console.log("No learn sessions found.")
    return
  }
  console.log("Learn Session History:")
  console.log("=".repeat(60))
  for (const file of files) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(historyDir, file), "utf-8"))
      const date = new Date(session.startTime).toLocaleString()
      const duration = session.endTime
        ? `${((session.endTime - session.startTime) / 60000).toFixed(1)}min`
        : "incomplete"
      console.log(
        `  Session #${session.sessionNumber}: ${date} -- ${session.observations?.length || 0} observations, ${duration}`
      )
    } catch { /* corrupted file */ }
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

if (!config.url) {
  console.error("Error: --url is required (or set QA_PREVIEW_URL)")
  process.exit(1)
}

if (!fs.existsSync(config.modelPath)) {
  console.error(`Error: Feature model not found: ${config.modelPath}`)
  console.error("Run 'npx qa-agent init' first to generate the model.")
  process.exit(1)
}

// ─── Pattern Signal Definitions (mirrors patterns.ts) ────────────────────────

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
    signals: ["table, [role='grid']", "thead th, [role='columnheader']", "tbody tr, [role='row']"],
    minMatch: 2,
  },
  search_filter: {
    signals: [
      "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i]",
      "button:has-text('Search'), button:has-text('Filter'), button:has-text('Apply')",
    ],
    minMatch: 1,
  },
}

// ─── Monitored Selectors for State Snapshots ─────────────────────────────────

const MONITORED_SELECTORS = [
  "tbody tr",
  "[role='row']",
  "table",
  "[role='dialog']",
  "[role='alert']",
  "[role='status']",
  ".toast, [data-sonner-toast]",
  "form",
  "input:visible",
  "button:visible",
  ".error, .text-red-500",
  "thead th",
  "[class*='modal']",
  "[class*='filter-chip'], [class*='badge']",
]

// ─── Event Tracker Injection Script ──────────────────────────────────────────

const TRACKER_SCRIPT = `
(() => {
  if (window.__qaTracker) return;
  window.__qaTracker = {
    events: [],
    init() {
      document.addEventListener('click', (e) => {
        // Check for custom dropdown option selection first
        const option = e.target.closest('[role="option"], [role="menuitem"], [role="listbox"] li, [data-value], [cmdk-item], .select-option, .dropdown-item, .listbox-option');
        if (option) {
          const listbox = option.closest('[role="listbox"], [role="menu"], [cmdk-list], .select-dropdown, .dropdown-menu, ul, ol');
          const triggerLabel = listbox ? (listbox.getAttribute('aria-label') || '') : '';
          // Determine position (1-indexed) within the list
          let position = 1;
          if (listbox) {
            const siblings = listbox.querySelectorAll('[role="option"], [role="menuitem"], li, [data-value], [cmdk-item]');
            for (let idx = 0; idx < siblings.length; idx++) {
              if (siblings[idx] === option || option.contains(siblings[idx]) || siblings[idx].contains(option)) {
                position = idx + 1;
                break;
              }
            }
          }
          // Find the trigger element that opened this dropdown
          let triggerSel = '';
          let triggerTxt = '';
          // Strategy 1: find button/combobox with aria-controls pointing to the listbox or its parent dialog
          const listboxId = listbox ? listbox.id : '';
          const dialogParent = option.closest('[role="dialog"], [data-state="open"]');
          const dialogId = dialogParent ? dialogParent.id : '';
          const controlsId = listboxId || dialogId;
          if (controlsId) {
            const trigger = document.querySelector('[aria-controls="' + controlsId + '"]');
            if (trigger) {
              triggerSel = this.getSelector(trigger);
              triggerTxt = (trigger.textContent || '').trim().slice(0, 100);
            }
          }
          // Strategy 2: find the nearest open combobox/button with aria-expanded
          if (!triggerSel) {
            const expandedTrigger = document.querySelector('[aria-expanded="true"][role="combobox"], button[aria-expanded="true"][data-state="open"]');
            if (expandedTrigger) {
              triggerSel = this.getSelector(expandedTrigger);
              triggerTxt = (expandedTrigger.textContent || '').trim().slice(0, 100);
            }
          }
          this.events.push({
            type: 'select_option',
            timestamp: Date.now(),
            selector: this.getSelector(option),
            value: option.getAttribute('data-value') || (option.textContent || '').trim().slice(0, 100),
            text: (option.textContent || '').trim().slice(0, 100),
            tag: option.tagName.toLowerCase(),
            field: triggerLabel || triggerTxt || 'dropdown',
            position: position,
            triggerSelector: triggerSel || undefined,
            triggerText: triggerTxt || undefined,
            url: window.location.href,
          });
          return;
        }
        const target = e.target.closest('button, a, input, select, [role="button"], [onclick], [role="tab"], [role="menuitem"], [role="combobox"]');
        if (!target) return;
        this.events.push({
          type: 'click',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          text: (target.textContent || '').trim().slice(0, 100),
          tag: target.tagName.toLowerCase(),
          id: target.id || undefined,
          testId: target.getAttribute('data-testid') || undefined,
          ariaLabel: target.getAttribute('aria-label') || undefined,
          href: target.getAttribute('href') || undefined,
          url: window.location.href,
        });
      }, { capture: true });
      // Native <select> change events
      document.addEventListener('change', (e) => {
        const target = e.target;
        if (target.tagName === 'SELECT') {
          const selectedOption = target.options[target.selectedIndex];
          this.events.push({
            type: 'select_option',
            timestamp: Date.now(),
            selector: this.getSelector(target),
            value: target.value,
            text: selectedOption ? selectedOption.textContent.trim() : target.value,
            tag: 'select',
            field: target.name || target.id || target.getAttribute('aria-label') || 'select',
            url: window.location.href,
          });
        }
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
      document.addEventListener('submit', (e) => {
        this.events.push({
          type: 'submit',
          timestamp: Date.now(),
          selector: this.getSelector(e.target),
          tag: 'form',
          url: window.location.href,
        });
      }, { capture: true });
      const orig = history.pushState;
      const t = this;
      history.pushState = function() { orig.apply(this, arguments); t.events.push({ type: 'navigation', timestamp: Date.now(), selector: '', url: window.location.href }); };
      window.addEventListener('popstate', () => { t.events.push({ type: 'navigation', timestamp: Date.now(), selector: '', url: window.location.href }); });
    },
    getSelector(el) {
      if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
      if (el.id && !el.id.match(/^(:|react|ember|vue|radix|rc-|headlessui|downshift|mui)/)) return '#' + el.id;
      if (el.getAttribute('aria-label')) return '[aria-label="' + el.getAttribute('aria-label') + '"]';
      if (['BUTTON', 'A'].includes(el.tagName)) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 50) return el.tagName.toLowerCase() + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
      }
      if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
      return this.cssPath(el);
    },
    cssPath(el) {
      const parts = [];
      let c = el;
      while (c && c !== document.body && parts.length < 5) {
        let s = c.tagName.toLowerCase();
        if (c.className && typeof c.className === 'string') {
          const cls = c.className.trim().split(/\\s+/).filter(x => x && !x.match(/^(hover|focus|active)/)).slice(0, 2);
          if (cls.length) s += '.' + cls.join('.');
        }
        parts.unshift(s);
        c = c.parentElement;
      }
      return parts.join(' > ');
    },
    flush() { const e = [...this.events]; this.events = []; return e; }
  };
  window.__qaTracker.init();
})();
`

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load feature model
  const model = JSON.parse(fs.readFileSync(config.modelPath, "utf-8"))
  const featureCount = Object.keys(model.features).length
  const capCount = Object.values(model.features).reduce(
    (sum, f) => sum + Object.keys(f.capabilities).length,
    0
  )

  // Determine session number
  let sessionNumber = (model.meta?.learn_sessions ?? 0) + 1
  let savedSession = null

  if (config.resume && fs.existsSync(config.sessionFile)) {
    savedSession = JSON.parse(fs.readFileSync(config.sessionFile, "utf-8"))
    sessionNumber = savedSession.sessionNumber
    console.log(`Resuming session #${sessionNumber} (${savedSession.observations?.length || 0} observations so far)`)
  }

  // Print header
  console.log("")
  console.log("=".repeat(60))
  console.log(`  QA Agent -- Learn Mode (Session #${sessionNumber})`)
  console.log("")
  console.log(`  Loaded: ${config.modelPath} (${featureCount} features, ${capCount} capabilities)`)
  console.log(`  Browser will open at ${config.url}`)
  console.log("")
  console.log("  Walk through your app. The agent is watching.")
  console.log("")
  console.log("  Commands:")
  console.log("    [Enter]  Mark this interaction as a capability")
  console.log("    [n]      Name/rename the current capability")
  console.log("    [e]      Mark as edge case for the last capability")
  console.log("    [s]      Skip -- don't record this interaction")
  console.log("    [d]      Done -- finish session and merge into model")
  console.log("")

  // Show low-confidence capabilities
  const lowConfidence = []
  for (const [fname, feature] of Object.entries(model.features)) {
    for (const [cname, cap] of Object.entries(feature.capabilities)) {
      if (!cap._confidence || cap._confidence === "init" || cap._confidence === "migrated") {
        lowConfidence.push(`${fname}.${cname} -- ${cap._confidence || "init"}, ${cap._observed || 0}x observed`)
      }
    }
  }
  if (lowConfidence.length > 0) {
    console.log("  Capabilities to improve (low confidence):")
    for (const item of lowConfidence.slice(0, 8)) {
      console.log(`    * ${item}`)
    }
    if (lowConfidence.length > 8) console.log(`    ... and ${lowConfidence.length - 8} more`)
    console.log("")
  }

  console.log("=".repeat(60))
  console.log("")

  // Launch visible browser
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  // Keep browser open — prevent Playwright from auto-closing
  browser.on("disconnected", () => {
    console.log("\nBrowser closed. Ending session.")
    process.exit(0)
  })

  // Console error tracking
  let consoleErrorCount = 0
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrorCount++ })
  page.on("pageerror", () => { consoleErrorCount++ })

  // Navigate and authenticate
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeout })
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

  if (config.email && config.password) {
    console.log("Authenticating...")
    await authenticate(page, config.email, config.password)
    console.log(`Authenticated. Current URL: ${page.url()}`)
  }

  // Inject tracker
  await page.evaluate(TRACKER_SCRIPT)

  // Re-inject on navigation
  page.on("load", async () => {
    try { await page.evaluate(TRACKER_SCRIPT) } catch { /* page not ready */ }
  })

  // Session state
  const observations = savedSession?.observations || []
  let skippedCount = savedSession?.skippedCount || 0
  let lastSnapshot = await captureState(page, consoleErrorCount)
  let pendingEvents = []
  let lastCapabilityId = null

  // Flow recording state
  let recordingFlow = false
  let currentFlowName = null
  let currentFlowSteps = []
  let flowStartSnapshot = null
  const recordedFlows = []

  // Auto-save every 30 seconds
  const autoSave = setInterval(() => {
    saveSession({
      sessionNumber,
      startTime: savedSession?.startTime || Date.now(),
      url: config.url,
      observations,
      skippedCount,
      modelPath: config.modelPath,
    })
  }, 30000)

  // Poll for events every 500ms
  const poller = setInterval(async () => {
    try {
      const events = await page.evaluate(() => {
        if (typeof window.__qaTracker?.flush === "function") return window.__qaTracker.flush()
        return []
      })
      if (events && events.length > 0) {
        pendingEvents.push(...events)
        displayEvents(events)
      }
    } catch { /* page navigating */ }
  }, 500)

  // Terminal input
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl.setPrompt("")

  // Keep process alive until user types "d"
  process.stdin.ref()

  console.log("Commands:")
  console.log("  [Enter] Record health checkpoint (or flow step if recording)")
  console.log("  [r]     Start recording E2E flow")
  console.log("  [f]     Finish recording E2E flow")
  console.log("  [v]     Add verify check to last flow step")
  console.log("  [n]     Name last capability")
  console.log("  [e]     Record edge case")
  console.log("  [s]     Skip / discard pending events")
  console.log("  [d]     Done — finish session")
  console.log("")
  console.log("Status: Watching... (press Enter to record, d to finish)\n")

  // Wrap in a promise so main() doesn't resolve until session ends
  await new Promise((resolveSession) => {

  rl.on("line", async (line) => {
    const cmd = line.trim().toLowerCase()

    // ── [r] Start recording E2E flow ──
    if (cmd === "r") {
      if (recordingFlow) {
        console.log("  Already recording a flow. Press [f] to finish it first.\n")
        return
      }
      recordingFlow = true
      currentFlowSteps = []
      flowStartSnapshot = await captureState(page, consoleErrorCount)
      console.log("  FLOW RECORDING STARTED")
      console.log("  Perform actions, press [Enter] to record each step, [f] to finish flow.\n")
      return
    }

    // ── [f] Finish recording E2E flow ──
    if (cmd === "f") {
      if (!recordingFlow) {
        console.log("  Not recording a flow. Press [r] to start one.\n")
        return
      }

      if (currentFlowSteps.length === 0) {
        console.log("  No steps recorded. Flow discarded.\n")
        recordingFlow = false
        currentFlowName = null
        currentFlowSteps = []
        flowStartSnapshot = null
        return
      }

      // Ask for flow name
      recordingFlow = false
      rl.question("  Name this flow: ", (answer) => {
        const name = answer.trim() || `flow_${recordedFlows.length + 1}`
        const flow = {
          name,
          startRoute: flowStartSnapshot.route,
          steps: currentFlowSteps,
          stepCount: currentFlowSteps.length,
          recordedAt: new Date().toISOString(),
        }
        recordedFlows.push(flow)
        console.log(`  FLOW SAVED: "${name}" (${currentFlowSteps.length} steps)`)
        console.log("")

        currentFlowName = null
        currentFlowSteps = []
        flowStartSnapshot = null
      })
      return
    }

    // ── [v] Add verify check to last flow step ──
    if (cmd === "v" || cmd.startsWith("v ")) {
      if (!recordingFlow || currentFlowSteps.length === 0) {
        console.log("  No flow step to add verify to. Record a step with [Enter] first.\n")
        return
      }

      const lastStep = currentFlowSteps[currentFlowSteps.length - 1]
      const currentSnapshot = await captureState(page, consoleErrorCount)
      const diff = computeDiff(lastStep.stateAfter || lastSnapshot, currentSnapshot)
      const landmarks = currentSnapshot.landmarks || {}

      // Auto-detect what to verify
      const verifyChecks = []

      // Check for toast
      const toastText = diff.newTexts.find(t => /success|saved|created|updated|deleted|sent|added|removed/i.test(t))
      if (toastText) {
        verifyChecks.push({ type: "toast_contains", value: toastText.slice(0, 100) })
        console.log(`    + toast_contains: "${toastText.slice(0, 60)}"`)
      }

      // Check for URL change
      if (diff.urlChanged) {
        const pathname = new URL(diff.newUrl).pathname
        verifyChecks.push({ type: "url_is", value: pathname })
        console.log(`    + url_is: ${pathname}`)
      }

      // Check for landmark (text on page proving success)
      const visibleText = cmd.startsWith("v ") ? cmd.slice(2).trim() : null
      if (visibleText) {
        verifyChecks.push({ type: "text_visible", value: visibleText })
        console.log(`    + text_visible: "${visibleText}"`)
      }

      // Check for dialog
      const dialogAppeared = diff.elementChanges.find(c => c.selector === "[role='dialog']" && c.before === 0 && c.after > 0)
      if (dialogAppeared) {
        verifyChecks.push({ type: "element_exists", selector: '[role="dialog"]' })
        console.log(`    + element_exists: [role="dialog"]`)
      }

      if (verifyChecks.length === 0) {
        // Fallback: check current landmark
        const lm = pickLandmark(landmarks)
        if (lm) {
          verifyChecks.push({ type: "landmark_visible", selector: lm.selector, text: lm.text })
          console.log(`    + landmark_visible: ${lm.selector} "${lm.text}"`)
        } else {
          console.log("  (no verifiable change detected)")
        }
      }

      if (!lastStep.verify) lastStep.verify = []
      lastStep.verify.push(...verifyChecks)
      console.log(`  VERIFY added to step ${currentFlowSteps.length} (${verifyChecks.length} checks)\n`)
      return
    }

    if (cmd === "d" || cmd === "done") {
      // If recording a flow, auto-finish it
      if (recordingFlow && currentFlowSteps.length > 0) {
        const name = `flow_${recordedFlows.length + 1}`
        recordedFlows.push({
          name,
          startRoute: flowStartSnapshot.route,
          steps: currentFlowSteps,
          stepCount: currentFlowSteps.length,
          recordedAt: new Date().toISOString(),
        })
        console.log(`  Auto-finished flow: "${name}" (${currentFlowSteps.length} steps)`)
        recordingFlow = false
        currentFlowSteps = []
        flowStartSnapshot = null
      }

      // Finish session
      clearInterval(poller)
      clearInterval(autoSave)
      rl.close()

      console.log("\nFinishing session...")
      const session = {
        sessionNumber,
        startTime: savedSession?.startTime || Date.now(),
        endTime: Date.now(),
        url: config.url,
        observations,
        skippedCount,
        modelPath: config.modelPath,
      }

      // Save to history
      saveToHistory(session)

      // Merge into model
      console.log("Merging observations into feature model...")
      const mergeResult = mergeIntoModel(model, observations, sessionNumber)

      // Save updated model
      fs.writeFileSync(config.modelPath, JSON.stringify(mergeResult.model, null, 2))
      console.log(`Updated: ${config.modelPath}`)

      // Print summary
      console.log("")
      console.log("=".repeat(60))
      console.log("Session complete. Model comparison:")
      console.log("")
      console.log(`  Unchanged:   ${mergeResult.result.unchanged} capabilities`)
      console.log(`  Updated:     ${mergeResult.result.updated.length} capabilities`)
      console.log(`  New:         ${mergeResult.result.added.length} capabilities`)
      console.log(`  Edge cases:  ${mergeResult.result.edgeCasesAdded.length}`)
      console.log(`  Skipped:     ${skippedCount}`)
      console.log(`  Flows:       ${recordedFlows.length}`)

      if (mergeResult.result.updated.length > 0) {
        console.log("")
        console.log("  Changes:")
        for (const u of mergeResult.result.updated) {
          console.log(`    ${u.feature}.${u.capability}:`)
          for (const c of u.changes) console.log(`      ${c}`)
        }
      }
      if (mergeResult.result.added.length > 0) {
        console.log("")
        console.log("  New capabilities:")
        for (const a of mergeResult.result.added) {
          console.log(`    + ${a.feature}.${a.capability}`)
        }
      }

      // Save recorded flows
      if (recordedFlows.length > 0) {
        const flowsPath = path.join(path.dirname(config.modelPath), "QA_RECORDED_FLOWS.json")
        let existingFlows = { version: "1.0", flows: [] }
        if (fs.existsSync(flowsPath)) {
          try { existingFlows = JSON.parse(fs.readFileSync(flowsPath, "utf8")) } catch {}
        }
        existingFlows.flows.push(...recordedFlows)
        existingFlows.lastUpdated = new Date().toISOString()
        fs.writeFileSync(flowsPath, JSON.stringify(existingFlows, null, 2))
        console.log(`\n  Flows saved: ${flowsPath}`)
        for (const f of recordedFlows) {
          console.log(`    + "${f.name}" (${f.stepCount} steps, starts at ${f.startRoute})`)
        }
      }

      console.log("")
      console.log("=".repeat(60))

      // Clean up session file
      if (fs.existsSync(config.sessionFile)) fs.unlinkSync(config.sessionFile)

      await browser.close()
      resolveSession()
      return
    }

    if (cmd === "" || cmd === "enter") {
      if (pendingEvents.length === 0) {
        console.log("  (no interactions to record)")
        return
      }

      const currentSnapshot = await captureState(page, consoleErrorCount)
      const diff = computeDiff(lastSnapshot, currentSnapshot)
      const description = describeEvents(pendingEvents)
      const checks = inferChecksV2(diff, currentSnapshot)
      const landmark = pickLandmark(currentSnapshot.landmarks || {})
      const route = new URL(page.url()).pathname

      if (recordingFlow) {
        // ── Flow step mode ──
        const collapsed = collapseEvents(pendingEvents, config)
        const step = {
          stepNumber: currentFlowSteps.length + 1,
          route,
          description,
          actions: collapsed,
          rawEventCount: pendingEvents.length,
          landmark: landmark || undefined,
          stateAfter: currentSnapshot,
          verify: [],
          timestamp: Date.now(),
        }
        currentFlowSteps.push(step)

        console.log(`  FLOW STEP ${step.stepNumber}: ${description}`)
        console.log(`    Route: ${route}`)
        for (const action of collapsed) {
          const val = action.value ? ` "${action.value}"` : ""
          console.log(`    → ${action.type} ${action.selector || ""}${val}`)
        }
        if (landmark) {
          console.log(`    landmark: ${landmark.selector} "${landmark.text}"`)
        }
        console.log(`    (press [v] to add verify checks, [Enter] for next step)\n`)

        // Also record health if URL changed
        if (diff.urlChanged) {
          const healthObs = {
            id: `obs-${observations.length + 1}`,
            route,
            events: [],
            interactionDescription: `navigated to ${route}`,
            stateBefore: lastSnapshot,
            stateAfter: currentSnapshot,
            diff,
            inferredVerifyChecks: checks.filter(c =>
              ["no_js_errors", "no_console_errors", "no_error_alerts", "url_is", "landmark_visible"].includes(c.type)
            ),
            landmark: landmark || undefined,
            health: {
              route,
              landmark: landmark || undefined,
              checks: checks.filter(c =>
                ["no_js_errors", "no_console_errors", "no_error_alerts", "url_is", "landmark_visible"].includes(c.type)
              ),
            },
            isEdgeCase: false,
            timestamp: Date.now(),
          }
          observations.push(healthObs)
        }

      } else {
        // ── Health checkpoint mode ──
        const obs = {
          id: `obs-${observations.length + 1}`,
          route,
          events: [...pendingEvents],
          interactionDescription: description,
          stateBefore: lastSnapshot,
          stateAfter: currentSnapshot,
          diff,
          inferredVerifyChecks: checks,
          landmark: landmark || undefined,
          health: {
            route,
            landmark: landmark || undefined,
            checks: checks.filter(c =>
              ["no_js_errors", "no_console_errors", "no_error_alerts", "url_is", "landmark_visible"].includes(c.type)
            ),
          },
          isEdgeCase: false,
          timestamp: Date.now(),
        }

        observations.push(obs)
        lastCapabilityId = obs.id

        // Find matching capability
        const match = findMatch(model, obs)
        if (match) {
          console.log(`  RECORDED: matches ${match.feature}.${match.capability} (will upgrade)`)
        } else {
          console.log(`  RECORDED: new capability on ${obs.route}`)
        }

        // Show landmark
        if (landmark) {
          console.log(`  HEALTH: ${route} — landmark: ${landmark.selector} "${landmark.text}"`)
        }

        // Show inferred checks
        for (const check of checks) {
          console.log(`    + ${check.type}${check.selector ? ` (${check.selector})` : ""}: ${check.reason}`)
        }
        console.log("")
      }

      pendingEvents = []
      lastSnapshot = currentSnapshot
    }

    if (cmd === "s" || cmd === "skip") {
      pendingEvents = []
      skippedCount++
      lastSnapshot = await captureState(page, consoleErrorCount)
      console.log("  Skipped. State reset.\n")
    }

    if (cmd === "n" || cmd.startsWith("n ")) {
      const name = cmd === "n" ? null : cmd.slice(2).trim()
      if (!name) {
        rl.question("  Name this capability: ", (answer) => {
          if (answer.trim() && observations.length > 0) {
            observations[observations.length - 1].userLabel = answer.trim()
            console.log(`  Renamed to: ${answer.trim()}\n`)
          }
        })
      } else if (observations.length > 0) {
        observations[observations.length - 1].userLabel = name
        console.log(`  Renamed to: ${name}\n`)
      }
    }

    if (cmd === "e") {
      if (pendingEvents.length === 0) {
        console.log("  (no interactions to record as edge case)")
        return
      }
      if (!lastCapabilityId) {
        console.log("  (no parent capability — record a normal capability first)")
        return
      }

      const currentSnapshot = await captureState(page, consoleErrorCount)
      const diff = computeDiff(lastSnapshot, currentSnapshot)
      const description = describeEvents(pendingEvents)
      const checks = inferChecks(diff)

      const obs = {
        id: `obs-${observations.length + 1}`,
        route: new URL(page.url()).pathname,
        events: [...pendingEvents],
        interactionDescription: description,
        stateBefore: lastSnapshot,
        stateAfter: currentSnapshot,
        diff,
        inferredVerifyChecks: checks,
        isEdgeCase: true,
        edgeCaseOf: lastCapabilityId,
        timestamp: Date.now(),
      }

      observations.push(obs)
      pendingEvents = []
      lastSnapshot = currentSnapshot

      console.log(`  EDGE CASE recorded for last capability`)
      console.log("")
    }
  })

  // Also resolve if stdin closes unexpectedly (e.g. pipe closed)
  rl.on("close", () => {
    clearInterval(poller)
    clearInterval(autoSave)
    browser.close().catch(() => {})
    resolveSession()
  })

  }) // end of await new Promise
}

// ─── Event Collapsing ────────────────────────────────────────────────────────

function collapseEvents(events, config = {}) {
  if (!events || events.length === 0) return []

  const actions = []

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]

    // Rule 1: Collapse sequential inputs on same selector → single fill
    if (ev.type === "input") {
      // Look ahead for more inputs on the same field
      let lastInput = ev
      while (i + 1 < events.length && events[i + 1].type === "input" && isSameField(events[i + 1], ev)) {
        i++
        lastInput = events[i]
      }

      const value = lastInput.value || ""
      const field = lastInput.field || guessFieldName(lastInput.selector)

      // Rule 6: Parameterize credentials
      let paramValue = value
      if (config.email && value === config.email) {
        paramValue = "$EMAIL"
      } else if (field && /password/i.test(field)) {
        paramValue = "$PASSWORD"
      }

      // Rule 2: Remove click-before-fill (check if previous action was click on same element)
      if (actions.length > 0) {
        const prev = actions[actions.length - 1]
        if (prev.type === "click" && isSameField(prev, ev)) {
          actions.pop() // remove the click
        }
      }

      actions.push({
        type: "fill",
        selector: bestSelector(lastInput),
        value: paramValue,
        field,
        ...buildFallbacks(lastInput),
      })
      continue
    }

    // Rule 4: Navigation → waitForURL
    if (ev.type === "navigation") {
      const pathname = ev.url ? new URL(ev.url).pathname : ev.value || ""
      actions.push({
        type: "waitForURL",
        value: pathname,
      })
      continue
    }

    // Rule 3: Remove submit-after-click
    if (ev.type === "submit") {
      if (actions.length > 0 && actions[actions.length - 1].type === "click") {
        // Skip the submit — the click already triggers it
        continue
      }
      actions.push({
        type: "submit",
        selector: bestSelector(ev),
        ...buildFallbacks(ev),
      })
      continue
    }

    // Click events
    if (ev.type === "click") {
      // Rule 2: Check if next event is an input on same field — if so, skip this click
      if (i + 1 < events.length && events[i + 1].type === "input" && isSameField(events[i + 1], ev)) {
        continue
      }

      // Rule 5: Prefer text selectors for buttons/links
      let selector = bestSelector(ev)
      if (ev.text && ev.tag && ["a", "button"].includes(ev.tag.toLowerCase())) {
        selector = `${ev.tag.toLowerCase()}:has-text('${ev.text.replace(/'/g, "\\'")}')`
      }

      actions.push({
        type: "click",
        selector,
        text: ev.text || undefined,
        ...buildFallbacks(ev),
      })
      continue
    }

    // Select/dropdown (custom or native)
    if (ev.type === "select_option" || (ev.type === "change" && ev.tag && ev.tag.toLowerCase() === "select")) {
      // Capture the trigger click that opened the dropdown (if it exists)
      let triggerSelector = null
      let triggerText = null
      if (actions.length > 0 && actions[actions.length - 1].type === "click") {
        const prevClick = actions[actions.length - 1]
        triggerSelector = prevClick.selector
        triggerText = prevClick.text
        actions.pop() // remove it — we'll embed it in the select action
      }
      // If no preceding click found (e.g., dropdown opened in a previous step),
      // use the trigger info captured by the event tracker from the DOM
      if (!triggerSelector && ev.triggerSelector) {
        triggerSelector = ev.triggerSelector
        triggerText = ev.triggerText || null
      }

      actions.push({
        type: "select",
        selector: bestSelector(ev),
        triggerSelector: triggerSelector || undefined,
        triggerText: triggerText || undefined,
        position: ev.position || 1,
        value: ev.value || "",
        field: ev.field || undefined,
        ...buildFallbacks(ev),
      })
      continue
    }

    // Keyboard press
    if (ev.type === "keydown" && ev.key && !["Shift", "Control", "Alt", "Meta"].includes(ev.key)) {
      actions.push({
        type: "press",
        key: ev.key,
        selector: bestSelector(ev),
      })
      continue
    }

    // Fallback: pass through unknown events as-is
    if (ev.type !== "keydown" && ev.type !== "keyup" && ev.type !== "focus" && ev.type !== "blur") {
      actions.push({
        type: ev.type,
        selector: bestSelector(ev),
        value: ev.value || undefined,
        ...buildFallbacks(ev),
      })
    }
  }

  return actions
}

function isSameField(a, b) {
  if (a.selector && b.selector && a.selector === b.selector) return true
  if (a.field && b.field && a.field === b.field) return true
  // Check if targeting same input by similar selector patterns
  if (a.selector && b.selector) {
    const aBase = a.selector.replace(/:nth-child\(\d+\)/, "").replace(/\.\S+/, "")
    const bBase = b.selector.replace(/:nth-child\(\d+\)/, "").replace(/\.\S+/, "")
    if (aBase === bBase && aBase.length > 3) return true
  }
  return false
}

function guessFieldName(selector) {
  if (!selector) return null
  const nameMatch = selector.match(/name="([^"]+)"/)
  if (nameMatch) return nameMatch[1]
  const idMatch = selector.match(/#([a-zA-Z][\w-]*)/)
  if (idMatch) return idMatch[1]
  const ariaMatch = selector.match(/aria-label="([^"]+)"/)
  if (ariaMatch) return ariaMatch[1]
  const placeholderMatch = selector.match(/placeholder="([^"]+)"/)
  if (placeholderMatch) return placeholderMatch[1]
  return null
}

// Rule 7: Generate selector fallbacks
function buildFallbacks(ev) {
  const fallbacks = []
  if (ev.testId) fallbacks.push(`[data-testid="${ev.testId}"]`)
  if (ev.ariaLabel) fallbacks.push(`[aria-label="${ev.ariaLabel}"]`)
  if (ev.text && ev.tag) fallbacks.push(`${ev.tag.toLowerCase()}:has-text('${ev.text.replace(/'/g, "\\'")}')`)
  if (ev.id) fallbacks.push(`#${ev.id}`)
  if (ev.href) fallbacks.push(`a[href="${ev.href}"]`)
  if (ev.selector) fallbacks.push(ev.selector) // original CSS as last resort

  if (fallbacks.length === 0) return {}
  return { selectorFallbacks: fallbacks }
}

function bestSelector(ev) {
  // Priority: data-testid > aria-label > id > text+tag > original CSS
  if (ev.testId) return `[data-testid="${ev.testId}"]`
  if (ev.ariaLabel) return `[aria-label="${ev.ariaLabel}"]`
  if (ev.id) return `#${ev.id}`
  return ev.selector || ""
}

// ─── State Capture ───────────────────────────────────────────────────────────

async function captureState(page, consoleErrorCount) {
  const elementCounts = {}

  for (const selector of MONITORED_SELECTORS) {
    try {
      elementCounts[selector] = await page.locator(selector).count()
    } catch {
      elementCounts[selector] = 0
    }
  }

  // Capture landmarks for page identity
  const landmarks = await page.evaluate(() => {
    const h1El = document.querySelector("h1")
    const h2El = document.querySelector("h2")
    const activeNavEl = document.querySelector('nav a.active, nav a[aria-current="page"], nav a[aria-current="true"]')

    const dataTestIds = Array.from(document.querySelectorAll("[data-testid]"))
      .map(el => el.getAttribute("data-testid"))
      .filter(Boolean)
      .slice(0, 20)

    const dataPages = Array.from(document.querySelectorAll("[data-page]"))
      .map(el => el.getAttribute("data-page"))
      .filter(Boolean)

    // Detect error alerts
    const errorAlerts = []
    for (const el of document.querySelectorAll('[role="alert"], .error, .text-red-500, .alert-danger, .alert-error')) {
      const text = el.textContent?.trim()
      if (text && /error|fail|unable|denied|invalid/i.test(text)) {
        errorAlerts.push(text.slice(0, 200))
      }
    }

    return {
      title: document.title || "",
      h1: h1El?.textContent?.trim() || "",
      h2: h2El?.textContent?.trim() || "",
      dataTestIds,
      dataPages,
      activeNav: activeNavEl?.textContent?.trim() || "",
      errorAlerts,
    }
  }).catch(() => ({
    title: "", h1: "", h2: "", dataTestIds: [], dataPages: [], activeNav: "", errorAlerts: [],
  }))

  // Capture some visible text
  const visibleTexts = await page.evaluate(() => {
    const texts = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent?.trim()
        if (!text || text.length < 2 || text.length > 200) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        const style = window.getComputedStyle(parent)
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let node
    while ((node = walker.nextNode()) && texts.length < 200) {
      texts.push(node.textContent.trim())
    }
    return texts
  }).catch(() => [])

  return {
    url: page.url(),
    route: new URL(page.url()).pathname,
    timestamp: Date.now(),
    elementCounts,
    visibleTexts,
    consoleErrorCount,
    landmarks,
  }
}

function pickLandmark(landmarks) {
  if (landmarks.dataPages.length > 0) {
    return { selector: `[data-page="${landmarks.dataPages[0]}"]`, text: landmarks.dataPages[0] }
  }
  if (landmarks.dataTestIds.length > 0) {
    return { selector: `[data-testid="${landmarks.dataTestIds[0]}"]`, text: landmarks.dataTestIds[0] }
  }
  if (landmarks.h1) {
    return { selector: "h1", text: landmarks.h1 }
  }
  if (landmarks.h2) {
    return { selector: "h2", text: landmarks.h2 }
  }
  if (landmarks.title) {
    return { selector: "title", text: landmarks.title }
  }
  return null
}

function computeDiff(before, after) {
  const elementChanges = []
  const allSelectors = new Set([
    ...Object.keys(before.elementCounts),
    ...Object.keys(after.elementCounts),
  ])

  for (const sel of allSelectors) {
    const b = before.elementCounts[sel] || 0
    const a = after.elementCounts[sel] || 0
    if (b !== a) elementChanges.push({ selector: sel, before: b, after: a })
  }

  const beforeTexts = new Set(before.visibleTexts)
  const afterTexts = new Set(after.visibleTexts)

  return {
    urlChanged: before.url !== after.url,
    oldUrl: before.url,
    newUrl: after.url,
    elementChanges,
    newTexts: after.visibleTexts.filter((t) => !beforeTexts.has(t)).slice(0, 20),
    removedTexts: before.visibleTexts.filter((t) => !afterTexts.has(t)).slice(0, 20),
    consoleErrorsDelta: after.consoleErrorCount - before.consoleErrorCount,
  }
}

function inferChecks(diff) {
  const checks = []

  if (diff.urlChanged) {
    checks.push({ type: "url_changed", reason: `URL changed to ${new URL(diff.newUrl).pathname}` })
  }

  for (const change of diff.elementChanges) {
    if (change.before === 0 && change.after > 0) {
      checks.push({ type: "element_appeared", selector: change.selector, reason: `${change.selector}: 0 -> ${change.after}` })
    } else if (change.before > 0 && change.after === 0) {
      checks.push({ type: "element_disappeared", selector: change.selector, reason: `${change.selector}: ${change.before} -> 0` })
    } else {
      checks.push({ type: "element_count_changed", selector: change.selector, reason: `${change.selector}: ${change.before} -> ${change.after}` })
    }
  }

  for (const text of diff.newTexts.slice(0, 3)) {
    if (/success|saved|created|updated|deleted/i.test(text)) {
      checks.push({ type: "toast_appeared", reason: `Success message: "${text.slice(0, 60)}"` })
      break
    }
  }

  if (diff.consoleErrorsDelta === 0) {
    checks.push({ type: "no_errors", reason: "No new console errors" })
  }

  return checks
}

function inferChecksV2(diff, afterState) {
  const checks = []
  const landmarks = afterState.landmarks || {}

  // Tier 1: Page Alive
  checks.push({ type: "no_js_errors", reason: "No uncaught JS errors" })
  checks.push({ type: "no_console_errors", reason: `Console errors: ${afterState.consoleErrorCount || 0}` })

  if (landmarks.errorAlerts && landmarks.errorAlerts.length > 0) {
    checks.push({ type: "has_error_alerts", reason: `Error alerts visible: "${landmarks.errorAlerts[0].slice(0, 60)}"` })
  } else {
    checks.push({ type: "no_error_alerts", reason: "No error alerts visible" })
  }

  // Tier 2: Right Page — URL + landmark
  if (diff.urlChanged) {
    const pathname = new URL(diff.newUrl).pathname
    checks.push({ type: "url_is", value: pathname, reason: `URL changed to ${pathname}` })
  }

  const landmark = pickLandmark(landmarks)
  if (landmark) {
    checks.push({
      type: "landmark_visible",
      selector: landmark.selector,
      text: landmark.text,
      reason: `Page identity: ${landmark.selector} "${landmark.text}"`,
    })
  }

  // Tier 3: Functional — detect toasts and dialogs
  const toastText = diff.newTexts.find(t => /success|saved|created|updated|deleted|sent|added|removed/i.test(t))
  if (toastText) {
    checks.push({ type: "toast_contains", value: toastText.slice(0, 100), reason: `Toast: "${toastText.slice(0, 60)}"` })
  }

  // Check for dialog appearance
  const dialogAppeared = diff.elementChanges.find(c => c.selector === '[role="dialog"]' && c.before === 0 && c.after > 0)
  if (dialogAppeared) {
    checks.push({ type: "element_exists", selector: '[role="dialog"]', reason: "Dialog opened" })
  }
  const dialogClosed = diff.elementChanges.find(c => c.selector === '[role="dialog"]' && c.before > 0 && c.after === 0)
  if (dialogClosed) {
    checks.push({ type: "element_gone", selector: '[role="dialog"]', reason: "Dialog closed" })
  }

  return checks
}

// ─── Matching ────────────────────────────────────────────────────────────────

function findMatch(model, obs) {
  const obsRoute = obs.route

  for (const [fname, feature] of Object.entries(model.features)) {
    if (feature.route !== obsRoute && !obsRoute.startsWith(feature.route + "/")) continue

    for (const [cname, cap] of Object.entries(feature.capabilities)) {
      // Check user label
      if (obs.userLabel && obs.userLabel.toLowerCase() === cname.toLowerCase()) {
        return { feature: fname, capability: cname }
      }

      // Score based on verify type overlap
      const capTypes = new Set(Object.values(cap.verify).map((v) => v.type))
      const obsTypes = new Set(obs.inferredVerifyChecks.map((c) => c.type))
      let score = 0, total = 0
      for (const t of obsTypes) { total++; if (capTypes.has(t)) score++ }
      if (total > 0 && score / total >= 0.3) return { feature: fname, capability: cname }
    }
  }

  return null
}

// ─── Merge ───────────────────────────────────────────────────────────────────

function mergeIntoModel(model, observations, sessionNumber) {
  const updated = JSON.parse(JSON.stringify(model))
  const result = { updated: [], added: [], edgeCasesAdded: [], unchanged: 0 }

  const normal = observations.filter((o) => !o.isEdgeCase)
  const edgeCases = observations.filter((o) => o.isEdgeCase)

  for (const obs of normal) {
    const match = findMatchInModel(updated, obs)
    if (match) {
      const changes = upgradeCapability(match.cap, obs)
      if (changes.length > 0) {
        result.updated.push({ feature: match.fname, capability: match.cname, changes })
      } else {
        result.unchanged++
      }
    } else {
      addNewCapability(updated, obs)
      const fname = routeToFeatureName(obs.route)
      result.added.push({ feature: fname, capability: obs.userLabel || guessCapName(obs) })
    }
  }

  for (const obs of edgeCases) {
    const parentObs = obs.edgeCaseOf ? normal.find((o) => o.id === obs.edgeCaseOf) : null
    let parentMatch = parentObs ? findMatchInModel(updated, parentObs) : null
    if (!parentMatch) parentMatch = findClosest(updated, obs.route)

    if (parentMatch) {
      if (!parentMatch.cap.edge_cases) parentMatch.cap.edge_cases = []
      const verify = {}
      for (const check of obs.inferredVerifyChecks) {
        const name = check.selector ? check.selector.replace(/[^a-z0-9]/gi, "_").slice(0, 30) : check.type
        verify[name] = { type: check.type, ...(check.selector && { selector: check.selector }) }
      }
      parentMatch.cap.edge_cases.push({
        name: obs.userLabel || `edge_case_${Date.now()}`,
        interaction: obs.interactionDescription,
        verify,
      })
      parentMatch.cap._confidence = "edge_cased"
      result.edgeCasesAdded.push({
        feature: parentMatch.fname,
        capability: parentMatch.cname,
        name: obs.userLabel || "edge_case",
      })
    }
  }

  // Write health blocks per feature from landmark data
  for (const obs of normal) {
    if (!obs.health || !obs.health.landmark) continue
    const fname = routeToFeatureName(obs.route)
    if (!updated.features[fname]) continue

    const feature = updated.features[fname]
    // Only write health block if it doesn't exist or if we have a better landmark
    if (!feature.health || !feature.health.landmark) {
      feature.health = {
        route: obs.health.route,
        landmark: obs.health.landmark,
        checks: obs.health.checks.map(c => {
          const entry = { type: c.type }
          if (c.value) entry.value = c.value
          if (c.selector) entry.selector = c.selector
          if (c.text) entry.text = c.text
          return entry
        }),
      }
    }
  }

  updated.meta = updated.meta || {}
  updated.meta.learn_sessions = sessionNumber
  updated.meta.last_session = new Date().toISOString()

  return { model: updated, result }
}

function findMatchInModel(model, obs) {
  for (const [fname, feature] of Object.entries(model.features)) {
    if (feature.route !== obs.route && !obs.route.startsWith(feature.route + "/")) continue
    for (const [cname, cap] of Object.entries(feature.capabilities)) {
      if (obs.userLabel && obs.userLabel.toLowerCase() === cname.toLowerCase()) {
        return { fname, cname, cap }
      }
      const capTypes = new Set(Object.values(cap.verify || {}).map((v) => v.type))
      const obsTypes = new Set(obs.inferredVerifyChecks.map((c) => c.type))
      let score = 0, total = 0
      for (const t of obsTypes) { total++; if (capTypes.has(t)) score++ }
      if (total > 0 && score / total >= 0.3) return { fname, cname, cap }
    }
  }
  return null
}

function findClosest(model, route) {
  for (const [fname, feature] of Object.entries(model.features)) {
    if (feature.route !== route && !route.startsWith(feature.route + "/")) continue
    const [cname, cap] = Object.entries(feature.capabilities)[0] || []
    if (cname) return { fname, cname, cap }
  }
  return null
}

function upgradeCapability(cap, obs) {
  const changes = []
  const oldConf = cap._confidence || "init"

  // Replace guessed interaction
  if ((oldConf === "init" || oldConf === "migrated") && obs.interactionDescription) {
    cap.interaction = obs.interactionDescription
    changes.push("interaction: replaced guess with observed")
  }

  // Merge verify checks
  for (const check of obs.inferredVerifyChecks) {
    const exists = Object.values(cap.verify || {}).some(
      (v) => v.type === check.type && v.selector === check.selector
    )
    if (!exists) {
      const name = check.selector
        ? check.selector.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").slice(0, 30)
        : check.type
      if (!cap.verify) cap.verify = {}
      cap.verify[name] = { type: check.type, ...(check.selector && { selector: check.selector }) }
      changes.push(`+ verify.${name}: ${check.type}`)
    }
  }

  // Merge test data
  for (const event of obs.events || []) {
    if (event.type === "input" && event.value && event.value !== "***") {
      if (!cap.test_data) cap.test_data = {}
      const key = event.field || "input"
      const existing = cap.test_data[key]
      if (existing === "TODO") {
        cap.test_data[key] = event.value
        changes.push(`+ test_data.${key}: "${event.value}"`)
      } else if (typeof existing === "string" && existing !== event.value) {
        cap.test_data[key] = [existing, event.value]
        changes.push(`+ test_data.${key}: added "${event.value}"`)
      } else if (Array.isArray(existing) && !existing.includes(event.value)) {
        existing.push(event.value)
        changes.push(`+ test_data.${key}: added "${event.value}"`)
      }
    }
  }

  // Update metadata
  cap._observed = (cap._observed || 0) + 1
  const observed = cap._observed
  const hasEdge = (cap.edge_cases?.length || 0) > 0
  const newConf = hasEdge ? "edge_cased"
    : observed >= 4 ? "stable"
    : observed >= 3 ? "observed_3x"
    : observed >= 2 ? "observed_2x"
    : observed >= 1 ? "observed_1x"
    : oldConf
  cap._confidence = newConf

  if (newConf !== oldConf) changes.push(`confidence: ${oldConf} -> ${newConf}`)
  return changes
}

function addNewCapability(model, obs) {
  const fname = routeToFeatureName(obs.route)
  const cname = obs.userLabel || guessCapName(obs)

  if (!model.features[fname]) {
    model.features[fname] = {
      description: `${fname.replace(/_/g, " ")} page`,
      route: obs.route,
      requires: [],
      capabilities: {},
    }
  }

  const verify = {}
  for (const check of obs.inferredVerifyChecks) {
    const name = check.selector
      ? check.selector.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").slice(0, 30)
      : check.type
    verify[name] = { type: check.type, ...(check.selector && { selector: check.selector }) }
  }

  const testData = {}
  for (const event of obs.events || []) {
    if (event.type === "input" && event.value && event.value !== "***") {
      testData[event.field || "input"] = event.value
    }
  }

  model.features[fname].capabilities[cname] = {
    interaction: obs.interactionDescription,
    expected: buildExpected(obs.diff),
    verify,
    ...(Object.keys(testData).length > 0 && { test_data: testData }),
    _confidence: "observed_1x",
    _observed: 1,
  }
}

function buildExpected(diff) {
  const expected = []
  if (diff.urlChanged) expected.push(`page navigates to ${new URL(diff.newUrl).pathname}`)
  for (const c of (diff.elementChanges || []).slice(0, 3)) {
    if (c.before === 0 && c.after > 0) expected.push(`${c.selector} appears`)
    else if (c.before > 0 && c.after === 0) expected.push(`${c.selector} disappears`)
    else expected.push(`${c.selector} count changes`)
  }
  if (expected.length === 0) expected.push("action completes without errors")
  return expected
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

function displayEvents(events) {
  for (const e of events) {
    if (e.type === "click") {
      const target = e.text ? `"${e.text}"` : e.selector
      console.log(`  You clicked: ${e.tag || "element"} ${target}`)
    } else if (e.type === "input") {
      const val = e.value === "***" ? "(password)" : `"${e.value}"`
      console.log(`  You typed: ${val} in ${e.field || e.selector}`)
    } else if (e.type === "select_option") {
      console.log(`  You selected: option ${e.position || "?"} in ${e.field || "dropdown"}`)
    } else if (e.type === "submit") {
      console.log("  You submitted: form")
    } else if (e.type === "navigation") {
      console.log(`  Navigation: ${new URL(e.url).pathname}`)
    }
  }
}

function describeEvents(events) {
  const parts = []
  for (const e of events) {
    if (e.type === "click") {
      parts.push(`click ${e.tag || "element"} ${e.text ? `"${e.text}"` : e.selector}`)
    } else if (e.type === "input") {
      parts.push(`type ${e.value === "***" ? "(password)" : `"${e.value}"`} in ${e.field || e.selector}`)
    } else if (e.type === "submit") {
      parts.push("submit form")
    } else if (e.type === "select_option") {
      parts.push(`select option ${e.position || "?"} in ${e.field || "dropdown"}`)
    } else if (e.type === "navigation") {
      parts.push(`navigate to ${new URL(e.url).pathname}`)
    }
  }
  // Dedupe consecutive
  const deduped = []
  for (const p of parts) {
    if (deduped[deduped.length - 1] !== p) deduped.push(p)
  }
  return deduped.join(", ")
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function routeToFeatureName(route) {
  const cleaned = route.replace(/^\/home\//, "").replace(/^\/app\//, "").replace(/^\//, "").replace(/\/$/, "")
  if (!cleaned) return "home"
  const last = cleaned.split("/").filter(Boolean).pop() || "home"
  return last.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()
}

function guessCapName(obs) {
  const events = obs.events || []
  const hasClick = events.some((e) => e.type === "click")
  const hasInput = events.some((e) => e.type === "input")
  const hasSubmit = events.some((e) => e.type === "submit")
  if (hasSubmit && hasInput) return "submit_form"
  if (hasInput) return "filter"
  if (hasClick) {
    const click = events.find((e) => e.type === "click")
    const text = (click?.text || "").toLowerCase()
    if (text.includes("add") || text.includes("create")) return "create"
    if (text.includes("edit") || text.includes("update")) return "edit"
    if (text.includes("delete") || text.includes("remove")) return "delete"
    if (text.includes("filter")) return "filter"
    if (text.includes("search")) return "search"
    if (text.includes("sort")) return "sort"
  }
  return `action_${obs.id.replace("obs-", "")}`
}

async function authenticate(page, email, password) {
  try {
    const emailInput = page.locator("input[type='email'], input[name='email'], input[type='text'][name*='user']")
    const passInput = page.locator("input[type='password']")
    if ((await emailInput.count()) === 0 || (await passInput.count()) === 0) return
    await emailInput.first().fill(email)
    await passInput.first().fill(password)
    const submit = page.locator("button[type='submit'], input[type='submit']")
    if ((await submit.count()) > 0) await submit.first().click()
    else await passInput.first().press("Enter")
    await page.waitForURL((u) => !u.pathname.includes("login") && !u.pathname.includes("sign-in"), { timeout: 10000 }).catch(() => {})
  } catch { /* auth failed */ }
}

function saveSession(session) {
  try {
    fs.writeFileSync(config.sessionFile, JSON.stringify(session, null, 2))
  } catch { /* write failed */ }
}

function saveToHistory(session) {
  const dir = ".qa-learn-history"
  fs.mkdirSync(dir, { recursive: true })
  const filename = `session-${session.sessionNumber}-${Date.now()}.json`
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(session, null, 2))
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
