const test = require("node:test")
const assert = require("node:assert/strict")
const { createRequestGuard } = require("../request-guard")
const { taskFor } = require("./fixture-portal")

const origin = "http://127.0.0.1:1"
const policy = taskFor(origin, "s").requestPolicy

test("blocked paths are refused in every phase, including during login", () => {
  const guard = createRequestGuard(policy)
  assert.deepEqual(guard.decide({ url: `${origin}/s/integration-clients/abc`, method: "GET", resourceType: "document" }), { allow: false, category: "detail" })
  assert.deepEqual(guard.decide({ url: `${origin}/s/api/secret/abc`, method: "GET", resourceType: "fetch" }), { allow: false, category: "secret" })
  assert.deepEqual(guard.decide({ url: `${origin}/s/rotate/abc`, method: "POST", resourceType: "fetch" }), { allow: false, category: "mutation" })
  assert.equal(guard.counts.attempted, 3)
})

test("login phase allows the login form and the list; list phase allows only GET list reads", () => {
  const guard = createRequestGuard(policy)
  assert.deepEqual(guard.decide({ url: `${origin}/s/login`, method: "POST", resourceType: "document" }), { allow: true })
  assert.deepEqual(guard.decide({ url: `${origin}/s/integration-clients?page=2`, method: "GET", resourceType: "document" }), { allow: true })
  guard.setPhase("list")
  assert.deepEqual(guard.decide({ url: `${origin}/s/login`, method: "POST", resourceType: "document" }), { allow: false, category: "mutation" })
  assert.deepEqual(guard.decide({ url: `${origin}/s/integration-clients?page=2`, method: "GET", resourceType: "document" }), { allow: true })
  assert.deepEqual(guard.decide({ url: `${origin}/s/anything-else`, method: "GET", resourceType: "fetch" }), { allow: false, category: "unreviewed" })
  assert.deepEqual(guard.decide({ url: "https://other.example/s/integration-clients", method: "GET", resourceType: "document" }), { allow: false, category: "unreviewed" })
})

test("selected detail grants only its exact document GET and cannot bypass secret or mutation blocks", () => {
  const guard = createRequestGuard(policy)
  const selected = `${origin}/s/integration-clients/target`
  guard.setPhase("list")
  assert.equal(guard.decide({ url: selected, method: "GET", resourceType: "document" }).allow, false)
  guard.setDetailUrl(selected)
  assert.equal(guard.decide({ url: selected, method: "GET", resourceType: "document" }).allow, true)
  for (const request of [
    { url: selected, method: "POST", resourceType: "document" },
    { url: selected, method: "GET", resourceType: "fetch" },
    { url: selected + "?other=true", method: "GET", resourceType: "document" },
    { url: `${origin}/s/integration-clients/other`, method: "GET", resourceType: "document" },
    { url: `${origin}/s/integration-clients`, method: "GET", resourceType: "document" },
  ]) assert.equal(guard.decide(request).allow, false)
  for (const path of ["secret", "%73ecret", "rotate"]) {
    const url = `${origin}/s/integration-clients/${path}`
    guard.setDetailUrl(url)
    assert.equal(guard.decide({ url, method: "GET", resourceType: "document" }).allow, false)
  }
})
