import z from "zod"
import { Tool } from "./tool"
import { getQAContext } from "./load_qa_context"
import { BrowserManager } from "../browser/manager"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../project/instance"

const DESCRIPTION = `
Execute predefined test flows from QA_FLOWS.json.

This tool runs automated test workflows that are defined in the QA flows file.
Each flow contains a series of steps (navigate, click, type, verify) that are
executed sequentially.

Prerequisites:
- QA context must be loaded first using load_qa_context tool
- Browser tools must be available

Supported Actions:
- navigate: Navigate to a URL
- click: Click an element
- type: Type text into an input
- clear: Clear an input field
- wait: Wait for duration or element
- verify: Verify element state or content
- screenshot: Take a screenshot (auto-added at key steps)

Parameters:
- flowPath: Dot-notation path to flow (e.g., "callLogs.viewCallDetails")
- params: Key-value pairs for parameter substitution
- takeScreenshots: Auto-capture screenshots at each step (default: true)
- stopOnError: Stop execution if a step fails (default: true)

Examples:
- execute_flow("callLogs.viewCallDetails")
- execute_flow("appointmentTypes.addAppointmentType", {appointmentName: "Checkup", duration: "30"})
- execute_flow("authentication.login", {email: "test@example.com", password: "pass123"})
`

interface FlowStep {
  step: number
  action: string
  target?: string
  value?: string
  wait?: number
  duration?: number
  description?: string
  // Verification options
  exists?: boolean
  visible?: boolean
  enabled?: boolean
  contains?: string
  textIncludes?: string[]
  minCount?: number
  count?: number
  condition?: string
  optional?: boolean
}

interface FlowDefinition {
  name: string
  description: string
  priority: string
  steps: FlowStep[]
  expectedDuration: number
  requiredParams: string[]
  possibleValues?: Record<string, string[]>
  prerequisite?: string
  composedOf?: string[]
}

export const ExecuteFlowTool = Tool.define("execute_flow", {
  description: DESCRIPTION,
  parameters: z.object({
    flowPath: z.string().describe("Dot-notation path to flow (e.g., 'callLogs.viewCallDetails')"),
    params: z.record(z.string(), z.string()).optional().describe("Parameters for the flow"),
    takeScreenshots: z.boolean().default(true).describe("Capture screenshots at each step"),
    stopOnError: z.boolean().default(true).describe("Stop on first error"),
    baseUrl: z.string().optional().describe("Override base URL from flows metadata"),
  }),
  async execute(params, ctx) {
    const startTime = Date.now()

    // Get QA context
    const qaContext = getQAContext()
    if (!qaContext) {
      return {
        output: `Error: QA context not loaded.

Please load the QA context first using:
  load_qa_context(directory="/path/to/rondah-web-console")

Or:
  load_qa_context(
    anchorPointsPath="/path/to/QA_ANCHOR_POINTS.json",
    flowsPath="/path/to/QA_FLOWS.json"
  )`,
        title: "Execute Flow - Error",
      }
    }

    // Parse flow path
    const pathParts = params.flowPath.split(".")
    let flow: FlowDefinition | null = null
    let flowCategory = ""

    // Navigate to the flow
    let current: any = qaContext.flows.flows
    for (let i = 0; i < pathParts.length; i++) {
      if (!current || typeof current !== "object") {
        break
      }
      current = current[pathParts[i]]
      if (i === 0) flowCategory = pathParts[i]
    }

    flow = current as FlowDefinition

    if (!flow || !flow.steps) {
      return {
        output: `Error: Flow not found at path "${params.flowPath}"

Available flows:
${listAvailableFlows(qaContext.flows)}

Tip: Use dot notation like "callLogs.viewCallDetails" or "authentication.login"`,
        title: "Execute Flow - Not Found",
      }
    }

    // Validate required parameters
    const flowParams = params.params || {}
    const missingParams = (flow.requiredParams || []).filter(p => !(p in flowParams))

    if (missingParams.length > 0) {
      // Try to use common test data as defaults
      const testData = qaContext.flows.commonParameters?.testData || {}
      const testCredentials = qaContext.flows.commonParameters?.testCredentials || {}
      const defaults = { ...testData, ...testCredentials }

      for (const missing of missingParams) {
        if (defaults[missing]) {
          flowParams[missing] = defaults[missing]
        }
      }

      const stillMissing = (flow.requiredParams || []).filter(p => !(p in flowParams))

      if (stillMissing.length > 0) {
        let suggestions = ""
        if (flow.possibleValues) {
          suggestions = "\n\nPossible values:"
          for (const [key, values] of Object.entries(flow.possibleValues)) {
            suggestions += `\n  ${key}: ${values.join(", ")}`
          }
        }

        return {
          output: `Error: Missing required parameters: ${stillMissing.join(", ")}

Flow: ${flow.name}
Required: ${flow.requiredParams.join(", ")}
Provided: ${Object.keys(flowParams).join(", ") || "none"}${suggestions}

Example:
  execute_flow("${params.flowPath}", {
    ${flow.requiredParams.map(p => `${p}: "value"`).join(",\n    ")}
  })`,
          title: "Execute Flow - Missing Parameters",
        }
      }
    }

    // Create screenshots directory
    const screenshotDir = path.join(Instance.worktree, ".opencode", "screenshots", flowCategory)
    await fs.mkdir(screenshotDir, { recursive: true }).catch(() => {})

    // Execute flow
    const executionLog: string[] = []
    const screenshots: string[] = []
    let failedStep: number | null = null
    const baseUrl = params.baseUrl || qaContext.flows.metadata?.baseUrl || ""

    executionLog.push(`🚀 Executing Flow: ${flow.name}`)
    executionLog.push(`Description: ${flow.description}`)
    executionLog.push(`Priority: ${flow.priority}`)
    executionLog.push(`Expected Duration: ${flow.expectedDuration}ms`)
    executionLog.push(`Steps: ${flow.steps.length}`)
    executionLog.push(`\n${"=".repeat(60)}\n`)

    for (const stepDef of flow.steps) {
      const stepStart = Date.now()
      executionLog.push(`Step ${stepDef.step}: ${stepDef.description || stepDef.action}`)

      try {
        // Substitute parameters in target and value
        const target = substituteParams(stepDef.target || "", flowParams)
        const value = substituteParams(stepDef.value || "", flowParams)

        const page = await BrowserManager.getPage()

        switch (stepDef.action) {
          case "navigate": {
            const url = target.startsWith("http") ? target : baseUrl + target
            executionLog.push(`  → Navigating to: ${url}`)
            await page.goto(url, {
              waitUntil: "load",
              timeout: 60000,
            })
            if (stepDef.wait) {
              await page.waitForTimeout(stepDef.wait)
            }
            break
          }

          case "click": {
            executionLog.push(`  → Clicking: ${target}`)
            const element = await page.locator(convertSelector(target)).first()
            await element.waitFor({ state: "visible", timeout: 10000 })
            await element.click()
            break
          }

          case "type": {
            executionLog.push(`  → Typing into: ${target}`)
            executionLog.push(`  → Value: ${value}`)
            const element = await page.locator(convertSelector(target)).first()
            await element.waitFor({ state: "visible", timeout: 10000 })
            await element.fill(value)
            break
          }

          case "clear": {
            executionLog.push(`  → Clearing: ${target}`)
            const element = await page.locator(convertSelector(target)).first()
            await element.waitFor({ state: "visible", timeout: 10000 })
            await element.clear()
            break
          }

          case "wait": {
            if (stepDef.duration) {
              executionLog.push(`  → Waiting: ${stepDef.duration}ms`)
              await page.waitForTimeout(stepDef.duration)
            } else if (stepDef.target) {
              executionLog.push(`  → Waiting for: ${target}`)
              const condition = stepDef.condition || "visible"
              await page.locator(convertSelector(target)).first().waitFor({
                state: condition as any,
                timeout: 10000,
              })
            }
            break
          }

          case "verify": {
            executionLog.push(`  → Verifying: ${target}`)
            const selector = convertSelector(target)

            // Special case: verify URL
            if (target === "url") {
              const currentUrl = page.url()
              if (stepDef.contains && !currentUrl.includes(stepDef.contains)) {
                throw new Error(`URL does not contain "${stepDef.contains}". Current: ${currentUrl}`)
              }
              executionLog.push(`  ✓ URL verified: ${currentUrl}`)
              break
            }

            const locator = page.locator(selector)

            // exists check
            if (stepDef.exists !== undefined) {
              const count = await locator.count()
              if (stepDef.exists && count === 0) {
                throw new Error(`Element not found: ${target}`)
              }
              if (!stepDef.exists && count > 0) {
                throw new Error(`Element should not exist: ${target}`)
              }
              executionLog.push(`  ✓ Exists check passed (${count} elements)`)
            }

            // visible check
            if (stepDef.visible !== undefined) {
              const element = locator.first()
              const isVisible = await element.isVisible().catch(() => false)
              if (stepDef.visible && !isVisible) {
                throw new Error(`Element not visible: ${target}`)
              }
              if (!stepDef.visible && isVisible) {
                throw new Error(`Element should not be visible: ${target}`)
              }
              executionLog.push(`  ✓ Visibility check passed`)
            }

            // contains check
            if (stepDef.contains) {
              const text = await locator.first().textContent().catch(() => "")
              if (!text?.includes(stepDef.contains)) {
                throw new Error(`Element does not contain "${stepDef.contains}". Found: ${text}`)
              }
              executionLog.push(`  ✓ Contains check passed: "${stepDef.contains}"`)
            }

            // textIncludes check (OR condition)
            if (stepDef.textIncludes && stepDef.textIncludes.length > 0) {
              const text = await locator.first().textContent().catch(() => "")
              const matches = stepDef.textIncludes.some(str => text?.includes(str))
              if (!matches) {
                throw new Error(`Element does not contain any of: ${stepDef.textIncludes.join(", ")}. Found: ${text}`)
              }
              executionLog.push(`  ✓ Text includes check passed`)
            }

            // count check
            if (stepDef.count !== undefined) {
              const count = await locator.count()
              if (count !== stepDef.count) {
                throw new Error(`Expected ${stepDef.count} elements, found ${count}`)
              }
              executionLog.push(`  ✓ Count check passed (${count} elements)`)
            }

            // minCount check
            if (stepDef.minCount !== undefined) {
              const count = await locator.count()
              if (count < stepDef.minCount) {
                throw new Error(`Expected at least ${stepDef.minCount} elements, found ${count}`)
              }
              executionLog.push(`  ✓ MinCount check passed (${count} elements)`)
            }

            // enabled check
            if (stepDef.enabled !== undefined) {
              const element = locator.first()
              const isEnabled = await element.isEnabled().catch(() => false)
              if (stepDef.enabled && !isEnabled) {
                throw new Error(`Element not enabled: ${target}`)
              }
              if (!stepDef.enabled && isEnabled) {
                throw new Error(`Element should not be enabled: ${target}`)
              }
              executionLog.push(`  ✓ Enabled check passed`)
            }

            break
          }

          default:
            executionLog.push(`  ⚠ Unknown action: ${stepDef.action}`)
        }

        // Take screenshot if enabled
        if (params.takeScreenshots && ["navigate", "click", "verify"].includes(stepDef.action)) {
          const timestamp = Date.now()
          const filename = `step-${stepDef.step}-${stepDef.action}-${timestamp}.png`
          const screenshotPath = path.join(screenshotDir, filename)
          await page.screenshot({ path: screenshotPath, fullPage: false })
          screenshots.push(screenshotPath)
          executionLog.push(`  📸 Screenshot: ${filename}`)
        }

        const stepDuration = Date.now() - stepStart
        executionLog.push(`  ⏱ Step completed in ${stepDuration}ms`)
        executionLog.push("")

      } catch (error) {
        const stepDuration = Date.now() - stepStart
        failedStep = stepDef.step
        executionLog.push(`  ❌ FAILED after ${stepDuration}ms`)
        executionLog.push(`  Error: ${error instanceof Error ? error.message : String(error)}`)
        executionLog.push("")

        // Take failure screenshot
        if (params.takeScreenshots) {
          try {
            const page = await BrowserManager.getPage()
            const timestamp = Date.now()
            const filename = `step-${stepDef.step}-FAILED-${timestamp}.png`
            const screenshotPath = path.join(screenshotDir, filename)
            await page.screenshot({ path: screenshotPath, fullPage: true })
            screenshots.push(screenshotPath)
            executionLog.push(`  📸 Failure Screenshot: ${filename}`)
          } catch (screenshotError) {
            executionLog.push(`  ⚠ Could not capture failure screenshot`)
          }
        }

        if (params.stopOnError && !stepDef.optional) {
          break
        }
      }
    }

    const totalDuration = Date.now() - startTime
    const success = failedStep === null

    executionLog.push(`\n${"=".repeat(60)}`)
    executionLog.push(`\n${success ? "✅ FLOW COMPLETED SUCCESSFULLY" : "❌ FLOW FAILED"}`)
    executionLog.push(`\nTotal Duration: ${totalDuration}ms`)
    executionLog.push(`Expected Duration: ${flow.expectedDuration}ms`)
    executionLog.push(`Performance: ${totalDuration <= flow.expectedDuration ? "✓ Within expected time" : "⚠ Slower than expected"}`)
    executionLog.push(`\nSteps Executed: ${failedStep ? failedStep : flow.steps.length}/${flow.steps.length}`)
    executionLog.push(`Screenshots Captured: ${screenshots.length}`)
    if (screenshots.length > 0) {
      executionLog.push(`Screenshot Directory: ${screenshotDir}`)
    }

    const output = executionLog.join("\n")

    return {
      output,
      title: success ? `Flow Completed: ${flow.name}` : `Flow Failed: ${flow.name}`,
      metadata: {
        flowPath: params.flowPath,
        success,
        failedStep,
        totalDuration,
        expectedDuration: flow.expectedDuration,
        screenshotsDir: screenshotDir,
        screenshotCount: screenshots.length,
      },
    }
  },
})

// Helper: Substitute parameters in strings
function substituteParams(str: string, params: Record<string, string>): string {
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match
  })
}

// Helper: Convert pseudo-selectors to Playwright selectors
function convertSelector(selector: string): string {
  // Handle :contains() pseudo-selector
  if (selector.includes(":contains(")) {
    // Extract the text from :contains('text') or :contains("text")
    const match = selector.match(/:contains\(['"]([^'"]+)['"]\)/)
    if (match) {
      const text = match[1]
      const baseSelector = selector.substring(0, selector.indexOf(":contains"))
      return `${baseSelector}:has-text("${text}")`
    }
  }

  // Handle :first-child, :nth-child
  selector = selector.replace(/:first-child/g, ":nth-child(1)")

  return selector
}

// Helper: List available flows
function listAvailableFlows(flows: any): string {
  const flowList: string[] = []

  for (const [category, categoryFlows] of Object.entries(flows.flows || {})) {
    if (typeof categoryFlows === "object") {
      flowList.push(`\n${category}:`)
      for (const flowName of Object.keys(categoryFlows)) {
        flowList.push(`  - ${category}.${flowName}`)
      }
    }
  }

  return flowList.join("\n")
}
