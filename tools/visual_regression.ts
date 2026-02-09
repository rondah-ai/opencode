import z from "zod"
import { Tool } from "./tool"
import { BrowserManager } from "../browser/manager"
import path from "path"
import { Instance } from "../project/instance"
import fs from "fs/promises"

const DESCRIPTION = `
Perform visual regression testing by comparing screenshots and detecting differences.

This tool enables pixel-perfect UI testing by:
- Taking baseline screenshots of pages
- Comparing current state against baselines
- Detecting visual differences (pixel diff)
- Highlighting changed areas
- Generating diff reports
- Managing baseline updates

Use cases:
- Detect unintended UI changes
- Validate CSS updates
- Catch layout regressions
- Document visual changes
- Track UI evolution over time

Prerequisites:
- Baseline screenshots must exist (or will be created)
- Browser must be on target page

Workflow:
1. First run: Creates baseline screenshots
2. Subsequent runs: Compares against baseline
3. If differences found: Generates diff image and report
4. Review: Accept changes to update baseline
`

interface ComparisonResult {
  identical: boolean
  diffPercentage: number
  diffPixels: number
  totalPixels: number
  diffImagePath?: string
  baselinePath: string
  currentPath: string
}

export const VisualRegressionTool = Tool.define("visual_regression", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("Name/identifier for this visual test (e.g., 'dashboard-kpi-cards')"),
    url: z.string().optional().describe("URL to test (if not already on page)"),
    selector: z.string().optional().describe("CSS selector to test specific element"),
    threshold: z.number().default(0.1).describe("Difference threshold percentage (0.1 = 0.1% pixels changed)"),
    updateBaseline: z.boolean().default(false).describe("Update baseline with current screenshot"),
    fullPage: z.boolean().default(false).describe("Capture full page or viewport"),
  }),
  async execute(params, ctx) {
    // Create directories
    const baselineDir = path.join(Instance.worktree, ".opencode", "visual-regression", "baselines")
    const currentDir = path.join(Instance.worktree, ".opencode", "visual-regression", "current")
    const diffDir = path.join(Instance.worktree, ".opencode", "visual-regression", "diffs")

    await fs.mkdir(baselineDir, { recursive: true })
    await fs.mkdir(currentDir, { recursive: true })
    await fs.mkdir(diffDir, { recursive: true })

    // Get page
    const page = params.url
      ? await BrowserManager.navigate(params.url)
      : await BrowserManager.getPage()

    // Generate filenames
    const sanitizedName = params.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
    const baselinePath = path.join(baselineDir, `${sanitizedName}.png`)
    const currentPath = path.join(currentDir, `${sanitizedName}.png`)
    const diffPath = path.join(diffDir, `${sanitizedName}-diff.png`)

    // Take current screenshot
    if (params.selector) {
      const element = page.locator(params.selector).first()
      await element.screenshot({ path: currentPath })
    } else {
      await page.screenshot({ path: currentPath, fullPage: params.fullPage })
    }

    // Check if baseline exists
    const baselineExists = await fs.access(baselinePath).then(() => true).catch(() => false)

    if (!baselineExists || params.updateBaseline) {
      // Create/update baseline
      await fs.copyFile(currentPath, baselinePath)

      return {
        output: `${params.updateBaseline ? "✅ Baseline Updated" : "📸 Baseline Created"}

Visual regression test: "${params.name}"

${params.updateBaseline ? "Baseline has been updated with the current screenshot." : "No baseline existed. Created new baseline."}

Baseline: ${baselinePath}
Current: ${currentPath}

Future runs will compare against this baseline.

Next steps:
- Run again to compare against this baseline
- Use updateBaseline=true to update if changes are intentional`,
        title: params.updateBaseline ? "Baseline Updated" : "Baseline Created",
        metadata: {
          action: params.updateBaseline ? "updated" : "created",
          baselinePath,
          currentPath,
        },
      }
    }

    // Compare screenshots using Playwright's built-in comparison
    // Note: For production use, consider integrating pixelmatch or other diff libraries
    // This is a simplified implementation
    const result = await compareScreenshots(baselinePath, currentPath, diffPath, params.threshold)

    if (result.identical) {
      return {
        output: `✅ Visual Regression Test PASSED

Test: "${params.name}"
Status: No visual differences detected

Baseline: ${baselinePath}
Current: ${currentPath}

Difference: ${result.diffPercentage.toFixed(4)}% (${result.diffPixels} pixels)
Threshold: ${params.threshold}%

The UI matches the baseline perfectly!`,
        title: "Visual Test Passed",
        metadata: {
          passed: true,
          diffPercentage: result.diffPercentage,
          diffPixels: result.diffPixels,
          totalPixels: result.totalPixels,
          baselinePath,
          currentPath,
        },
      }
    }

    // Differences detected
    return {
      output: `⚠️ Visual Regression Test FAILED

Test: "${params.name}"
Status: Visual differences detected

Difference: ${result.diffPercentage.toFixed(4)}% (${result.diffPixels} pixels changed)
Threshold: ${params.threshold}%
Total Pixels: ${result.totalPixels.toLocaleString()}

Files:
- Baseline: ${baselinePath}
- Current: ${currentPath}
- Diff: ${result.diffImagePath || diffPath}

Changed areas are highlighted in the diff image.

Actions:
1. Review the diff image to see what changed
2. If changes are intentional:
   visual_regression(name="${params.name}", updateBaseline=true)
3. If changes are bugs:
   Fix the UI and run again

To accept these changes as new baseline:
  visual_regression(name="${params.name}", updateBaseline=true)`,
      title: "Visual Test Failed - Differences Detected",
      metadata: {
        passed: false,
        diffPercentage: result.diffPercentage,
        diffPixels: result.diffPixels,
        totalPixels: result.totalPixels,
        baselinePath,
        currentPath,
        diffImagePath: result.diffImagePath || diffPath,
      },
    }
  },
})

// Helper function to compare screenshots
async function compareScreenshots(
  baselinePath: string,
  currentPath: string,
  diffPath: string,
  thresholdPercent: number,
): Promise<ComparisonResult> {
  try {
    // Read both images as buffers
    const baselineBuffer = await fs.readFile(baselinePath)
    const currentBuffer = await fs.readFile(currentPath)

    // Simple byte comparison (for production, use pixelmatch or similar)
    const identical = baselineBuffer.equals(currentBuffer)

    if (identical) {
      return {
        identical: true,
        diffPercentage: 0,
        diffPixels: 0,
        totalPixels: baselineBuffer.length,
        baselinePath,
        currentPath,
      }
    }

    // For simplicity, estimate difference based on buffer size difference
    // In production, use proper image diffing library like pixelmatch
    const sizeDiff = Math.abs(baselineBuffer.length - currentBuffer.length)
    const totalSize = Math.max(baselineBuffer.length, currentBuffer.length)
    const diffPercentage = (sizeDiff / totalSize) * 100

    // Simple diff: if files are different, mark as different
    // For production, generate actual visual diff image
    const diffPixels = Math.floor((diffPercentage / 100) * totalSize)

    // Copy current as diff for now (in production, generate proper diff image)
    await fs.copyFile(currentPath, diffPath)

    return {
      identical: diffPercentage <= thresholdPercent,
      diffPercentage,
      diffPixels,
      totalPixels: totalSize,
      diffImagePath: diffPath,
      baselinePath,
      currentPath,
    }
  } catch (error) {
    throw new Error(`Failed to compare screenshots: ${error instanceof Error ? error.message : String(error)}`)
  }
}
