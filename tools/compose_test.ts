import z from "zod"
import { Tool } from "./tool"
import { getQAContext } from "./load_qa_context"

const DESCRIPTION = `
Compose dynamic test scenarios by intelligently combining multiple flows.

This tool analyzes user test requirements and creates a comprehensive test plan
by selecting and sequencing the appropriate flows from QA_FLOWS.json.

Capabilities:
- Auto-detects required flows based on test description
- Handles prerequisites (e.g., login before testing features)
- Sequences flows in logical order
- Identifies test categories (smoke, regression, critical path)
- Suggests parameter values
- Estimates total execution time

Examples:
- "Test the complete call management workflow"
  → login + viewCallList + viewCallDetails + updateCallStatus

- "Verify appointment type CRUD operations"
  → login + viewAppointmentTypes + addAppointmentType + editAppointmentType + deleteAppointmentType

- "Run all dashboard features"
  → login + viewDashboard + selectDateRange + toggleViews + viewDropOffDetails

This is useful when:
- Creating end-to-end test scenarios
- Running comprehensive feature tests
- Building custom test suites
- Understanding flow dependencies
`

interface FlowReference {
  path: string
  name: string
  description: string
  priority: string
  requiredParams: string[]
  expectedDuration: number
  isPrerequisite?: boolean
}

export const ComposeTestTool = Tool.define("compose_test", {
  description: DESCRIPTION,
  parameters: z.object({
    testDescription: z.string().describe("Natural language description of what to test"),
    includeLogin: z.boolean().default(true).describe("Auto-include login flow if needed"),
    maxFlows: z.number().default(10).describe("Maximum number of flows to include"),
    priorityFilter: z.enum(["critical", "high", "medium", "low", "all"]).default("all").describe("Filter by priority level"),
  }),
  async execute(params, ctx) {
    // Get QA context
    const qaContext = getQAContext()
    if (!qaContext) {
      return {
        output: `Error: QA context not loaded.

Please load the QA context first using:
  load_qa_context(directory="/path/to/project")`,
        title: "Compose Test - Error",
      }
    }

    const flows = qaContext.flows.flows
    const categories = qaContext.flows.flowCategories
    const description = params.testDescription.toLowerCase()

    const selectedFlows: FlowReference[] = []
    const allFlowPaths: string[] = []

    // Collect all available flow paths
    for (const [category, categoryFlows] of Object.entries(flows)) {
      if (typeof categoryFlows === "object") {
        for (const [flowName, flowDef] of Object.entries(categoryFlows)) {
          const flowPath = `${category}.${flowName}`
          allFlowPaths.push(flowPath)
        }
      }
    }

    // Helper to add flow
    function addFlow(flowPath: string, isPrerequisite = false) {
      const parts = flowPath.split(".")
      if (parts.length !== 2) return

      const [category, flowName] = parts
      const flowDef = flows[category]?.[flowName]

      if (!flowDef) return

      // Check if already added
      if (selectedFlows.some((f) => f.path === flowPath)) return

      // Check priority filter
      if (params.priorityFilter !== "all") {
        const priorityLevels = { critical: 4, high: 3, medium: 2, low: 1 }
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

    // 1. Check if it's a known test category
    if (description.includes("smoke") && categories?.smokeTesting) {
      for (const flowPath of categories.smokeTesting) {
        addFlow(flowPath)
      }
    } else if ((description.includes("critical") || description.includes("path")) && categories?.criticalPath) {
      for (const flowPath of categories.criticalPath) {
        addFlow(flowPath)
      }
    } else if (description.includes("regression") && categories?.regression) {
      for (const flowPath of categories.regression) {
        addFlow(flowPath)
      }
    } else if (description.includes("complete") || description.includes("end-to-end") || description.includes("e2e")) {
      // Look for complete flows
      const completeFlows = flows.complete || {}
      for (const [flowName, flowDef] of Object.entries(completeFlows)) {
        if (flowDef.composedOf) {
          // Check if description matches
          const flowNameLower = flowName.toLowerCase()
          if (
            description.includes(flowNameLower) ||
            description.includes(flowDef.name.toLowerCase()) ||
            description.includes(flowDef.description.toLowerCase())
          ) {
            for (const composedFlow of flowDef.composedOf) {
              addFlow(composedFlow)
            }
          }
        }
      }

      // If no specific complete flow matched, try to match by keywords
      if (selectedFlows.length === 0) {
        if (description.includes("call") || description.includes("log")) {
          const journey = flows.complete?.endToEndCallLogsJourney
          if (journey?.composedOf) {
            for (const flowPath of journey.composedOf) {
              addFlow(flowPath)
            }
          }
        } else if (description.includes("appointment")) {
          const journey = flows.complete?.endToEndAppointmentTypeManagement
          if (journey?.composedOf) {
            for (const flowPath of journey.composedOf) {
              addFlow(flowPath)
            }
          }
        } else if (description.includes("dashboard") || description.includes("analytics")) {
          const journey = flows.complete?.endToEndDashboardAnalysis
          if (journey?.composedOf) {
            for (const flowPath of journey.composedOf) {
              addFlow(flowPath)
            }
          }
        }
      }
    } else {
      // 2. Keyword-based flow matching
      const keywords = {
        call: ["callLogs"],
        log: ["callLogs"],
        appointment: ["appointmentTypes"],
        dashboard: ["dashboard"],
        analytics: ["dashboard"],
        auth: ["authentication"],
        login: ["authentication"],
        practice: ["authentication"],
      }

      // Find matching categories
      const matchedCategories = new Set<string>()
      for (const [keyword, cats] of Object.entries(keywords)) {
        if (description.includes(keyword)) {
          cats.forEach((cat) => matchedCategories.add(cat))
        }
      }

      // If no category matched, try all categories
      if (matchedCategories.size === 0) {
        for (const category of Object.keys(flows)) {
          if (category !== "complete" && category !== "authentication") {
            matchedCategories.add(category)
          }
        }
      }

      // Match flows within categories
      for (const category of matchedCategories) {
        const categoryFlows = flows[category]
        if (typeof categoryFlows !== "object") continue

        for (const [flowName, flowDef] of Object.entries(categoryFlows)) {
          const flowPath = `${category}.${flowName}`

          // Check if flow matches description
          const flowNameLower = flowName.toLowerCase()
          const flowDescLower = flowDef.description.toLowerCase()

          // Specific action keywords
          if (description.includes("view") && (flowNameLower.includes("view") || flowDescLower.includes("view"))) {
            addFlow(flowPath)
          } else if (
            (description.includes("add") || description.includes("create")) &&
            (flowNameLower.includes("add") || flowDescLower.includes("add") || flowDescLower.includes("create"))
          ) {
            addFlow(flowPath)
          } else if (
            description.includes("edit") &&
            (flowNameLower.includes("edit") || flowDescLower.includes("edit"))
          ) {
            addFlow(flowPath)
          } else if (
            description.includes("delete") &&
            (flowNameLower.includes("delete") || flowDescLower.includes("delete"))
          ) {
            addFlow(flowPath)
          } else if (
            description.includes("search") &&
            (flowNameLower.includes("search") || flowDescLower.includes("search"))
          ) {
            addFlow(flowPath)
          } else if (
            description.includes("filter") &&
            (flowNameLower.includes("filter") || flowDescLower.includes("filter"))
          ) {
            addFlow(flowPath)
          } else if (
            (description.includes("update") || description.includes("change")) &&
            (flowNameLower.includes("update") || flowDescLower.includes("update"))
          ) {
            addFlow(flowPath)
          } else if (description.includes("crud") || description.includes("all")) {
            // Include all flows for comprehensive testing
            addFlow(flowPath)
          }
        }
      }
    }

    // 3. Add login prerequisite if needed
    if (params.includeLogin && selectedFlows.length > 0) {
      const hasLogin = selectedFlows.some((f) => f.path.includes("authentication"))
      if (!hasLogin) {
        addFlow("authentication.login", true)
      }
    }

    // 4. Limit number of flows
    if (selectedFlows.length > params.maxFlows) {
      // Prioritize: prerequisites first, then by priority level
      selectedFlows.sort((a, b) => {
        if (a.isPrerequisite && !b.isPrerequisite) return -1
        if (!a.isPrerequisite && b.isPrerequisite) return 1

        const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 }
        return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0)
      })

      selectedFlows.splice(params.maxFlows)
    } else {
      // Sort by logical order: prerequisites first, then by category flow order
      selectedFlows.sort((a, b) => {
        if (a.isPrerequisite && !b.isPrerequisite) return -1
        if (!a.isPrerequisite && b.isPrerequisite) return 1
        return 0
      })
    }

    // Calculate totals
    const totalDuration = selectedFlows.reduce((sum, f) => sum + f.expectedDuration, 0)
    const allParams = [...new Set(selectedFlows.flatMap((f) => f.requiredParams))]

    // Format output
    if (selectedFlows.length === 0) {
      return {
        output: `No flows matched the test description: "${params.testDescription}"

Suggestions:
- Try using more specific keywords (e.g., "call logs", "appointment types")
- Use category names: "smoke tests", "critical path", "regression"
- Describe the feature: "test dashboard analytics"
- Use action words: "add", "edit", "delete", "view", "search"

Available test categories:
- Smoke testing
- Critical path
- Regression
- End-to-end journeys

Available features:
- Call logs management
- Appointment types configuration
- Dashboard analytics
- Authentication`,
        title: "Compose Test - No Matches",
      }
    }

    const output = `📋 Composed Test Plan: "${params.testDescription}"

${selectedFlows.length} Flow${selectedFlows.length > 1 ? "s" : ""} Selected:

${selectedFlows
  .map(
    (f, i) =>
      `${i + 1}. ${f.isPrerequisite ? "🔐 " : ""}${f.name}
   Path: ${f.path}
   Priority: ${f.priority.toUpperCase()}
   Duration: ~${f.expectedDuration}ms
   ${f.description}
   ${f.requiredParams.length > 0 ? `   Params: ${f.requiredParams.join(", ")}` : ""}`,
  )
  .join("\n\n")}

Summary:
- Total Flows: ${selectedFlows.length}
- Prerequisites: ${selectedFlows.filter((f) => f.isPrerequisite).length}
- Total Duration: ~${(totalDuration / 1000).toFixed(1)}s
- Required Parameters: ${allParams.length > 0 ? allParams.join(", ") : "None (all have defaults)"}

To Execute This Test Plan:
${selectedFlows.map((f) => `  execute_flow("${f.path}")`).join("\n")}

Or execute them in sequence using the QA agent:
  "Run the following flows: ${selectedFlows.map((f) => f.path).join(", ")}"
`

    return {
      output,
      title: "Test Plan Composed",
      metadata: {
        flowCount: selectedFlows.length,
        flows: selectedFlows.map((f) => f.path),
        totalDuration,
        requiredParams: allParams,
      },
    }
  },
})
