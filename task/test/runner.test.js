const test = require("node:test")
const assert = require("node:assert/strict")
const { runTask } = require("../index.js")
const { startFixturePortal, taskFor, USERNAME, PASSWORD } = require("./fixture-portal")

let portal
const outputs = []
const stages = []
const logged = []

function run(scenario, extra = {}) {
  const task = taskFor(portal.origin, scenario, extra.mode || "env")
  if (extra.checkpoint) task.checkpoint = extra.checkpoint
  if (extra.viewport) task.viewport = extra.viewport
  if (extra.screenshots) task.screenshots = extra.screenshots
  if (extra.source) task.output.source = extra.source
  if (extra.checkpoint === "details_opened" || extra.source === "details") task.details = {
    linkSelector: "a", pathPrefix: `/${scenario}/integration-clients/`,
    markers: ['h1:has-text("Client Details")'], pgid: { labelText: "PGID" },
    ...(extra.source === "details" ? { clientId: { labelText: "Client ID" } } : {}),
  }
  if (extra.totalFormat) task.list.pagination.advertisedTotalFormat = extra.totalFormat
  if (extra.maxPages) task.list.pagination.maxPages = extra.maxPages
  if (extra.actionTimeoutMs) task.limits.actionTimeoutMs = extra.actionTimeoutMs
  return runTask({
    execution: { runId: `run-${scenario}`, taskDigest: "sha256:test" },
    task,
    parameters: { PGID: "9876" },
    sensitiveInputs: extra.mode === "manual" ? {} : { PORTAL_USERNAME: USERNAME, PORTAL_PASSWORD: extra.password || PASSWORD, ...extra.sensitiveInputs },
    signal: extra.signal,
    browser: { headless: true },
    hooks: {
      onScreenshot: extra.onScreenshot,
      onEvent: event => { stages.push(`${scenario}:${event.stage}`); extra.onEvent?.(event) },
      onSensitiveOutput: async output => {
        outputs.push({ scenario, ...output })
        await extra.onOutput?.()
        if (extra.failDelivery) throw new Error("storage down")
      },
    },
  })
}

test.before(async () => {
  portal = await startFixturePortal()
  for (const stream of ["stdout", "stderr"]) {
    const original = process[stream].write.bind(process[stream])
    process[stream].write = (chunk, ...rest) => {
      logged.push(String(chunk))
      return original(chunk, ...rest)
    }
  }
})

test.after(async () => {
  await portal.close()
})

test("exact target among similar PGIDs is extracted and compared against the fixture, with zero prohibited requests", async () => {
  const result = await run("happy")
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.pagesScanned, 1)
  assert.equal(result.recordsSeen, 3)
  assert.equal(result.matchCount, 1)
  assert.equal(result.blockedRequests.attempted, 0)
  assert.equal(result.outputs.clientId, "delivered")
  assert.equal(result.blockedRequests.samples, undefined)
  assert.equal(result.listStructure, undefined)
  assert.equal(result.cleanup, "closed")
  const delivered = outputs.find(o => o.scenario === "happy")
  assert.equal(delivered.value, portal.expected("happy"))
  assert.equal(portal.prohibited("happy").length, 0)
  assert.ok(!JSON.stringify(result).includes(delivered.value))
})

test("target on a later page: the full scan completes and the record is revalidated before extraction", async () => {
  const result = await run("later_page")
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.pagesScanned, 2)
  assert.equal(outputs.find(o => o.scenario === "later_page").value, portal.expected("later_page"))
  assert.ok(stages.includes("later_page:revalidating"))
})

for (const [scenario, code] of [
  ["duplicate_later_page", "duplicate_target"],
  ["absent", "target_not_found"],
  ["inactive", "target_inactive"],
  ["wrong_integration", "target_wrong_integration"],
  ["broken_output", "record_field_ambiguous"],
  ["invalid_id", "output_invalid"],
  ["count_mismatch", "list_count_mismatch"],
  ["missing_count", "advertised_count_invalid"],
  ["malformed_count", "advertised_count_invalid"],
  ["navigation_failure", "navigation_failed"],
  ["login_fail", "login_failed"],
  ["missing_form", "login_form_ambiguous"],
  ["ambiguous_form", "login_form_ambiguous"],
  ["mfa", "login_challenge"],
]) {
  test(`${scenario} fails with ${code}, delivers nothing and reaches no prohibited route`, async () => {
    const result = await run(scenario)
    assert.equal(result.status, "failed")
    assert.equal(result.code, code, JSON.stringify(result))
    assert.equal(result.outputs.clientId, "not_delivered")
    assert.equal(outputs.filter(o => o.scenario === scenario).length, 0)
    assert.equal(portal.prohibited(scenario).length, 0)
    assert.equal(result.cleanup, "closed")
  })
}

test("hidden duplicate template is ignored; only visible records count", async () => {
  const result = await run("hidden_duplicate")
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.recordsSeen, 2)
  assert.equal(outputs.find(o => o.scenario === "hidden_duplicate").value, portal.expected("hidden_duplicate"))
})

for (const [scenario, category] of [["detail_prefetch", "detail"], ["mutation_on_load", "mutation"]]) {
  test(`${scenario}: the guard blocks the ${category} request before dispatch and the run is not a success`, async () => {
    const result = await run(scenario)
    assert.equal(result.status, "failed")
    assert.equal(result.code, "prohibited_request_attempted", JSON.stringify(result))
    assert.ok(result.blockedRequests.byCategory[category] >= 1)
    assert.equal(result.dispatchedProhibited, 0)
    assert.equal(portal.prohibited(scenario).length, 0)
  })
}

test("a popup to a detail page is closed and blocked", async () => {
  const result = await run("popup")
  assert.equal(result.status, "failed")
  assert.equal(result.code, "prohibited_request_attempted", JSON.stringify(result))
  assert.ok(result.popupsClosed >= 1)
  assert.equal(portal.prohibited("popup").length, 0)
})

test("manual login mode reports awaiting_manual_login and times out without a human", async () => {
  const result = await run("happy", { mode: "manual" })
  assert.equal(result.status, "failed")
  assert.equal(result.code, "login_timeout")
  assert.ok(stages.includes("happy:awaiting_manual_login"))
})

test("manual login mode continues once the human signs in and extracts without login inputs", async () => {
  const result = await run("manual_autologin", { mode: "manual" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.ok(stages.includes("manual_autologin:awaiting_manual_login"))
  assert.ok(stages.indexOf("manual_autologin:awaiting_manual_login") < stages.indexOf("manual_autologin:authenticated"))
  assert.equal(outputs.find(o => o.scenario === "manual_autologin").value, portal.expected("manual_autologin"))
  assert.equal(portal.events.filter(e => e.scenario === "manual_autologin" && e.kind === "login_ok").length, 1)
  assert.equal(portal.prohibited("manual_autologin").length, 0)
})

test("cancellation closes the browser and yields no result", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 400)
  const result = await run("happy", { signal: controller.signal })
  assert.equal(result.status, "cancelled")
  assert.equal(result.cleanup, "closed")
})

test("delivery failure is reported and the value is not retried into the result", async () => {
  const result = await run("happy", { failDelivery: true })
  assert.equal(result.status, "failed")
  assert.equal(result.code, "output_delivery_failed")
  assert.equal(result.outputs.clientId, "not_delivered")
})

test("canaries never reach stdout, stderr or any result object", () => {
  const text = logged.join("")
  assert.ok(!text.includes(PASSWORD))
  assert.ok(!text.includes(portal.expected("happy")))
})


test("an allowed document redirect is checked before its secret destination is dispatched", async () => {
  const result = await run("forbidden_redirect")
  assert.equal(result.status, "failed")
  assert.ok(result.blockedRequests.attempted > 0)
  assert.equal(portal.prohibited("forbidden_redirect").length, 0)
  assert.equal(outputs.filter(output => output.scenario === "forbidden_redirect").length, 0)
})

for (const checkpoint of ["authenticated_list", "matched_client"]) {
  test(`${checkpoint} completes without reading absent output fields or delivering sensitive values`, async () => {
    const result = await run("broken_output", { checkpoint })
    assert.equal(result.status, "succeeded", JSON.stringify(result))
    assert.equal(result.completedCheckpoint, checkpoint)
    assert.equal(result.stage, "done")
    assert.deepEqual(result.outputs, {})
    assert.equal(result.matchCount, checkpoint === "matched_client" ? 1 : 0)
    assert.equal(outputs.filter(o => o.scenario === "broken_output").length, 0)
    assert.equal(portal.prohibited("broken_output").length, 0)
    assert.equal(result.blockedRequests.attempted, 0)
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"))
  })
}

test("matched_client rejects duplicate matches across pages without extraction", async () => {
  const result = await run("duplicate_later_page", { checkpoint: "matched_client" })
  assert.equal(result.code, "duplicate_target")
  assert.equal(result.completedCheckpoint, undefined)
  assert.deepEqual(result.outputs, {})
})

test("authorize, delayed login, callback and delayed list finish within the readiness budget with one submission", async () => {
  const result = await run("delayed_auth", { checkpoint: "matched_client" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.completedCheckpoint, "matched_client")
  assert.equal(portal.events.filter(e => e.scenario === "delayed_auth" && e.kind === "login_ok").length, 1)
  assert.equal(outputs.filter(o => o.scenario === "delayed_auth").length, 0)
  assert.deepEqual(result.outputs, {})
})

test("rejected credentials are submitted once and stop within the readiness budget", () => {
  assert.equal(portal.events.filter(e => e.scenario === "login_fail" && e.kind === "login_rejected").length, 1)
})

test("cross-origin login form_post preserves response cookies through the guarded callback", async () => {
  const fixture = await startFixturePortal(true)
  try {
    const task = taskFor(fixture.origin, "happy")
    task.checkpoint = "matched_client"
    task.auth.loginOrigin = fixture.loginOrigin
    task.origins.login = [fixture.loginOrigin]
    task.requestPolicy.login.push(
      { origin: fixture.loginOrigin, methods: ["GET", "POST"], pathExact: "/happy/login" },
      { origin: fixture.origin, methods: ["POST"], pathExact: "/happy/callback" },
    )
    const result = await runTask({
      task, execution: { runId: "cross-origin", taskDigest: "fixture" },
      parameters: { PGID: "9876" },
      sensitiveInputs: { PORTAL_USERNAME: USERNAME, PORTAL_PASSWORD: PASSWORD },
      hooks: { onSensitiveOutput: async () => assert.fail("checkpoint extracted a value") },
    })
    assert.equal(result.status, "succeeded", JSON.stringify(result))
    assert.equal(result.completedCheckpoint, "matched_client")
    assert.equal(fixture.events.filter(e => e.kind === "login_ok").length, 1)
    assert.equal(fixture.events.filter(e => e.kind === "callback_ok").length, 1)
    assert.deepEqual(result.outputs, {})
    assert.equal(result.blockedRequests.attempted, 0)
    assert.equal(fixture.prohibited("happy").length, 0)
  } finally {
    await fixture.close()
  }
})

test("checkpoint diagnostics bound blocked samples and expose only safe field structure", async () => {
  const result = await run("diagnostics", { checkpoint: "authenticated_list" })
  assert.equal(result.completedCheckpoint, "authenticated_list")
  assert.equal(result.code, "prohibited_request_attempted")
  assert.equal(result.blockedRequests.samples.length, 10)
  assert.ok(result.blockedRequests.samples.some(sample => sample.origin === "external"))
  assert.ok(result.blockedRequests.samples.some(sample => sample.category === "mutation"))
  for (const sample of result.blockedRequests.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ["category", "method", "origin", "path", "resourceType"])
    assert.ok(sample.origin === portal.origin || sample.origin === "external")
    assert.ok(!sample.path.includes("?") && !sample.path.includes("#"))
    assert.ok(sample.path.length <= 312)
  }
  for (const name of ["integrationName", "status", "pgid"]) {
    const structure = result.listStructure[name]
    assert.equal(structure.count, 1)
    assert.equal(structure.nextSiblingTag, "span")
    assert.ok(structure.ancestors.length <= 5)
    assert.deepEqual(structure.ancestors[0], { tag: "div", classes: ["col-sm-4"] })
  }
  assert.deepEqual(result.listStructure.totalItems, { count: 1, tag: "p", classes: ["row"] })
  const diagnostics = JSON.stringify({ samples: result.blockedRequests.samples, listStructure: result.listStructure })
  for (const canary of [USERNAME, PASSWORD, portal.expected("happy"), "SYNTHETIC_SECRET", "SECRET_CANARY", "external-secret.example", "12345"]) {
    assert.ok(!diagnostics.includes(canary))
  }
  assert.deepEqual(result.outputs, {})
  assert.equal(outputs.filter(output => output.scenario === "diagnostics").length, 0)
  assert.equal(portal.prohibited("diagnostics").length, 0)
})

test("stylesheet diagnostics retain safe basenames and distinguish header from last record label", async () => {
  const result = await run("stylesheet_diagnostics", {
    checkpoint: "authenticated_list", sensitiveInputs: { DIAGNOSTIC_SECRET: "synthetic-secret" },
  })
  assert.equal(result.completedCheckpoint, "authenticated_list")
  assert.equal(result.code, "prohibited_request_attempted")
  const { samples } = result.blockedRequests
  assert.equal(samples.length, 7)
  assert.ok(samples.some(sample => sample.path === "/site.css" && sample.origin === portal.origin))
  assert.ok(samples.some(sample => sample.path === "/vendor.bundle.min.css"))
  assert.equal(samples.filter(sample => sample.path === "/:redacted").length, 5)
  assert.ok(samples.every(sample => sample.resourceType === "stylesheet"))
  for (const name of ["integrationName", "status", "pgid"]) {
    const structure = result.listStructure[name]
    assert.equal(structure.count, 2)
    assert.deepEqual(structure.ancestors[0], { tag: "div", classes: ["row"] })
    assert.equal(structure.lastLabelStructure.tag, "span")
    assert.equal(structure.lastLabelStructure.nextSiblingTag, "span")
    assert.ok(structure.lastLabelStructure.ancestors.length <= 5)
    assert.deepEqual(structure.lastLabelStructure.ancestors[0], {
      tag: "div", classes: ["col-sm-4"], display: "block",
      knownLabelCounts: { integrationName: 0, status: 0, pgid: 0, [name]: 1 },
    })
    assert.deepEqual(structure.lastLabelStructure.ancestors[1].knownLabelCounts, { integrationName: 1, status: 1, pgid: 1 })
  }
  const diagnostics = JSON.stringify({ samples, listStructure: result.listStructure })
  for (const canary of [USERNAME, PASSWORD, portal.expected("happy"), "SYNTHETIC_SECRET", "synthetic-secret", "SECRET_CANARY", "external-secret.example", "asset123", ".private"]) {
    assert.ok(!diagnostics.includes(canary))
  }
  assert.deepEqual(result.outputs, {})
  assert.equal(outputs.filter(output => output.scenario === "stylesheet_diagnostics").length, 0)
  assert.equal(portal.prohibited("stylesheet_diagnostics").length, 0)
})

test("details checkpoint opens only the revalidated record and stops without reading absent client ID", async () => {
  const result = await run("details_success", { checkpoint: "details_opened" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.completedCheckpoint, "details_opened")
  assert.deepEqual(result.outputs, {})
  assert.equal(result.blockedRequests.attempted, 0)
  assert.ok(stages.includes("details_success:opening_details"))
  const reached = portal.prohibited("details_success")
  assert.equal(reached.length, 1)
  assert.equal(reached[0].kind, "detail")
  assert.equal(reached[0].method, "GET")
  assert.equal(reached[0].path, "/details_success/integration-clients/target")
  assert.equal(outputs.filter(output => output.scenario === "details_success").length, 0)
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"))
})

for (const [scenario, code] of [
  ["details_wrong_pgid", "detail_pgid_mismatch"],
  ["details_missing_marker", "detail_markers_missing"],
  ["details_ambiguous_link", "detail_link_ambiguous"],
  ["details_query_link", "detail_destination_invalid"],
  ["details_external_link", "detail_destination_invalid"],
]) {
  test(`${scenario} refuses to complete the details checkpoint`, async () => {
    const result = await run(scenario, { checkpoint: "details_opened", actionTimeoutMs: 1000 })
    assert.equal(result.status, "failed")
    assert.equal(result.code, code)
    assert.equal(result.completedCheckpoint, undefined)
    assert.deepEqual(result.outputs, {})
    assert.equal(outputs.filter(output => output.scenario === scenario).length, 0)
  })
}

for (const scenario of ["details_other_redirect", "details_sensitive_redirect", "details_list_redirect", "details_requests"]) {
  test(`${scenario} blocks every unselected destination or sensitive request`, async () => {
    const result = await run(scenario, { checkpoint: "details_opened" })
    assert.equal(result.status, "failed")
    assert.ok(result.blockedRequests.attempted > 0)
    const reached = portal.prohibited(scenario)
    assert.equal(reached.length, 1)
    assert.equal(reached[0].path, `/${scenario}/integration-clients/target`)
    if (scenario === "details_requests") {
      for (const category of ["detail", "secret", "mutation"]) assert.ok(result.blockedRequests.byCategory[category] > 0)
    } else assert.equal(result.completedCheckpoint, undefined)
    assert.deepEqual(result.outputs, {})
    assert.equal(outputs.filter(output => output.scenario === scenario).length, 0)
  })
}

test("configured Total N items format checks complete counts and keeps strict parsing", async () => {
  const result = await run("total_items", { checkpoint: "matched_client", totalFormat: "total_items" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.advertisedTotal, 2)
  for (const [scenario, code, extra] of [
    ["total_mismatch", "list_count_mismatch", {}],
    ["total_incomplete", "pagination_incomplete", { maxPages: 1 }],
    ["total_invalid", "advertised_count_invalid", {}],
    ["happy", "advertised_count_invalid", {}],
  ]) {
    const failure = await run(scenario, { checkpoint: "matched_client", totalFormat: "total_items", ...extra })
    assert.equal(failure.code, code)
    assert.deepEqual(failure.outputs, {})
  }
  const defaultFormat = await run("total_items", { checkpoint: "matched_client" })
  assert.equal(defaultFormat.code, "advertised_count_invalid")
})

test("record diagnostics distinguish a contents wrapper with zero-box children from visible descendants", async () => {
  const result = await run("contents_record", { checkpoint: "authenticated_list" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.deepEqual(result.listStructure.recordCandidates, {
    count: 1, visibleCount: 0, firstDisplay: "contents", firstHasVisibleDescendant: true,
  })
  assert.ok(result.listStructure.pgid.lastLabelStructure.ancestors.some(ancestor => ancestor.display === "contents"))
  assert.equal(result.recordsSeen, 0)
  assert.deepEqual(result.outputs, {})
  const diagnostics = JSON.stringify(result.listStructure)
  for (const canary of [USERNAME, PASSWORD, portal.expected("happy"), "SYNTHETIC_SECRET"]) assert.ok(!diagnostics.includes(canary))
})

test("configured viewport exposes responsive labelled records without changing visibility rules", async () => {
  const defaultResult = await run("responsive_records", { checkpoint: "matched_client" })
  assert.equal(defaultResult.code, "list_count_mismatch")
  assert.equal(defaultResult.recordsSeen, 0)
  const result = await run("responsive_records", {
    checkpoint: "matched_client", viewport: { width: 700, height: 1000 },
  })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.completedCheckpoint, "matched_client")
  assert.equal(result.recordsSeen, 3)
  assert.equal(result.advertisedTotal, 3)
  assert.equal(result.matchCount, 1)
  assert.equal(result.blockedRequests.attempted, 0)
  assert.deepEqual(result.outputs, {})
  assert.equal(outputs.filter(output => output.scenario === "responsive_records").length, 0)
  assert.equal(portal.prohibited("responsive_records").length, 0)
})

test("opt-in screenshots mask sensitive pixels and are awaited at the four verified stages", async () => {
  const { PNG } = require("playwright-core/lib/utilsBundle")
  const captured = []
  const loginCount = portal.events.filter(event => event.scenario === "screenshots_flow" && event.kind === "login_ok").length
  const fieldMask = label => `:text-is("${label}") >> xpath=..`
  const screenshots = {
    login: { requiredMaskSelectors: [] },
    authenticated_list: { requiredMaskSelectors: [fieldMask("Auth Client ID")] },
    matched_client: { requiredMaskSelectors: [fieldMask("Auth Client ID")] },
    details_opened: { requiredMaskSelectors: ["Client ID", "Client Secret", "Subscription Key"].map(fieldMask) },
  }
  const result = await run("screenshots_flow", {
    checkpoint: "details_opened", screenshots,
    onScreenshot: async ({ stage, png }) => {
      assert.ok(Buffer.isBuffer(png))
      const decoded = PNG.sync.read(png)
      let pink = 0
      let red = 0
      for (let index = 0; index < decoded.data.length; index += 4) {
        const [r, g, b] = decoded.data.subarray(index, index + 3)
        if (r === 255 && g === 0 && b === 255) pink += 1
        if (r === 255 && g === 0 && b === 0) red += 1
      }
      assert.ok(pink > 0, `${stage}: expected masking pixels`)
      assert.equal(red, 0, `${stage}: a sensitive red block was not masked`)
      await new Promise(resolve => setTimeout(resolve, 20))
      if (stage === "login") {
        assert.equal(portal.events.filter(event => event.scenario === "screenshots_flow" && event.kind === "login_ok").length, loginCount)
      }
      captured.push({ stage, width: decoded.width, height: decoded.height })
    },
  })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.completedCheckpoint, "details_opened")
  assert.deepEqual(captured.map(capture => capture.stage), ["login", "authenticated_list", "matched_client", "details_opened"])
  assert.ok(captured[2].height < captured[1].height)
  assert.deepEqual(result.outputs, {})
  assert.equal(outputs.filter(output => output.scenario === "screenshots_flow").length, 0)
})

test("screenshots fail closed for missing or hidden required masks and rejected delivery", async () => {
  for (const selector of [".missing-mask", ".client-record[hidden]"]) {
    let captures = 0
    const result = await run("screenshots_flow", {
      checkpoint: "authenticated_list", screenshots: { authenticated_list: { requiredMaskSelectors: [selector] } },
      onScreenshot: async () => { captures += 1 },
    })
    assert.equal(result.code, "screenshot_mask_missing")
    assert.equal(captures, 0)
    assert.deepEqual(result.outputs, {})
  }
  let attempts = 0
  const rejected = await run("screenshots_flow", {
    checkpoint: "authenticated_list", screenshots: { login: { requiredMaskSelectors: [] } },
    onScreenshot: async () => { attempts += 1; throw new Error("fixture sink unavailable") },
  })
  assert.equal(rejected.code, "screenshot_delivery_failed")
  assert.equal(attempts, 1)
  const missingHook = await run("screenshots_flow", {
    checkpoint: "authenticated_list", screenshots: { login: { requiredMaskSelectors: [] } },
  })
  assert.equal(missingHook.code, "screenshot_delivery_failed")
})

test("screenshot stages stop with the requested checkpoint and stay disabled by default", async () => {
  const captured = []
  const result = await run("screenshots_flow", {
    checkpoint: "authenticated_list",
    screenshots: {
      authenticated_list: { requiredMaskSelectors: ['.field:has(.label:text-is("Auth Client ID"))'] },
      matched_client: { requiredMaskSelectors: [".missing-mask"] },
      details_opened: { requiredMaskSelectors: [".missing-mask"] },
    },
    onScreenshot: async ({ stage }) => { captured.push(stage) },
  })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.deepEqual(captured, ["authenticated_list"])
  const disabled = await run("broken_output", {
    checkpoint: "matched_client", onScreenshot: async () => assert.fail("screenshots are disabled"),
  })
  assert.equal(disabled.status, "succeeded")
})

test("details source reads the verified later-page detail field without a list Client ID", async () => {
  const before = outputs.length
  const result = await run("details_output", { source: "details" })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(result.pagesScanned, 2)
  assert.equal(result.completedCheckpoint, undefined)
  assert.equal(result.blockedRequests.attempted, 0)
  assert.equal(result.outputs.clientId, "delivered")
  assert.equal(outputs[before].value, portal.expected("details_output"))
  assert.deepEqual(portal.prohibited("details_output").map(({ kind, path }) => ({ kind, path })), [
    { kind: "detail", path: "/details_output/integration-clients/target" },
  ])
  assert.ok(!JSON.stringify(result).includes(outputs[before].value))
})

for (const [scenario, code] of [
  ["details_wrong_pgid", "detail_pgid_mismatch"],
  ["details_external_link", "detail_destination_invalid"],
  ["details_list_redirect", "detail_destination_invalid"],
  ["details_missing_output", "record_field_ambiguous"],
  ["details_duplicate_output", "record_field_ambiguous"],
  ["details_invalid_output", "output_invalid"],
  ["details_requests", "prohibited_request_attempted"],
]) {
  test(`details extraction ${scenario} fails without list fallback or delivered output`, async () => {
    const before = outputs.length
    const result = await run(scenario, { source: "details" })
    assert.equal(result.status, "failed", JSON.stringify(result))
    assert.equal(result.code, code, JSON.stringify(result))
    assert.equal(result.outputs.clientId, "not_delivered")
    assert.equal(outputs.length, before)
    assert.equal(result.cleanup, "closed")
    assert.equal(portal.prohibited(scenario).filter(({ kind }) => kind !== "detail").length, 0)
  })
}

test("detail output delivery failure is reported without retry", async () => {
  const before = outputs.length
  const result = await run("details_output", { source: "details", failDelivery: true })
  assert.equal(result.code, "output_delivery_failed", JSON.stringify(result))
  assert.equal(result.outputs.clientId, "not_delivered")
  assert.equal(outputs.length, before + 1)
})

test("cancelling at detail extraction prevents output and closes the browser", async () => {
  const controller = new AbortController()
  const before = outputs.length
  const result = await run("details_output", {
    source: "details", signal: controller.signal,
    onEvent: event => { if (event.stage === "extracting") controller.abort() },
  })
  assert.equal(result.status, "cancelled", JSON.stringify(result))
  assert.equal(result.cleanup, "closed")
  assert.equal(outputs.length, before)
})

test("details source automatically masks its output field before screenshot delivery", async () => {
  const { PNG } = require("playwright-core/lib/utilsBundle")
  let captured = 0
  const result = await run("details_output", {
    source: "details",
    screenshots: { details_opened: { requiredMaskSelectors: ['input[type="password"]'] } },
    onScreenshot: async ({ stage, png }) => {
      assert.equal(stage, "details_opened")
      const decoded = PNG.sync.read(png)
      let pink = 0
      for (let index = 0; index < decoded.data.length; index += 4) {
        const [r, g, b] = decoded.data.subarray(index, index + 3)
        assert.ok(!(r === 255 && g === 0 && b === 0), "unmasked sensitive block")
        if (r === 255 && g === 0 && b === 255) pink++
      }
      assert.ok(pink > 0)
      captured++
    },
  })
  assert.equal(result.status, "succeeded", JSON.stringify(result))
  assert.equal(captured, 1)
})

for (const timing of ["delivering_event", "awaited_callback"]) {
  test(`details cancellation at ${timing} cannot report delivered success`, async () => {
    const controller = new AbortController()
    const before = outputs.length
    const result = await run("details_output", {
      source: "details", signal: controller.signal,
      onEvent: event => { if (timing === "delivering_event" && event.stage === "delivering") controller.abort() },
      onOutput: async () => { if (timing === "awaited_callback") { controller.abort(); await Promise.resolve() } },
    })
    assert.equal(result.status, "cancelled", JSON.stringify(result))
    assert.equal(result.outputs.clientId, "not_delivered")
    assert.equal(outputs.length, before + (timing === "awaited_callback" ? 1 : 0))
    assert.equal(result.cleanup, "closed")
  })
}
