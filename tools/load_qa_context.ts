import z from "zod"
import { Tool } from "./tool"
import fs from "fs/promises"
import path from "path"

const DESCRIPTION = `
Load QA context files (anchor points and flows) for automated testing.

This tool loads two critical JSON files:
1. QA_ANCHOR_POINTS.json - Blueprint with selectors, routes, patterns
2. QA_FLOWS.json - Predefined test flows and user journeys

Once loaded, the QA agent can:
- Execute predefined flows by name
- Resolve selectors from anchor points
- Run test suites (smoke, regression, etc.)

Usage:
- Provide the directory containing the QA files
- Or provide explicit paths to both files
`

// Global context cache (persists across tool calls in same session)
let contextCache: QAContext | null = null

interface QAContext {
  anchorPoints: any
  flows: any
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

Use reload=true to force reload.`

      return {
        output,
        title: "QA Context (Cached)",
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
      }
    }

    try {
      // Load anchor points
      const anchorPointsContent = await fs.readFile(anchorPointsFile, "utf-8")
      const anchorPoints = JSON.parse(anchorPointsContent)

      // Load flows
      const flowsContent = await fs.readFile(flowsFile, "utf-8")
      const flows = JSON.parse(flowsContent)

      // Cache the context
      contextCache = {
        anchorPoints,
        flows,
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

✓ QA Context is ready for use!

You can now:
- Execute flows by name: execute_flow("callLogs.viewCallDetails")
- Run test suites: execute_flow("smokeTesting")
- Use anchor points for selector resolution
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
      }
    }
  },
})

// Helper functions
function countTotalFlows(flows: any): number {
  let count = 0
  for (const category of Object.values(flows.flows || {})) {
    if (typeof category === "object") {
      count += Object.keys(category).length
    }
  }
  return count
}

function listFlowCategories(flows: any): string {
  const categories = []
  for (const [category, flowMap] of Object.entries(flows || {})) {
    if (typeof flowMap === "object") {
      const flowCount = Object.keys(flowMap).length
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
