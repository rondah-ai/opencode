import z from "zod"
import { Tool } from "./tool"
import fs from "fs/promises"
import path from "path"
import { loadFeatureModel, getFeatureModel, type FeatureModel } from "../qa/feature-model"
import { loadInstructions, getInstructions, type QAInstructions } from "../qa/instructions"

const DESCRIPTION = `
Load QA context files for automated testing.

Supports both legacy and smart QA systems:
1. QA_ANCHOR_POINTS.json - Blueprint with selectors, routes, patterns (legacy)
2. QA_FLOWS.json - Predefined test flows and user journeys (legacy)
3. QA_FEATURE_MODEL.json - Feature model with capabilities, verify checks, test data (smart)

Both systems can coexist — the agent uses whichever is available.

Usage:
- Provide the directory containing the QA files
- Or provide explicit paths to files
- Feature model is auto-detected if QA_FEATURE_MODEL.json exists in the directory
`

// Global context cache (persists across tool calls in same session)
let contextCache: QAContext | null = null

interface QAContext {
  anchorPoints: any
  flows: any
  featureModel: FeatureModel | null
  instructions: QAInstructions | null
  loadedFrom: string
  loadedAt: Date
}

export const LoadQAContextTool = Tool.define("load_qa_context", {
  description: DESCRIPTION,
  parameters: z.object({
    directory: z.string().optional()
      .describe("Directory containing QA_ANCHOR_POINTS.json and QA_FLOWS.json"),
    anchorPointsPath: z.string().optional()
      .describe("Explicit path to QA_ANCHOR_POINTS.json"),
    flowsPath: z.string().optional()
      .describe("Explicit path to QA_FLOWS.json"),
    featureModelPath: z.string().optional()
      .describe("Explicit path to QA_FEATURE_MODEL.json (auto-detected if in directory)"),
    instructionsPath: z.string().optional()
      .describe("Explicit path to QA_INSTRUCTIONS.json (auto-detected if in directory)"),
    environment: z.string().optional()
      .describe("Environment name for instruction overrides (e.g., 'production', 'staging')"),
    reload: z.boolean().default(false)
      .describe("Force reload even if already cached"),
  }),
  async execute(params, ctx) {
    const startTime = Date.now()

    // Check if already loaded
    if (contextCache && !params.reload) {
      const output = `QA Context already loaded from: ${contextCache.loadedFrom}

Loaded at: ${contextCache.loadedAt.toISOString()}

Anchor Points Summary:
- Routes: ${Object.keys(contextCache.anchorPoints.routes || {}).length}
- Buttons: ${Object.keys(contextCache.anchorPoints.buttons?.primary || {}).length} primary buttons
- Tables: ${Object.keys(contextCache.anchorPoints.tables || {}).length} table definitions
- Forms: ${Object.keys(contextCache.anchorPoints.forms?.inputs || {}).length} input types
- Workflows: ${Object.keys(contextCache.anchorPoints.workflows || {}).length} predefined workflows

Flows Summary:
- Flow Categories: ${Object.keys(contextCache.flows.flows || {}).length}
- Total Flows: ${countTotalFlows(contextCache.flows)}
- Smoke Tests: ${contextCache.flows.flowCategories?.smokeTesting?.length || 0}
- Critical Path: ${contextCache.flows.flowCategories?.criticalPath?.length || 0}
- Regression: ${contextCache.flows.flowCategories?.regression?.length || 0}
${contextCache.featureModel ? `
Feature Model: v${contextCache.featureModel.version}
- Features: ${Object.keys(contextCache.featureModel.features).length}
- Shared capabilities: ${Object.keys(contextCache.featureModel.shared).length}
- Total capabilities: ${Object.values(contextCache.featureModel.features).reduce((sum, f) => sum + Object.keys(f.capabilities).length, 0)}` : "Feature Model: not loaded"}
${contextCache.instructions ? `
Instructions: v${contextCache.instructions.version}
- Excluded routes: ${contextCache.instructions.scope.exclude_routes.length}
- Known issues: ${contextCache.instructions.known_issues.length}
- Default timeout: ${contextCache.instructions.global.defaultTimeout}ms` : "Instructions: not loaded"}

Use reload=true to force reload.`

      return {
        output,
        title: "QA Context (Cached)",
        metadata: { anchorPointsFile: contextCache.loadedFrom, flowsFile: contextCache.loadedFrom, loadTime: 0 },
      }
    }

    // Determine file paths
    let anchorPointsFile: string
    let flowsFile: string

    if (params.anchorPointsPath && params.flowsPath) {
      anchorPointsFile = params.anchorPointsPath
      flowsFile = params.flowsPath
    } else if (params.directory) {
      anchorPointsFile = path.join(params.directory, "QA_ANCHOR_POINTS.json")
      flowsFile = path.join(params.directory, "QA_FLOWS.json")
    } else {
      return {
        output: "Error: Must provide either 'directory' or both 'anchorPointsPath' and 'flowsPath'",
        title: "Load QA Context - Error",
        metadata: { anchorPointsFile: "", flowsFile: "", loadTime: 0 },
      }
    }

    try {
      // Load anchor points
      const anchorPointsContent = await fs.readFile(anchorPointsFile, "utf-8")
      const anchorPoints = JSON.parse(anchorPointsContent)

      // Load flows
      const flowsContent = await fs.readFile(flowsFile, "utf-8")
      const flows = JSON.parse(flowsContent)

      // Load feature model (optional)
      let featureModel: FeatureModel | null = null
      const featureModelFile =
        params.featureModelPath ??
        (params.directory ? path.join(params.directory, "QA_FEATURE_MODEL.json") : null)

      if (featureModelFile) {
        try {
          await fs.access(featureModelFile)
          featureModel = await loadFeatureModel(featureModelFile)
        } catch (fmErr) {
          // Feature model is optional — only warn if explicitly provided
          if (params.featureModelPath) {
            throw fmErr
          }
          // Auto-detected path doesn't exist — that's fine
        }
      }

      // Load instructions (optional)
      let instructions: QAInstructions | null = null
      const instructionsFile =
        params.instructionsPath ??
        (params.directory ? path.join(params.directory, "QA_INSTRUCTIONS.json") : null)

      if (instructionsFile) {
        try {
          await fs.access(instructionsFile)
          instructions = await loadInstructions(instructionsFile, params.environment)
        } catch (instrErr) {
          // Instructions are optional — only warn if explicitly provided
          if (params.instructionsPath) {
            throw instrErr
          }
        }
      }

      // Cache the context
      contextCache = {
        anchorPoints,
        flows,
        featureModel,
        instructions,
        loadedFrom: params.directory || path.dirname(anchorPointsFile),
        loadedAt: new Date(),
      }

      const loadTime = Date.now() - startTime

      const output = `✓ QA Context loaded successfully in ${loadTime}ms

Loaded from: ${contextCache.loadedFrom}

=== ANCHOR POINTS ===
Project: ${anchorPoints.metadata?.project || "Unknown"}
Framework: ${anchorPoints.metadata?.framework || "Unknown"}
Version: ${anchorPoints.metadata?.version || "Unknown"}

Routes: ${Object.keys(anchorPoints.routes || {}).length} defined
- Dashboard: ${anchorPoints.routes?.dashboard}
- Call Logs: ${anchorPoints.routes?.callLogs}
- Appointments: ${anchorPoints.routes?.appointments}
- Configurations: ${Object.keys(anchorPoints.routes?.configurations || {}).length} config pages

UI Components:
- Primary Buttons: ${Object.keys(anchorPoints.buttons?.primary || {}).length} types
- Tables: ${Object.keys(anchorPoints.tables || {}).length} definitions
- Forms: ${Object.keys(anchorPoints.forms?.inputs || {}).length} input types
- Dialogs: ${Object.keys(anchorPoints.dialogs || {}).length} patterns
- Filters: ${Object.keys(anchorPoints.filters || {}).length} filter types

Common Patterns: ${Object.keys(anchorPoints.commonPatterns || {}).length} defined
Workflows: ${Object.keys(anchorPoints.workflows || {}).length} predefined

=== FLOWS ===
Base URL: ${flows.metadata?.baseUrl || "Not specified"}
Flow Version: ${flows.metadata?.version || "Unknown"}

Flow Categories:
${listFlowCategories(flows.flows)}

Test Suites:
- Smoke Testing: ${flows.flowCategories?.smokeTesting?.length || 0} flows
- Critical Path: ${flows.flowCategories?.criticalPath?.length || 0} flows
- Regression: ${flows.flowCategories?.regression?.length || 0} flows

Total Flows: ${countTotalFlows(flows)}

Common Test Parameters:
${JSON.stringify(flows.commonParameters?.testData || {}, null, 2)}

${featureModel ? `=== FEATURE MODEL ===
Version: ${featureModel.version}
Features: ${Object.entries(featureModel.features).map(([name, f]) => `  - ${name}: ${Object.keys(f.capabilities).length} capabilities (${f.route})`).join("\n")}
Shared: ${Object.keys(featureModel.shared).join(", ") || "none"}
` : "Feature Model: QA_FEATURE_MODEL.json not found (optional)"}

${instructions ? `=== INSTRUCTIONS ===
Viewport: ${instructions.global.viewport.width}x${instructions.global.viewport.height}
Default Timeout: ${instructions.global.defaultTimeout}ms
Excluded Routes: ${instructions.scope.exclude_routes.length} patterns
Known Issues: ${instructions.known_issues.length}
Custom Selectors: ${Object.keys(instructions.global.customSelectors).length}
Agent Hints: ${instructions.agent_hints.length}${params.environment ? `\nEnvironment: ${params.environment}` : ""}
` : "Instructions: QA_INSTRUCTIONS.json not found (optional)"}

✓ QA Context is ready for use!

You can now:
- Execute flows by name: execute_flow("callLogs.viewCallDetails")
- Run test suites: execute_flow("smokeTesting")
- Use anchor points for selector resolution${featureModel ? "\n- Use feature model for smart test composition" : ""}
`

      return {
        output,
        title: "QA Context Loaded",
        metadata: {
          anchorPointsFile,
          flowsFile,
          loadTime,
        },
      }
    } catch (error) {
      return {
        output: `Error loading QA context: ${error instanceof Error ? error.message : String(error)}

Attempted to load:
- Anchor Points: ${anchorPointsFile}
- Flows: ${flowsFile}

Please verify:
1. Files exist at the specified paths
2. Files contain valid JSON
3. You have read permissions`,
        title: "Load QA Context - Error",
        metadata: { anchorPointsFile, flowsFile, loadTime: Date.now() - startTime },
      }
    }
  },
})

// Helper functions
function countTotalFlows(flows: any): number {
  let count = 0
  for (const category of Object.values(flows.flows || {})) {
    if (typeof category === "object" && category !== null) {
      count += Object.keys(category as Record<string, unknown>).length
    }
  }
  return count
}

function listFlowCategories(flows: any): string {
  const categories = []
  for (const [category, flowMap] of Object.entries(flows || {})) {
    if (typeof flowMap === "object" && flowMap !== null) {
      const flowCount = Object.keys(flowMap as Record<string, unknown>).length
      categories.push(`  - ${category}: ${flowCount} flows`)
    }
  }
  return categories.join("\n")
}

// Export function to get cached context
export function getQAContext(): QAContext | null {
  return contextCache
}

// Export function to clear cache
export function clearQAContext(): void {
  contextCache = null
}
