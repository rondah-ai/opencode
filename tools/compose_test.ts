import z from "zod"
import { Tool } from "./tool"
import { getQAContext } from "./load_qa_context"
import {
  getFeatureModel,
  resolveCapabilities,
  type FeatureModel,
  type ResolvedCapability,
} from "../qa/feature-model"
import { getInstructions, isRouteExcluded, isCapabilityExcluded } from "../qa/instructions"

const DESCRIPTION = `
Compose dynamic test scenarios by intelligently combining multiple flows or feature capabilities.

Two modes:
1. SMART MODE (feature model loaded): Parses intent, resolves dependencies from feature model,
   outputs ordered capability plan with verify checks and test data.
2. LEGACY MODE (no feature model): Keyword matching against QA_FLOWS.json (backward compatible).

Smart mode examples:
- "smoke test call_logs" → [authenticated, call_logs.view_list]
- "regression test appointments" → full capability chain with edge cases
- "test CRUD for call_logs" → add, view, edit, delete in dependency order

Legacy mode examples:
- "test call logs functionality" → matching flows from QA_FLOWS.json
- "smoke tests" → all smoke testing flows
- "critical path" → all critical path flows

Use explicit features/capabilities params to bypass intent parsing (for CI usage).
`

// ─── Legacy types ────────────────────────────────────────────────────────────

interface FlowReference {
  path: string
  name: string
  description: string
  priority: string
  requiredParams: string[]
  expectedDuration: number
  isPrerequisite?: boolean
}

// ─── Smart mode types ────────────────────────────────────────────────────────

interface CapabilityPlanStep {
  order: number
  feature: string
  capability: string
  route: string
  interaction: string
  expected: string[]
  verify: { type: string; selector?: string; value?: string }[]
  testData?: Record<string, unknown>
  cleanup?: string
  edgeCases?: string[]
  isShared: boolean
}

type SuiteType = "smoke" | "regression" | "full"

export const ComposeTestTool = Tool.define("compose_test", {
  description: DESCRIPTION,
  parameters: z.object({
    testDescription: z.string().describe("Natural language description of what to test"),
    // Smart mode params
    features: z
      .array(z.string())
      .optional()
      .describe("Explicit feature names (bypasses intent parsing)"),
    suite: z
      .enum(["smoke", "regression", "full"])
      .optional()
      .describe("Suite type: smoke (view-only), regression (with edge cases), full (all capabilities)"),
    // Legacy mode params
    includeLogin: z.boolean().default(true).describe("Auto-include login flow if needed (legacy mode)"),
    maxFlows: z.number().default(10).describe("Maximum number of flows (legacy mode)"),
    priorityFilter: z.enum(["critical", "high", "medium", "low", "all"]).default("all").describe("Filter by priority (legacy mode)"),
  }),
  async execute(params, ctx) {
    const featureModel = getFeatureModel()

    // ── Smart path: feature model available ─────────────────────────
    if (featureModel) {
      return composeFromFeatureModel(featureModel, params)
    }

    // ── Legacy path: fall back to QA_FLOWS.json keyword matching ────
    return composeFromFlows(params)
  },
})

// ─── Smart Mode ──────────────────────────────────────────────────────────────

function composeFromFeatureModel(
  model: FeatureModel,
  params: {
    testDescription: string
    features?: string[]
    suite?: SuiteType
  },
) {
  // Step 1: Determine target features
  let targetFeatures: string[]

  if (params.features && params.features.length > 0) {
    // Explicit — bypass parsing
    targetFeatures = params.features
  } else {
    // Intent parsing (Option A: keyword extraction)
    targetFeatures = parseIntent(model, params.testDescription)
  }

  if (targetFeatures.length === 0) {
    const available = Object.keys(model.features)
    return {
      output: `No features matched: "${params.testDescription}"

Available features:
${available.map((f) => `  - ${f}: ${model.features[f].description}`).join("\n")}

Tips:
- Use feature names directly: "test call_logs"
- Use suite types: "smoke test", "regression test"
- Use explicit param: features=["call_logs", "appointments"]`,
      title: "Compose Test - No Matches",
      metadata: { mode: "smart", planSteps: 0, features: [], suite: null },
    }
  }

  // Step 2: Determine suite type
  const suite = params.suite ?? parseSuiteType(params.testDescription)

  // Step 3: Resolve dependencies
  let resolved: ResolvedCapability[]
  try {
    resolved = resolveCapabilities(model, targetFeatures)
  } catch (err) {
    return {
      output: `Dependency resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      title: "Compose Test - Error",
      metadata: { mode: "smart", planSteps: 0, features: targetFeatures, suite },
    }
  }

  // Step 4a: Filter excluded routes and capabilities from instructions
  resolved = resolved.filter((r) => {
    if (r.isShared) return true
    if (isRouteExcluded(r.route)) return false
    if (isCapabilityExcluded(r.feature, r.capability)) return false
    return true
  })

  // Step 4b: Filter by suite type
  if (suite === "smoke") {
    // Smoke = only view/list capabilities (no mutations)
    resolved = resolved.filter(
      (r) =>
        r.isShared ||
        /view|list|read|navigate/i.test(r.capability) ||
        /view|list|read|navigate/i.test(r.interaction),
    )
  }

  // Step 5: Build plan
  const plan: CapabilityPlanStep[] = resolved.map((r, i) => ({
    order: i + 1,
    feature: r.feature,
    capability: r.capability,
    route: r.route,
    interaction: r.interaction,
    expected: r.expected,
    verify: r.verify,
    testData: r.testData,
    cleanup: r.cleanup,
    edgeCases: suite === "regression" ? r.edgeCases : undefined,
    isShared: r.isShared,
  }))

  // Step 6: Format output
  const planOutput = plan
    .map((step) => {
      const prefix = step.isShared ? "[shared] " : ""
      const lines = [
        `${step.order}. ${prefix}${step.feature}.${step.capability}`,
        `   Route: ${step.route}`,
        `   Do: ${step.interaction}`,
        `   Expect: ${step.expected.join("; ")}`,
      ]
      if (step.verify.length > 0) {
        lines.push(
          `   Verify: ${step.verify.map((v) => `${v.type}${v.selector ? `(${v.selector})` : ""}${v.value ? `="${v.value}"` : ""}`).join(", ")}`,
        )
      }
      if (step.cleanup) {
        lines.push(`   Cleanup: ${step.cleanup}`)
      }
      if (step.edgeCases && step.edgeCases.length > 0) {
        lines.push(`   Edge cases: ${step.edgeCases.join("; ")}`)
      }
      return lines.join("\n")
    })
    .join("\n\n")

  const output = `Test Plan: "${params.testDescription}"
Mode: Smart (feature model v${model.version})
Suite: ${suite ?? "full"}
Features: ${targetFeatures.join(", ")}
Steps: ${plan.length}

${planOutput}

To execute: pass this plan to execute_flow with mode="capability"`

  return {
    output,
    title: `Test Plan: ${targetFeatures.join(", ")} (${plan.length} steps)`,
    metadata: {
      mode: "smart" as const,
      planSteps: plan.length,
      features: targetFeatures,
      suite,
      plan,
    },
  }
}

/**
 * Parse natural language intent → extract feature names.
 * Option A: keyword matching against feature model keys.
 */
function parseIntent(model: FeatureModel, description: string): string[] {
  const desc = description.toLowerCase()
  const features: string[] = []

  // Direct feature name match
  for (const name of Object.keys(model.features)) {
    const nameLower = name.toLowerCase()
    const nameSpaced = nameLower.replace(/_/g, " ")
    if (desc.includes(nameLower) || desc.includes(nameSpaced)) {
      features.push(name)
    }
  }

  // If no direct match, try description matching
  if (features.length === 0) {
    for (const [name, feature] of Object.entries(model.features)) {
      const featureDesc = feature.description.toLowerCase()
      // Check if any significant word from description matches
      const descWords = desc.split(/\s+/).filter((w) => w.length > 3)
      if (descWords.some((w) => featureDesc.includes(w) || name.includes(w))) {
        features.push(name)
      }
    }
  }

  // "all" or no specific target → all features
  if (features.length === 0 && (desc.includes("all") || desc.includes("everything"))) {
    features.push(...Object.keys(model.features))
  }

  return features
}

/**
 * Parse suite type from description keywords.
 */
function parseSuiteType(description: string): SuiteType | undefined {
  const desc = description.toLowerCase()
  if (desc.includes("smoke")) return "smoke"
  if (desc.includes("regression")) return "regression"
  if (desc.includes("full") || desc.includes("comprehensive") || desc.includes("complete")) return "full"
  return undefined
}

// ─── Legacy Mode ─────────────────────────────────────────────────────────────

function composeFromFlows(params: {
  testDescription: string
  includeLogin: boolean
  maxFlows: number
  priorityFilter: string
}) {
  const qaContext = getQAContext()
  if (!qaContext) {
    return {
      output: `Error: QA context not loaded. No feature model found either.

Please load QA context first:
  load_qa_context(directory="/path/to/project")

Or provide a QA_FEATURE_MODEL.json for smart mode.`,
      title: "Compose Test - Error",
      metadata: { mode: "legacy", flowCount: 0, flows: [], totalDuration: 0, requiredParams: [] },
    }
  }

  const flows = qaContext.flows.flows
  const categories = qaContext.flows.flowCategories
  const description = params.testDescription.toLowerCase()

  const selectedFlows: FlowReference[] = []

  function addFlow(flowPath: string, isPrerequisite = false) {
    const parts = flowPath.split(".")
    if (parts.length !== 2) return

    const [category, flowName] = parts
    const flowDef = flows[category]?.[flowName]
    if (!flowDef) return
    if (selectedFlows.some((f) => f.path === flowPath)) return

    if (params.priorityFilter !== "all") {
      const priorityLevels: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
      const requiredLevel = priorityLevels[params.priorityFilter]
      const flowLevel = priorityLevels[flowDef.priority] || 0
      if (flowLevel < requiredLevel) return
    }

    selectedFlows.push({
      path: flowPath,
      name: flowDef.name,
      description: flowDef.description,
      priority: flowDef.priority,
      requiredParams: flowDef.requiredParams || [],
      expectedDuration: flowDef.expectedDuration || 3000,
      isPrerequisite,
    })
  }

  // Category matching
  if (description.includes("smoke") && categories?.smokeTesting) {
    for (const flowPath of categories.smokeTesting) addFlow(flowPath)
  } else if ((description.includes("critical") || description.includes("path")) && categories?.criticalPath) {
    for (const flowPath of categories.criticalPath) addFlow(flowPath)
  } else if (description.includes("regression") && categories?.regression) {
    for (const flowPath of categories.regression) addFlow(flowPath)
  } else if (description.includes("complete") || description.includes("end-to-end") || description.includes("e2e")) {
    const completeFlows = flows.complete || {}
    for (const [flowName, flowDef] of Object.entries(completeFlows) as [string, any][]) {
      if (flowDef.composedOf) {
        const flowNameLower = flowName.toLowerCase()
        if (
          description.includes(flowNameLower) ||
          description.includes(flowDef.name.toLowerCase()) ||
          description.includes(flowDef.description.toLowerCase())
        ) {
          for (const composedFlow of flowDef.composedOf) addFlow(composedFlow)
        }
      }
    }
    if (selectedFlows.length === 0) {
      if (description.includes("call") || description.includes("log")) {
        const journey = flows.complete?.endToEndCallLogsJourney
        if (journey?.composedOf) for (const fp of journey.composedOf) addFlow(fp)
      } else if (description.includes("appointment")) {
        const journey = flows.complete?.endToEndAppointmentTypeManagement
        if (journey?.composedOf) for (const fp of journey.composedOf) addFlow(fp)
      } else if (description.includes("dashboard") || description.includes("analytics")) {
        const journey = flows.complete?.endToEndDashboardAnalysis
        if (journey?.composedOf) for (const fp of journey.composedOf) addFlow(fp)
      }
    }
  } else {
    // Keyword-based matching
    const keywords: Record<string, string[]> = {
      call: ["callLogs"], log: ["callLogs"],
      appointment: ["appointmentTypes"],
      dashboard: ["dashboard"], analytics: ["dashboard"],
      auth: ["authentication"], login: ["authentication"],
      practice: ["authentication"],
    }

    const matchedCategories = new Set<string>()
    for (const [keyword, cats] of Object.entries(keywords)) {
      if (description.includes(keyword)) cats.forEach((cat) => matchedCategories.add(cat))
    }

    if (matchedCategories.size === 0) {
      for (const category of Object.keys(flows)) {
        if (category !== "complete" && category !== "authentication") matchedCategories.add(category)
      }
    }

    for (const category of matchedCategories) {
      const categoryFlows = flows[category]
      if (typeof categoryFlows !== "object") continue

      for (const [flowName, flowDef] of Object.entries(categoryFlows) as [string, any][]) {
        const flowPath = `${category}.${flowName}`
        const flowNameLower = flowName.toLowerCase()
        const flowDescLower = flowDef.description.toLowerCase()

        const actions = ["view", "add", "create", "edit", "delete", "search", "filter", "update", "change"]
        let matched = false
        for (const action of actions) {
          if (description.includes(action) && (flowNameLower.includes(action) || flowDescLower.includes(action))) {
            addFlow(flowPath)
            matched = true
            break
          }
        }
        if (!matched && (description.includes("crud") || description.includes("all"))) {
          addFlow(flowPath)
        }
      }
    }
  }

  // Add login prerequisite
  if (params.includeLogin && selectedFlows.length > 0) {
    if (!selectedFlows.some((f) => f.path.includes("authentication"))) {
      addFlow("authentication.login", true)
    }
  }

  // Sort and limit
  selectedFlows.sort((a, b) => {
    if (a.isPrerequisite && !b.isPrerequisite) return -1
    if (!a.isPrerequisite && b.isPrerequisite) return 1
    if (selectedFlows.length > params.maxFlows) {
      const priorityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
      return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0)
    }
    return 0
  })
  if (selectedFlows.length > params.maxFlows) selectedFlows.splice(params.maxFlows)

  const totalDuration = selectedFlows.reduce((sum, f) => sum + f.expectedDuration, 0)
  const allParams = [...new Set(selectedFlows.flatMap((f) => f.requiredParams))]

  if (selectedFlows.length === 0) {
    return {
      output: `No flows matched: "${params.testDescription}"

Available test categories: smoke testing, critical path, regression
Available features: call logs, appointment types, dashboard, authentication

Tips: use keywords like "view", "add", "edit", "delete", "search", "filter"`,
      title: "Compose Test - No Matches",
      metadata: { mode: "legacy", flowCount: 0, flows: [], totalDuration: 0, requiredParams: [] },
    }
  }

  const output = `Test Plan (Legacy): "${params.testDescription}"

${selectedFlows.length} Flow${selectedFlows.length > 1 ? "s" : ""} Selected:

${selectedFlows
  .map(
    (f, i) =>
      `${i + 1}. ${f.isPrerequisite ? "[prereq] " : ""}${f.name}
   Path: ${f.path}
   Priority: ${f.priority.toUpperCase()}
   Duration: ~${f.expectedDuration}ms
   ${f.description}`,
  )
  .join("\n\n")}

Summary:
- Total Flows: ${selectedFlows.length}
- Total Duration: ~${(totalDuration / 1000).toFixed(1)}s
- Required Parameters: ${allParams.length > 0 ? allParams.join(", ") : "None"}

To Execute:
${selectedFlows.map((f) => `  execute_flow("${f.path}")`).join("\n")}`

  return {
    output,
    title: `Test Plan: ${selectedFlows.length} flows`,
    metadata: {
      mode: "legacy" as const,
      flowCount: selectedFlows.length,
      flows: selectedFlows.map((f) => f.path),
      totalDuration,
      requiredParams: allParams,
    },
  }
}
