// task/runner.js
//
// Strict task execution for provisioning probes. One fresh browser per run, request
// guards installed before the first navigation, exact record matching across every advertised
// page, one extracted value delivered to an awaited callback, and sanitized outcomes. There is no
// selector healing or first-match fallback. Screenshots are opt-in and masked; trace, HAR,
// console and storage capture are disabled.

const { TaskFailure } = require("./errors")
const { createRequestGuard } = require("./request-guard")
const { validateTask, validateInputs } = require("./validate")

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SETTLE_MS = 300

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runTask(options) {
  const startedAt = Date.now()
  const task = validateTask(options.task)
  const inputIssues = validateInputs(task, options.parameters, options.sensitiveInputs)
  if (inputIssues.length) {
    const code = inputIssues.some(issue => issue.startsWith("parameter")) ? "missing_parameter" : "missing_sensitive_input"
    const { TaskValidationError } = require("./errors")
    const error = new TaskValidationError(inputIssues)
    error.code = code
    throw error
  }
  const hooks = options.hooks || {}
  const signal = options.signal
  const headless = !(options.browser && options.browser.headless === false)
  const guard = createRequestGuard(task.requestPolicy)
  const samples = []
  const sensitive = Object.values(options.sensitiveInputs || {}).filter(Boolean).map(value => value.toLowerCase())
  const staticSegments = new Set([...task.requestPolicy.login, ...task.requestPolicy.list]
    .flatMap(rule => (rule.pathExact || rule.pathPrefix || "").split("/")))
  const sampleBlocked = (request, category) => {
    if (!task.checkpoint || samples.length >= 10) return
    let origin = "external"
    let path = "/:redacted"
    try {
      const url = new URL(request.url)
      const containsSensitive = value => sensitive.some(input => value.toLowerCase().includes(input))
      if ([...task.origins.login, ...task.origins.list].includes(url.origin) && !containsSensitive(url.origin)) origin = url.origin
      const segments = url.pathname.split("/").filter(Boolean)
      path = "/" + segments.slice(0, 12).map((segment, index) => {
        const decoded = decodeURIComponent(segment)
        const staticSegment = /^[a-z_-]{1,24}$/i.test(decoded) && staticSegments.has(decoded)
        const stylesheet = origin !== "external" && request.resourceType === "stylesheet" &&
          index === segments.length - 1 && /^[A-Za-z][A-Za-z._-]{0,100}\.css$/.test(decoded)
        return (staticSegment || stylesheet) && !containsSensitive(decoded) ? decoded : ":redacted"
      }).join("/")
    } catch (error) {
      // Invalid URL/encoding has no useful safe structure; retain only the redacted marker.
      path = "/:redacted"
    }
    samples.push({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "other",
      resourceType: ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other"].includes(request.resourceType) ? request.resourceType : "other",
      category, origin, path,
    })
  }
  const decide = request => {
    const decision = guard.decide(request)
    if (!decision.allow) sampleBlocked(request, decision.category)
    return decision
  }
  const state = {
    stage: "launching",
    pagesScanned: 0,
    recordsSeen: 0,
    matchCount: 0,
    advertisedTotal: null,
    outputs: task.checkpoint ? {} : { [task.output.name]: "not_delivered" },
    cleanup: "closed",
    popupsClosed: 0,
  }
  const emit = stage => {
    state.stage = stage
    if (typeof hooks.onEvent === "function") hooks.onEvent({ type: "stage", stage })
  }
  const fail = code => new TaskFailure(code, state.stage)
  const expectedPgid = String(options.parameters[task.match.pgid.parameter])

  let browserServer = null
  let stopped = false
  let workSettled = false
  let browser = null
  let context = null
  let mutationDispatched = false
  let postMutationFailure = null
  let cancelled = signal ? signal.aborted : false
  const onAbort = () => {
    cancelled = true
    if (mutationDispatched) return
    stopped = true
    if (context) context.close().catch(() => {})
  }
  if (signal) signal.addEventListener("abort", onAbort, { once: true })

  const work = async () => {
    const { chromium } = require("playwright")
    emit("launching")
    try {
      if (cancelled) throw fail("cancelled")
      browserServer = await chromium.launchServer({ headless, timeout: task.limits.actionTimeoutMs })
      if (typeof hooks.onBrowserProcess === "function") await hooks.onBrowserProcess(browserServer.process().pid)
      if (stopped) throw fail("cancelled")
      browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: task.limits.actionTimeoutMs })
      if (stopped) throw fail("cancelled")
    } catch {
      throw fail("browser_launch_failed")
    }
    context = await browser.newContext({
      ...(task.viewport ? { viewport: task.viewport } : {}),
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      javaScriptEnabled: true,
    })
    context.setDefaultTimeout(task.limits.actionTimeoutMs)
    let pendingRedirect = null
    const followRedirects = async page => {
      for (let hops = 0; pendingRedirect; hops += 1) {
        if (hops >= 10 || stopped) throw fail("navigation_failed")
        const next = pendingRedirect
        pendingRedirect = null
        await page.goto(next, { waitUntil: "domcontentloaded" })
      }
    }
    await context.route("**/*", async route => {
      const request = route.request()
      const decision = decide({ url: request.url(), method: request.method(), resourceType: request.resourceType() })
      if (!decision.allow) return route.abort("blockedbyclient")
      let frame
      try { frame = request.frame() } catch (error) { frame = null }
      if (!mainPage || frame !== mainPage.mainFrame()) {
        guard.reject("unreviewed_frame")
        sampleBlocked({ url: request.url(), method: request.method(), resourceType: request.resourceType() }, "unreviewed_frame")
        return route.abort("blockedbyclient")
      }
      try {
        // Browser-native redirect hops bypass Playwright routing. Fetch just this checked hop;
        // document redirects become fresh navigations, and every other redirect fails closed.
        if (decision.mutation) {
          if (stopped || guard.counts.attempted > 0) return route.abort("blockedbyclient")
          mutationDispatched = true
          emit("mutation_dispatched")
        }
        const response = await route.fetch({ maxRedirects: 0, timeout: task.limits.actionTimeoutMs })
        const status = response.status()
        const location = response.headers().location
        if (status >= 300 && status < 400 && location) {
          const next = new URL(location, request.url()).href
          const method = status === 303 || ((status === 301 || status === 302) && request.method() === "POST")
            ? "GET" : request.method()
          const allowed = decide({ url: next, method, resourceType: request.resourceType() }).allow
          if (!allowed || !request.isNavigationRequest() || request.frame() !== mainPage.mainFrame() || method !== "GET") {
            if (allowed) {
              guard.reject("unsupported_redirect")
              sampleBlocked({ url: next, method, resourceType: request.resourceType() }, "unsupported_redirect")
            }
            await route.abort("blockedbyclient")
          } else {
            pendingRedirect = next
            await route.fulfill({ status: 200, contentType: "text/html", body: "" })
          }
        } else {
          await route.fulfill({ response })
        }
        await response.dispose()
      } catch (error) {
        await route.abort("failed").catch(() => {})
      }
    })
    await context.routeWebSocket("**/*", socket => {
      guard.reject("unreviewed_websocket")
      sampleBlocked({ url: socket.url(), method: "GET", resourceType: "websocket" }, "unreviewed_websocket")
      socket.close()
    })
    let mainPage = null
    context.on("page", page => {
      // Any page the task did not open itself (popups, window.open) is closed unread.
      if (mainPage && page !== mainPage) {
        state.popupsClosed += 1
        page.close().catch(() => {})
      }
    })
    mainPage = await context.newPage()
    if (cancelled) throw fail("cancelled")
    const capture = async (stage, target) => {
      const config = task.screenshots && task.screenshots[stage]
      if (!config) return
      if (typeof hooks.onScreenshot !== "function") throw fail("screenshot_delivery_failed")
      const masks = [mainPage.locator('input,textarea,select,[contenteditable]:not([contenteditable="false"])')]
      for (const value of Object.values(options.sensitiveInputs || {})) {
        if (value) masks.push(mainPage.getByText(value, { exact: false }))
      }
      for (const selector of config.requiredMaskSelectors) {
        const required = (target || mainPage).locator(selector)
        let visible = false
        for (let index = 0; index < await required.count(); index += 1) {
          if (await required.nth(index).isVisible()) { visible = true; break }
        }
        if (!visible) throw fail("screenshot_mask_missing")
        masks.push(mainPage.locator(selector))
      }
      if (stage === "details_opened" && task.output.source === "details") {
        const field = task.details.clientId
        const target = field.selector ? mainPage.locator(field.selector) :
          mainPage.getByText(field.labelText, { exact: true }).locator("xpath=..")
        if (await target.count() !== 1 || !(await target.isVisible())) throw fail("screenshot_mask_missing")
        masks.push(target)
      }
      if (stopped) throw fail("cancelled")
      let png
      try {
        const screenshotOptions = { type: "png", mask: masks, animations: "disabled" }
        png = target ? await target.screenshot(screenshotOptions) : await mainPage.screenshot({ ...screenshotOptions, fullPage: true })
      } catch (error) {
        throw fail("screenshot_capture_failed")
      }
      if (stopped) throw fail("cancelled")
      try {
        await hooks.onScreenshot({ stage, png })
      } catch (error) {
        throw fail("screenshot_delivery_failed")
      }
    }

    emit("navigating")
    try {
      await mainPage.goto(task.startUrl, { waitUntil: "domcontentloaded" })
      await followRedirects(mainPage)
    } catch {
      throw fail("navigation_failed")
    }
    await authenticate(mainPage, task, options.sensitiveInputs, emit, fail, () => cancelled, followRedirects, () => capture("login"))
    guard.setPhase("list")
    emit("authenticated")
    await capture("authenticated_list")
    if (task.checkpoint === "authenticated_list") {
      state.completedCheckpoint = task.checkpoint
      state.listStructure = {}
      for (const name of ["integrationName", "status", "pgid"]) {
        const field = task.list.fields[name]
        const labels = field.labelText ? mainPage.getByText(field.labelText, { exact: true }) : mainPage.locator(field.selector)
        const count = await labels.count()
        state.listStructure[name] = { count }
        const describeLabel = (label, includeDisplay) => {
          const knownTags = new Set(["html", "body", "main", "section", "article", "div", "span", "p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "label", "h1", "h2", "h3", "nav", "input", "button", "a", "form", "strong", "b", "dt", "dd", "dl"])
          const tag = element => element ? (knownTags.has(element.localName) ? element.localName : "other") : null
          const ancestors = []
          for (let parent = label.parentElement; parent && ancestors.length < 5; parent = parent.parentElement) {
            const display = getComputedStyle(parent).display
            ancestors.push({ tag: tag(parent), ...(includeDisplay ? {
              display: ["none", "contents", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "table", "table-row", "table-cell", "list-item"].includes(display) ? display : "other",
            } : {}), classes: Array.from(parent.classList)
              .filter(value => /^(?:row|container(?:-(?:fluid|sm|md|lg|xl|xxl))?|col(?:-(?:xs|sm|md|lg|xl|xxl))?(?:-(?:auto|[1-9]|1[0-2]))?)$/.test(value)).slice(0, 10) })
          }
          return { tag: tag(label), ancestors, nextSiblingTag: tag(label.nextElementSibling) }
        }
        if (count > 0) {
          const { ancestors, nextSiblingTag } = await labels.first().evaluate(describeLabel)
          const lastLabelStructure = await labels.last().evaluate(describeLabel, true)
          const knownNames = ["integrationName", "status", "pgid"]
          if (knownNames.every(fieldName => task.list.fields[fieldName].labelText)) {
            let ancestor = labels.last()
            for (const structure of lastLabelStructure.ancestors) {
              ancestor = ancestor.locator("xpath=..")
              structure.knownLabelCounts = {}
              for (const fieldName of knownNames) {
                structure.knownLabelCounts[fieldName] = await ancestor.getByText(task.list.fields[fieldName].labelText, { exact: true }).count()
              }
            }
          }
          Object.assign(state.listStructure[name], { ancestors, nextSiblingTag, lastLabelStructure })
        }
      }
      const candidates = mainPage.locator(task.list.recordSelector)
      const candidateCount = await candidates.count()
      let visibleCount = 0
      for (let index = 0; index < candidateCount; index += 1) {
        if (await candidates.nth(index).isVisible()) visibleCount += 1
      }
      state.listStructure.recordCandidates = { count: candidateCount, visibleCount }
      if (candidateCount > 0) {
        const firstDisplay = await candidates.first().evaluate(element => {
          const display = getComputedStyle(element).display
          return ["none", "contents", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "table", "table-row", "table-cell", "list-item"].includes(display) ? display : "other"
        })
        const descendants = candidates.first().locator("*")
        const descendantCount = await descendants.count()
        let firstHasVisibleDescendant = false
        for (let index = 0; index < descendantCount; index += 1) {
          if (await descendants.nth(index).isVisible()) {
            firstHasVisibleDescendant = true
            break
          }
        }
        Object.assign(state.listStructure.recordCandidates, { firstDisplay, firstHasVisibleDescendant })
      }
      const totals = mainPage.getByText(/^Total\s+\d+\s+items$/)
      const count = await totals.count()
      state.listStructure.totalItems = { count }
      if (count > 0) Object.assign(state.listStructure.totalItems, await totals.first().evaluate(element => ({
        tag: ["div", "span", "p", "label", "small"].includes(element.localName) ? element.localName : "other",
        classes: Array.from(element.classList).filter(value => /^(?:row|container(?:-(?:fluid|sm|md|lg|xl|xxl))?|col(?:-(?:xs|sm|md|lg|xl|xxl))?(?:-(?:auto|[1-9]|1[0-2]))?)$/.test(value)).slice(0, 10),
      })))
      return
    }

    emit("scanning")
    const scan = await scanList(mainPage, task, expectedPgid, state, fail)
    if (scan.matches.length === 0) throw fail("target_not_found")
    if (scan.matches.length > 1) throw fail("duplicate_target")
    const match = scan.matches[0]
    if (match.status !== task.match.status) throw fail("target_inactive")
    if (match.integrationName !== task.match.integrationName) throw fail("target_wrong_integration")

    emit("revalidating")
    const record = await returnToRecord(mainPage, task, match, scan.currentPage, fail)
    const current = await readRecord(record, task, fail)
    if (current.pgid !== match.pgid || current.status !== match.status || current.integrationName !== match.integrationName) {
      throw fail("record_revalidation_failed")
    }

    await capture("matched_client", record)
    if (task.checkpoint === "matched_client") {
      state.completedCheckpoint = task.checkpoint
      return
    }

    let outputRecord = record
    let outputField = task.list.fields.clientId
    let detailUrl
    if (task.checkpoint === "details_opened" || task.output.source === "details") {
      const { details } = task
      const links = record.locator(details.linkSelector)
      const visible = []
      for (let index = 0; index < await links.count(); index += 1) {
        if (await links.nth(index).isVisible()) visible.push(links.nth(index))
      }
      if (visible.length !== 1) throw fail("detail_link_ambiguous")
      const link = visible[0]
      if (!(await link.evaluate(element => element.localName === "a"))) throw fail("detail_destination_invalid")
      const href = await link.getAttribute("href")
      let destination
      try {
        destination = new URL(href || "", mainPage.url())
      } catch (error) {
        throw fail("detail_destination_invalid")
      }
      const prefix = details.pathPrefix.replace(/\/+$/, "")
      if (!href || destination.origin !== new URL(mainPage.url()).origin || !task.origins.list.includes(destination.origin) ||
          destination.search || destination.hash || destination.username || destination.password ||
          !(destination.pathname === prefix || destination.pathname.startsWith(prefix + "/"))) {
        throw fail("detail_destination_invalid")
      }
      if (stopped) throw fail("cancelled")
      emit("opening_details")
      guard.setDetailUrl(destination.href)
      try {
        await link.click()
        await followRedirects(mainPage)
        await mainPage.waitForLoadState("domcontentloaded")
      } catch (error) {
        throw fail("navigation_failed")
      }
      if (mainPage.url() !== destination.href) throw fail("detail_destination_invalid")
      for (const marker of details.markers) {
        try {
          await mainPage.locator(marker).first().waitFor({ state: "visible" })
        } catch (error) {
          throw fail("detail_markers_missing")
        }
      }
      if (await readField(mainPage, details.pgid, fail) !== expectedPgid) throw fail("detail_pgid_mismatch")
      if (mainPage.url() !== destination.href) throw fail("detail_destination_invalid")
      await capture("details_opened")
      if (task.checkpoint === "details_opened") {
        state.completedCheckpoint = task.checkpoint
        return
      }
      outputRecord = mainPage
      if (details.expect && await readField(mainPage, details.expect.field, fail) !== options.sensitiveInputs[details.expect.sensitiveInput]) throw fail("detail_expected_mismatch")
      if (details.actions) {
        const integrationId = await readField(mainPage, details.integrationId, fail)
        if (!/^[A-Za-z0-9_-]+$/.test(integrationId) || !/^[A-Za-z0-9_-]+$/.test(expectedPgid)) throw fail("detail_integration_mismatch")
        guard.setActionBindings({ integrationId, pgid: expectedPgid })
        guard.setPhase("action")
        emit("acting")
        for (const [index, action] of details.actions.entries()) {
          let actionExpired = false
          const perform = async () => {
            if (!mutationDispatched && stopped) throw fail("cancelled")
            if (!mutationDispatched && guard.counts.attempted > 0) throw fail("prohibited_request_attempted")
            const target = mainPage.locator(action.selector)
            await target.waitFor({ state: "visible", timeout: task.limits.actionTimeoutMs })
            if (await target.count() !== 1 || !(await target.isVisible())) throw fail("action_failed")
            if (typeof hooks.onBeforeAction === "function") await hooks.onBeforeAction({ index, type: action.type, mutation: action.mutation === true })
            if (actionExpired || (stopped && !mutationDispatched)) throw fail("cancelled")
            if (action.mutation) {
              if (typeof hooks.onBeforeMutation !== "function") throw fail("mutation_authorization_failed")
              try { await hooks.onBeforeMutation() } catch (error) { throw fail("mutation_authorization_failed") }
              if (stopped || actionExpired) throw fail("cancelled")
              if (guard.counts.attempted > 0) throw fail("prohibited_request_attempted")
              // Recheck the identity after awaiting the durable authorization acknowledgement.
              if (mainPage.url() !== destination.href || await readField(mainPage, details.pgid, fail) !== expectedPgid ||
                  await readField(mainPage, details.integrationId, fail) !== integrationId ||
                  await readField(mainPage, details.expect.field, fail) !== options.sensitiveInputs[details.expect.sensitiveInput]) throw fail("detail_expected_mismatch")
              guard.armAction()
            }
            if (actionExpired || (stopped && !mutationDispatched)) throw fail("cancelled")
            if (action.type !== "waitFor") await target.click({ timeout: task.limits.actionTimeoutMs })
          }
          try {
            await withTimeout(perform(), task.limits.actionTimeoutMs, () => { actionExpired = true; return fail("action_failed") })
          } catch (error) {
            if (!mutationDispatched) throw error instanceof TaskFailure ? error : fail("action_failed")
            // Preserve the action failure while still delivering an irreversibly changed value.
            postMutationFailure = error instanceof TaskFailure ? error : fail("action_failed")
            break
          }
        }
        if (!mutationDispatched) throw fail("mutation_not_dispatched")
      }
      outputField = details[task.output.field]
      detailUrl = destination.href
    }

    emit("extracting")
    let value = ""
    const validOutput = candidate => task.output.format === "uuid" ? UUID.test(candidate) :
      candidate.length === task.output.format.exactLength && !task.output.format.rejectValues.includes(candidate)
    const readOutput = async () => {
      do {
        const raw = await readField(outputRecord, outputField, fail)
        value = task.output.format === "uuid" ? raw.trim() : raw
        if (!mutationDispatched || validOutput(value)) return
        await sleep(50)
      } while (!stopped)
    }
    await withTimeout(readOutput(), task.limits.actionTimeoutMs, () => fail("output_invalid"))
    if (detailUrl && mainPage.url() !== detailUrl) throw fail("detail_destination_invalid")
    if (!value) throw fail("output_missing")
    if (!validOutput(value)) throw fail("output_invalid")

    if (stopped && !mutationDispatched) throw fail("cancelled")
    if (guard.counts.attempted > 0 && !mutationDispatched) throw fail("prohibited_request_attempted")
    emit("delivering")
    if (stopped && !mutationDispatched) throw fail("cancelled")
    if (typeof hooks.onSensitiveOutput !== "function") throw fail("output_delivery_failed")
    try {
      await hooks.onSensitiveOutput({ runId: options.execution.runId, outputId: task.output.name, value })
    } catch {
      throw fail("output_delivery_failed")
    }
    if (stopped && !mutationDispatched) throw fail("cancelled")
    state.outputs[task.output.name] = "delivered"
    if (postMutationFailure) throw postMutationFailure
  }

  let outcome
  const workPromise = work().finally(() => { workSettled = true })
  try {
    try {
      await withTimeout(workPromise, task.limits.totalTimeoutMs, () => fail("total_timeout"))
    } catch (error) {
      if (!(error instanceof TaskFailure) || error.code !== "total_timeout" || !mutationDispatched) throw error
      const deliveryGraceMs = Math.min(60000, task.limits.actionTimeoutMs * (task.details.actions.length + 2))
      await withTimeout(workPromise, deliveryGraceMs, () => fail("total_timeout"))
    }
    outcome = { status: "succeeded", code: "ok" }
  } catch (error) {
    if (cancelled && !mutationDispatched) outcome = { status: "cancelled", code: "cancelled" }
    else if (error instanceof TaskFailure) outcome = { status: "failed", code: error.code }
    else if (error && error.code === "invalid_task") throw error
    else outcome = { status: "failed", code: "unexpected_error", errorName: "Error" }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort)
    emit("cleanup")
    stopped = true
    state.cleanup = await cleanup(browserServer, task.limits.cleanupTimeoutMs)
    if (!workSettled) {
      try {
        await withTimeout(workPromise.catch(() => {}), task.limits.cleanupTimeoutMs, () => fail("cleanup_failed"))
      } catch (error) {
        state.cleanup = "failed"
      }
      if (browserServer) state.cleanup = await cleanup(browserServer, task.limits.cleanupTimeoutMs)
      if (!workSettled) state.cleanup = "failed"
    }
    emit("done")
  }

  if (state.cleanup === "failed") outcome = { status: "failed", code: "cleanup_failed" }
  if (outcome.status === "succeeded" && guard.counts.attempted > 0 && !mutationDispatched) {
    outcome = { status: "failed", code: "prohibited_request_attempted" }
  }
  return {
    status: outcome.status,
    code: outcome.code,
    errorName: outcome.errorName,
    stage: state.stage,
    completedCheckpoint: state.completedCheckpoint,
    elapsedMs: Date.now() - startedAt,
    pagesScanned: state.pagesScanned,
    recordsSeen: state.recordsSeen,
    matchCount: state.matchCount,
    advertisedTotal: state.advertisedTotal,
    ...(state.listStructure ? { listStructure: state.listStructure } : {}),
    blockedRequests: { attempted: guard.counts.attempted, byCategory: { ...guard.counts.byCategory },
      ...(task.checkpoint ? { samples } : {}) },
    ...(task.details?.actions ? { mutationDispatched } : {}),
    dispatchedProhibited: 0,
    popupsClosed: state.popupsClosed,
    outputs: { ...state.outputs },
    cleanup: state.cleanup,
  }
}

async function cleanup(server, timeoutMs) {
  if (!server) return "closed"
  try {
    await withTimeout(server.close(), timeoutMs, () => new Error("close timeout"))
    return "closed"
  } catch (error) {
    try {
      await withTimeout(server.kill(), timeoutMs, () => new Error("kill timeout"))
      return "forced"
    } catch (killError) {
      return "failed"
    }
  }
}

function onOrigins(page, origins) {
  try {
    return origins.includes(new URL(page.url()).origin)
  } catch {
    return false
  }
}

async function isOnList(page, task) {
  if (!onOrigins(page, task.origins.list)) return false
  let path
  try {
    path = new URL(page.url()).pathname
  } catch {
    return false
  }
  if (!path.startsWith(task.list.pathPrefix)) return false
  for (const marker of task.list.markers) {
    const visible = await page.locator(marker).first().isVisible().catch(() => false)
    if (!visible) return false
  }
  return true
}

async function authenticate(page, task, sensitiveInputs, emit, fail, isCancelled, followRedirects, captureLogin) {
  let attempted = false
  let announcedManual = false
  let capturedManual = false
  let timeoutCode = "login_timeout"
  let expired = false
  emit("login")
  const waitForLogin = async () => {
    while (!expired) {
      if (isCancelled()) throw fail("cancelled")
      await followRedirects(page)
      if (expired) return
      if (await isOnList(page, task)) return
      const onLoginOrigin = onOrigins(page, [task.auth.loginOrigin])
      if (!onOrigins(page, [...task.origins.login, ...task.origins.list])) throw fail("unexpected_origin")
      if (task.auth.mode === "env") {
        if (onLoginOrigin && !attempted) {
          const username = page.locator(task.auth.usernameSelector)
          const password = page.locator(task.auth.passwordSelector)
          const submit = page.locator(task.auth.submitSelector)
          const counts = await Promise.all([username.count(), password.count(), submit.count()])
          if (counts.some(count => count > 1)) throw fail("login_form_ambiguous")
          timeoutCode = "login_form_ambiguous"
          const ready = counts.every(count => count === 1) &&
            (await Promise.all([username.isVisible(), password.isVisible(), submit.isVisible()])).every(Boolean)
          if (ready) {
            if (expired) return
            await captureLogin()
            if (expired) return
            await username.fill(sensitiveInputs[task.auth.usernameInput])
            if (expired) return
            await password.fill(sensitiveInputs[task.auth.passwordInput])
            if (expired) return
            attempted = true
            timeoutCode = "login_failed"
            await submit.click()
          }
        } else if (attempted) {
          // Transitional authorize/callback pages and delayed list rendering may take the
          // full readiness budget. Never submit credentials again, even on a rejected form.
          const formStillPresent = (await page.locator(task.auth.passwordSelector).count()) > 0
          timeoutCode = formStillPresent ? "login_failed" :
            onOrigins(page, task.origins.login) ? "login_challenge" : "unexpected_page"
        }
      } else {
        if (!announcedManual) {
          announcedManual = true
          emit("awaiting_manual_login")
        }
        if (task.screenshots && task.screenshots.login && !capturedManual && onLoginOrigin && await page.locator(task.auth.passwordSelector).first().isVisible()) {
          await captureLogin()
          capturedManual = true
        }
      }
      await sleep(SETTLE_MS)
    }
  }
  await withTimeout(waitForLogin(), task.auth.maxWaitMs, () => {
    expired = true
    return fail(timeoutCode)
  })
}

async function readField(record, locator, fail) {
  let target
  if (locator.selector) {
    target = record.locator(locator.selector)
  } else {
    const label = record.getByText(locator.labelText, { exact: true })
    if ((await label.count()) !== 1) throw fail("record_field_ambiguous")
    target = label.locator("xpath=following-sibling::*[1]")
  }
  if ((await target.count()) !== 1) throw fail("record_field_ambiguous")
  return locator.value ? target.inputValue() : (await target.innerText()).trim()
}

async function readRecord(record, task, fail) {
  const { fields } = task.list
  return {
    integrationName: await readField(record, fields.integrationName, fail),
    status: await readField(record, fields.status, fail),
    pgid: await readField(record, fields.pgid, fail),
  }
}

async function visibleRecords(page, task) {
  const all = page.locator(task.list.recordSelector)
  const count = await all.count()
  const visible = []
  for (let index = 0; index < count; index += 1) {
    const record = all.nth(index)
    if (await record.isVisible()) visible.push({ record, index })
  }
  return visible
}

async function clickNext(page, task, fail) {
  const { nextSelector } = task.list.pagination
  if (!nextSelector) return false
  const next = page.locator(nextSelector)
  const count = await next.count()
  if (count === 0) return false
  if (count !== 1) throw fail("pagination_ambiguous")
  const disabled = (await next.getAttribute("aria-disabled")) === "true" || (await next.isDisabled().catch(() => false))
  if (disabled || !(await next.isVisible())) return false
  await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), next.click()])
  await sleep(SETTLE_MS)
  return true
}

async function scanList(page, task, expectedPgid, state, fail) {
  const { pagination } = task.list
  const matches = []
  const signatures = new Set()
  let pageNumber = 1
  for (;;) {
    if (!(await isOnList(page, task))) throw fail("list_markers_missing")
    if (pageNumber === 1 && pagination.advertisedTotalSelector) {
      const total = page.locator(pagination.advertisedTotalSelector)
      if ((await total.count()) !== 1) throw fail("advertised_count_invalid")
      const text = (await total.innerText()).trim()
      const matched = (pagination.advertisedTotalFormat === "total_items" ? /^Total\s+(\d+)\s+items$/ : /^(\d+)$/).exec(text)
      if (!matched || !Number.isSafeInteger(Number(matched[1]))) throw fail("advertised_count_invalid")
      state.advertisedTotal = Number(matched[1])
    }
    const records = await visibleRecords(page, task)
    const rows = []
    for (const { record, index } of records) {
      const fields = await readRecord(record, task, fail)
      rows.push({ ...fields, index, pageNumber })
    }
    const signature = rows.map(row => `${row.pgid}|${row.status}|${row.integrationName}`).join("\n")
    if (signatures.has(signature) && rows.length > 0) throw fail("pagination_repeated")
    signatures.add(signature)
    state.pagesScanned = pageNumber
    state.recordsSeen += rows.length
    for (const row of rows) if (row.pgid === expectedPgid) matches.push(row)
    state.matchCount = matches.length

    if (pageNumber >= pagination.maxPages) {
      if (await clickNext(page, task, fail)) throw fail("pagination_incomplete")
      break
    }
    if (!(await clickNext(page, task, fail))) break
    pageNumber += 1
  }
  if (state.advertisedTotal !== null && state.advertisedTotal !== state.recordsSeen) throw fail("list_count_mismatch")
  return { matches, currentPage: pageNumber }
}

async function returnToRecord(page, task, match, currentPage, fail) {
  if (currentPage !== match.pageNumber) {
    try {
      await page.goto(task.startUrl, { waitUntil: "domcontentloaded" })
    } catch {
      throw fail("navigation_failed")
    }
    for (let pageNumber = 1; pageNumber < match.pageNumber; pageNumber += 1) {
      if (!(await clickNext(page, task, fail))) throw fail("record_revalidation_failed")
    }
  }
  if (!(await isOnList(page, task))) throw fail("record_revalidation_failed")
  const records = await visibleRecords(page, task)
  const found = records.find(entry => entry.index === match.index)
  if (!found) throw fail("record_revalidation_failed")
  return found.record
}

module.exports = { runTask }
