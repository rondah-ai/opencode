// task/request-guard.js
//
// Decides, before dispatch, whether a browser request may leave the owned context. Blocked rules
// win over allow rules except the explicitly selected detail document; secret and mutation
// blocks always win. After login only list reads and that exact GET document may be sent. Pure and
// synchronous so it can be unit tested without a browser.

const PHASES = Object.freeze(["login", "list", "action"])

function matchesAllow(rule, request) {
  if (rule.origin !== request.origin) return false
  if (!rule.methods.includes(request.method)) return false
  if (rule.pathExact !== undefined && rule.pathExact !== request.path) return false
  if (rule.pathPrefix !== undefined && !request.path.startsWith(rule.pathPrefix)) return false
  if (rule.resourceTypes !== undefined && !rule.resourceTypes.includes(request.resourceType)) return false
  return true
}

function createRequestGuard(policy) {
  const blocked = policy.blocked.map(rule => ({ regex: new RegExp(rule.pathRegex, "i"), category: rule.category }))
  const counts = { attempted: 0, byCategory: {} }
  let phase = "login"
  let detailUrl = null
  let actionBindings = null
  let actionArmed = false
  let actionCount = 0
  const actionRules = policy.action || []
  const actionPrefixes = actionRules.map(rule => rule.pathTemplate.slice(0, rule.pathTemplate.indexOf("{")))

  function count(category) {
    counts.attempted += 1
    counts.byCategory[category] = (counts.byCategory[category] || 0) + 1
  }

  return {
    get phase() {
      return phase
    },
    setPhase(next) {
      if (!PHASES.includes(next)) throw new Error("unknown guard phase")
      phase = next
    },
    setDetailUrl(url) {
      detailUrl = url
    },
    setActionBindings(bindings) {
      if (![bindings.integrationId, bindings.pgid].every(value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value))) throw new Error("invalid action bindings")
      actionBindings = { ...bindings }
    },
    armAction() {
      if (phase !== "action" || !actionBindings || counts.attempted > 0 || actionCount > 0) throw new Error("action cannot be armed")
      actionArmed = true
    },
    counts,
    reject: count,
    /**
     * @param {{ url: string, method: string, resourceType: string }} request
     * @returns {{ allow: true } | { allow: false, category: string }}
     */
    decide(request) {
      let parsed
      try {
        parsed = new URL(request.url)
      } catch {
        count("unreviewed")
        return { allow: false, category: "unreviewed" }
      }
      const method = String(request.method || "GET").toUpperCase()
      const shaped = { origin: parsed.origin, path: parsed.pathname, method, resourceType: request.resourceType || "other" }
      const selectedDetail = phase === "list" && parsed.href === detailUrl && method === "GET" && shaped.resourceType === "document"
      let decodedPath
      try {
        decodedPath = decodeURIComponent(shaped.path)
      } catch (error) {
        count("unreviewed")
        return { allow: false, category: "unreviewed" }
      }
      for (const rule of blocked) {
        if ((rule.regex.test(shaped.path) || rule.regex.test(decodedPath)) && !(selectedDetail && rule.category === "detail")) {
          count(rule.category)
          return { allow: false, category: rule.category }
        }
      }
      const actionRule = actionRules.find(rule => actionBindings && rule.origin === parsed.origin &&
        parsed.pathname === rule.pathTemplate.replace("{integrationId}", actionBindings.integrationId).replace("{pgid}", actionBindings.pgid))
      if (actionRule || actionPrefixes.some(prefix => shaped.path.startsWith(prefix) || decodedPath.startsWith(prefix))) {
        if (actionRule && phase === "action" && actionArmed && actionCount < actionRule.maxCount && counts.attempted === 0 &&
            method === "GET" && actionRule.resourceTypes.includes(shaped.resourceType) && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !request.url.includes("?")) {
          actionCount += 1
          actionArmed = false
          return { allow: true, mutation: true }
        }
        count("mutation")
        return { allow: false, category: "mutation" }
      }
      if (phase !== "login" && method !== "GET") {
        count("mutation")
        return { allow: false, category: "mutation" }
      }
      if (selectedDetail) return { allow: true }
      if (detailUrl && shaped.resourceType === "document") {
        count("unreviewed")
        return { allow: false, category: "unreviewed" }
      }
      const rules = phase === "login" ? [...policy.login, ...policy.list] : policy.list
      if (rules.some(rule => matchesAllow(rule, shaped))) return { allow: true }
      count("unreviewed")
      return { allow: false, category: "unreviewed" }
    },
  }
}

module.exports = { createRequestGuard }
