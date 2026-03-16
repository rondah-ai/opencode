/**
 * Model Merger — merges learn session observations into the feature model
 *
 * After a learn session ends, the merger:
 * 1. MATCH: Finds existing capabilities by route + interaction similarity
 * 2. MERGE interaction: replace guesses or generalize observed descriptions
 * 3. MERGE verify checks: union all checks seen across sessions
 * 4. MERGE test_data: collect values into arrays
 * 5. MERGE edge_cases: append from [e] key presses
 * 6. UPDATE metadata: increment _observed, upgrade _confidence
 */

import type { CapabilityObservation, InferredCheck } from "./session-recorder"

// ─── Types ───────────────────────────────────────────────────────────────────

/** Simplified feature model types for the merger (avoids circular imports) */
interface FeatureModelData {
  version: string
  meta: {
    generated_by: string
    learn_sessions: number
    last_session?: string
    confidence: string
  }
  features: Record<string, FeatureData>
  shared: Record<string, unknown>
  [key: string]: unknown
}

interface FeatureData {
  description: string
  route: string
  requires: string[]
  capabilities: Record<string, CapabilityData>
  test_data?: Record<string, unknown>
}

interface CapabilityData {
  interaction: string
  expected: string[]
  verify: Record<string, { type: string; selector?: string; value?: string }>
  preconditions?: string[]
  cleanup?: string
  test_data?: Record<string, unknown>
  edge_cases?: EdgeCaseData[]
  _confidence?: string
  _observed?: number
  [key: string]: unknown
}

interface EdgeCaseData {
  name: string
  interaction: string
  verify: Record<string, { type: string; selector?: string }>
}

export interface MergeResult {
  updated: { feature: string; capability: string; changes: string[] }[]
  added: { feature: string; capability: string }[]
  edgeCasesAdded: { feature: string; capability: string; name: string }[]
  unchanged: number
}

// ─── Confidence Levels ───────────────────────────────────────────────────────

const CONFIDENCE_ORDER = [
  "init",
  "migrated",
  "observed_1x",
  "observed_2x",
  "observed_3x",
  "stable",
  "edge_cased",
]

function nextConfidence(current: string | undefined, observed: number, hasEdgeCases: boolean): string {
  if (hasEdgeCases) return "edge_cased"
  if (observed >= 4) return "stable"
  if (observed >= 3) return "observed_3x"
  if (observed >= 2) return "observed_2x"
  if (observed >= 1) return "observed_1x"
  return current ?? "init"
}

// ─── Merger ──────────────────────────────────────────────────────────────────

/**
 * Merge learn session observations into an existing feature model.
 * Returns the updated model and a summary of changes.
 */
export function mergeObservations(
  model: FeatureModelData,
  observations: CapabilityObservation[],
  sessionNumber: number,
): { model: FeatureModelData; result: MergeResult } {
  const updated = JSON.parse(JSON.stringify(model)) as FeatureModelData
  const result: MergeResult = {
    updated: [],
    added: [],
    edgeCasesAdded: [],
    unchanged: 0,
  }

  // Separate normal observations from edge cases
  const normalObs = observations.filter((o) => !o.isEdgeCase)
  const edgeCaseObs = observations.filter((o) => o.isEdgeCase)

  // Process normal observations
  for (const obs of normalObs) {
    const match = findMatchingCapability(updated, obs)

    if (match) {
      // UPGRADE existing capability
      const changes = upgradeCapability(match.capability, obs)
      if (changes.length > 0) {
        result.updated.push({
          feature: match.featureName,
          capability: match.capabilityName,
          changes,
        })
      } else {
        result.unchanged++
      }
    } else {
      // ADD new capability
      addNewCapability(updated, obs)
      result.added.push({
        feature: routeToFeatureName(obs.route),
        capability: obs.userLabel ?? guessCapabilityName(obs),
      })
    }
  }

  // Process edge cases
  for (const obs of edgeCaseObs) {
    const parentId = obs.edgeCaseOf
    let parentMatch: { featureName: string; capabilityName: string; capability: CapabilityData } | null = null

    if (parentId) {
      // Find the parent observation and its matched capability
      const parentObs = normalObs.find((o) => o.id === parentId)
      if (parentObs) {
        parentMatch = findMatchingCapability(updated, parentObs)
      }
    }

    if (!parentMatch) {
      // Try to match by route — find the most recent capability on this route
      parentMatch = findClosestCapability(updated, obs.route)
    }

    if (parentMatch) {
      const edgeCase = buildEdgeCase(obs)
      if (!parentMatch.capability.edge_cases) {
        parentMatch.capability.edge_cases = []
      }
      parentMatch.capability.edge_cases.push(edgeCase)

      // Upgrade confidence to edge_cased
      parentMatch.capability._confidence = "edge_cased"

      result.edgeCasesAdded.push({
        feature: parentMatch.featureName,
        capability: parentMatch.capabilityName,
        name: edgeCase.name,
      })
    }
  }

  // Update model metadata
  updated.meta.learn_sessions = sessionNumber
  updated.meta.last_session = new Date().toISOString()
  updated.meta.confidence = computeOverallConfidence(updated)

  return { model: updated, result }
}

// ─── Matching ────────────────────────────────────────────────────────────────

interface CapabilityMatch {
  featureName: string
  capabilityName: string
  capability: CapabilityData
  score: number
}

function findMatchingCapability(
  model: FeatureModelData,
  obs: CapabilityObservation,
): CapabilityMatch | null {
  const obsRoute = obs.route
  let bestMatch: CapabilityMatch | null = null
  let bestScore = 0

  for (const [featureName, feature] of Object.entries(model.features)) {
    // Route must match (or be close)
    if (!routesMatch(feature.route, obsRoute)) continue

    for (const [capName, cap] of Object.entries(feature.capabilities)) {
      // Check if user explicitly labeled this with a matching name
      if (obs.userLabel && obs.userLabel.toLowerCase() === capName.toLowerCase()) {
        return { featureName, capabilityName: capName, capability: cap, score: 1 }
      }

      // Score based on interaction similarity + state change overlap
      const score = computeMatchScore(cap, obs)
      if (score > bestScore && score >= 0.3) {
        bestScore = score
        bestMatch = { featureName, capabilityName: capName, capability: cap, score }
      }
    }
  }

  return bestMatch
}

function findClosestCapability(
  model: FeatureModelData,
  route: string,
): CapabilityMatch | null {
  for (const [featureName, feature] of Object.entries(model.features)) {
    if (!routesMatch(feature.route, route)) continue

    // Return the first capability in this feature
    const [capName, cap] = Object.entries(feature.capabilities)[0] ?? []
    if (capName && cap) {
      return { featureName, capabilityName: capName, capability: cap, score: 0.5 }
    }
  }
  return null
}

function routesMatch(modelRoute: string, obsRoute: string): boolean {
  if (modelRoute === obsRoute) return true
  // Allow sub-routes: /home/call-logs matches /home/call-logs/123
  if (obsRoute.startsWith(modelRoute + "/")) return true
  return false
}

function computeMatchScore(cap: CapabilityData, obs: CapabilityObservation): number {
  let score = 0
  let total = 0

  // Check verify type overlap
  const capVerifyTypes = new Set(Object.values(cap.verify).map((v) => v.type))
  const obsCheckTypes = new Set(obs.inferredVerifyChecks.map((c) => c.type))

  for (const type of obsCheckTypes) {
    total++
    if (capVerifyTypes.has(type)) score++
  }

  // Keyword overlap in interaction description
  const capWords = tokenize(cap.interaction)
  const obsWords = tokenize(obs.interactionDescription)

  for (const word of obsWords) {
    total++
    if (capWords.has(word)) score++
  }

  return total === 0 ? 0 : score / total
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  )
}

// ─── Upgrading ───────────────────────────────────────────────────────────────

function upgradeCapability(cap: CapabilityData, obs: CapabilityObservation): string[] {
  const changes: string[] = []

  // 1. Upgrade interaction description
  const oldConfidence = cap._confidence ?? "init"
  if (oldConfidence === "init" || oldConfidence === "migrated") {
    // Replace guessed interaction with observed
    if (obs.interactionDescription && obs.interactionDescription !== cap.interaction) {
      cap.interaction = obs.interactionDescription
      changes.push(`interaction: replaced guess with observed`)
    }
  } else {
    // Already observed — could generalize, but keep existing for now
    // Full generalization would require NLP which is out of scope for deterministic
  }

  // 2. Merge verify checks (union)
  for (const check of obs.inferredVerifyChecks) {
    const existingKey = Object.entries(cap.verify).find(
      ([_, v]) => v.type === check.type && v.selector === check.selector,
    )

    if (!existingKey) {
      // New check — add it
      const checkName = generateCheckName(check, cap.verify)
      cap.verify[checkName] = {
        type: check.type,
        ...(check.selector && { selector: check.selector }),
        ...(check.value && { value: check.value }),
      }
      changes.push(`+ verify.${checkName}: ${check.type}`)
    }
  }

  // 3. Merge test_data
  for (const event of obs.interaction.events) {
    if (event.type === "input" && event.value && event.value !== "***") {
      if (!cap.test_data) cap.test_data = {}
      const fieldKey = event.field ?? "input"
      const existing = cap.test_data[fieldKey]
      if (existing === "TODO") {
        cap.test_data[fieldKey] = event.value
        changes.push(`+ test_data.${fieldKey}: "${event.value}"`)
      } else if (typeof existing === "string" && existing !== event.value) {
        cap.test_data[fieldKey] = [existing, event.value]
        changes.push(`+ test_data.${fieldKey}: added "${event.value}"`)
      } else if (Array.isArray(existing) && !existing.includes(event.value)) {
        existing.push(event.value)
        changes.push(`+ test_data.${fieldKey}: added "${event.value}"`)
      } else if (!existing) {
        cap.test_data[fieldKey] = event.value
        changes.push(`+ test_data.${fieldKey}: "${event.value}"`)
      }
    }
  }

  // 4. Update metadata
  const observed = (cap._observed ?? 0) + 1
  cap._observed = observed
  const hasEdgeCases = (cap.edge_cases?.length ?? 0) > 0
  cap._confidence = nextConfidence(oldConfidence, observed, hasEdgeCases)

  if (cap._confidence !== oldConfidence) {
    changes.push(`confidence: ${oldConfidence} → ${cap._confidence}`)
  }

  return changes
}

function generateCheckName(check: InferredCheck, existing: Record<string, unknown>): string {
  let base = check.type
  if (check.selector) {
    base = check.selector
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase()
      .slice(0, 30)
  }

  // Ensure uniqueness
  if (!existing[base]) return base
  let i = 2
  while (existing[`${base}_${i}`]) i++
  return `${base}_${i}`
}

// ─── Adding New Capabilities ─────────────────────────────────────────────────

function addNewCapability(model: FeatureModelData, obs: CapabilityObservation): void {
  const featureName = routeToFeatureName(obs.route)
  const capName = obs.userLabel ?? guessCapabilityName(obs)

  // Find or create the feature
  if (!model.features[featureName]) {
    model.features[featureName] = {
      description: `${featureName.replace(/_/g, " ")} page`,
      route: obs.route,
      requires: [],
      capabilities: {},
    }
  }

  const feature = model.features[featureName]

  // Build verify from inferred checks
  const verify: Record<string, { type: string; selector?: string; value?: string }> = {}
  for (const check of obs.inferredVerifyChecks) {
    const name = generateCheckName(check, verify)
    verify[name] = {
      type: check.type,
      ...(check.selector && { selector: check.selector }),
      ...(check.value && { value: check.value }),
    }
  }

  // Build test_data from input events
  const testData: Record<string, unknown> = {}
  for (const event of obs.interaction.events) {
    if (event.type === "input" && event.value && event.value !== "***") {
      testData[event.field ?? "input"] = event.value
    }
  }

  feature.capabilities[capName] = {
    interaction: obs.interactionDescription,
    expected: buildExpectedFromDiff(obs),
    verify,
    ...(Object.keys(testData).length > 0 && { test_data: testData }),
    _confidence: "observed_1x",
    _observed: 1,
  }
}

function buildExpectedFromDiff(obs: CapabilityObservation): string[] {
  const expected: string[] = []
  const diff = obs.diff

  if (diff.urlChanged) {
    expected.push(`page navigates to ${new URL(diff.newUrl).pathname}`)
  }

  for (const change of diff.elementChanges.slice(0, 3)) {
    if (change.before === 0 && change.after > 0) {
      expected.push(`${change.selector} appears`)
    } else if (change.before > 0 && change.after === 0) {
      expected.push(`${change.selector} disappears`)
    } else {
      expected.push(`${change.selector} count changes`)
    }
  }

  if (expected.length === 0) {
    expected.push("action completes without errors")
  }

  return expected
}

function buildEdgeCase(obs: CapabilityObservation): EdgeCaseData {
  const verify: Record<string, { type: string; selector?: string }> = {}
  for (const check of obs.inferredVerifyChecks) {
    const name = generateCheckName(check, verify)
    verify[name] = {
      type: check.type,
      ...(check.selector && { selector: check.selector }),
    }
  }

  return {
    name: obs.userLabel ?? `edge_case_${Date.now()}`,
    interaction: obs.interactionDescription,
    verify,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function routeToFeatureName(route: string): string {
  const cleaned = route
    .replace(/^\/home\//, "")
    .replace(/^\/app\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "")

  if (!cleaned || cleaned === "/") return "home"

  const segments = cleaned.split("/").filter(Boolean)
  const last = segments[segments.length - 1]

  return last
    .replace(/-/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase()
}

function guessCapabilityName(obs: CapabilityObservation): string {
  const events = obs.interaction.events
  const hasClick = events.some((e) => e.type === "click")
  const hasInput = events.some((e) => e.type === "input")
  const hasSubmit = events.some((e) => e.type === "submit")
  const hasNav = events.some((e) => e.type === "navigation")

  if (hasSubmit && hasInput) return "submit_form"
  if (hasInput && !hasSubmit) return "filter"
  if (hasNav && !hasClick) return "navigate"
  if (hasClick) {
    const clickEvent = events.find((e) => e.type === "click")
    const text = clickEvent?.text?.toLowerCase() ?? ""
    if (text.includes("add") || text.includes("create") || text.includes("new")) return "create"
    if (text.includes("edit") || text.includes("update")) return "edit"
    if (text.includes("delete") || text.includes("remove")) return "delete"
    if (text.includes("filter")) return "filter"
    if (text.includes("search")) return "search"
    if (text.includes("sort")) return "sort"
  }

  return `action_${obs.id.replace("obs-", "")}`
}

function computeOverallConfidence(model: FeatureModelData): string {
  const confidences: string[] = []
  for (const feature of Object.values(model.features)) {
    for (const cap of Object.values(feature.capabilities)) {
      confidences.push(cap._confidence ?? "init")
    }
  }

  if (confidences.length === 0) return "skeleton"

  const minIndex = Math.min(
    ...confidences.map((c) => CONFIDENCE_ORDER.indexOf(c)).filter((i) => i >= 0),
  )

  if (minIndex >= CONFIDENCE_ORDER.indexOf("observed_3x")) return "stable"
  if (minIndex >= CONFIDENCE_ORDER.indexOf("observed_1x")) return "improving"
  return "skeleton"
}
