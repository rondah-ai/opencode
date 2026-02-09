import z from "zod"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./screenshot.txt"
import { BrowserManager } from "../browser/manager"
import { Instance } from "../project/instance"

export const ScreenshotTool = Tool.define("screenshot", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().optional().describe("The URL to screenshot. If not provided, uses the current page."),
    fullPage: z
      .boolean()
      .default(false)
      .describe("Capture full scrollable page (true) or just viewport (false, default)"),
    filename: z.string().optional().describe("Optional custom filename (without extension)"),
    context: z.string().optional().describe("Test context (e.g., 'login', 'callLogs', 'dashboard') for organized storage"),
    element: z.string().optional().describe("CSS selector to screenshot specific element instead of full page"),
    waitFor: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("load")
      .describe("What event to wait for before taking screenshot"),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
  }),
  async execute(params, ctx) {
    // Validate URL if provided
    if (params.url && !params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    // Limit timeout
    const timeout = Math.min(params.timeout, 120000)

    // Ask for permission
    await ctx.ask({
      permission: "screenshot",
      patterns: [params.url || BrowserManager.getCurrentUrl() || "*"],
      always: ["*"],
      metadata: {
        url: params.url,
        fullPage: params.fullPage,
        filename: params.filename,
      },
    })

    try {
      // Get or navigate to page
      const page = params.url
        ? await BrowserManager.navigate(params.url, {
            waitUntil: params.waitFor,
            timeout,
          })
        : await BrowserManager.getPage()

      // Create screenshots directory with context-aware organization
      let screenshotDir = path.join(Instance.worktree, ".opencode", "screenshots")

      // Organize by context if provided
      if (params.context) {
        screenshotDir = path.join(screenshotDir, params.context)
      }

      await Bun.write(Bun.file(path.join(screenshotDir, ".gitkeep")), "")
        .catch(() => {})

      // Generate smart filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      let baseFilename = params.filename

      if (!baseFilename) {
        // Auto-generate descriptive filename based on URL or context
        const currentUrl = page.url()
        const urlPath = new URL(currentUrl).pathname
        const pageName = urlPath.split("/").filter(Boolean).pop() || "page"
        baseFilename = params.context
          ? `${params.context}-${pageName}-${timestamp}`
          : `screenshot-${timestamp}`
      }

      const filename = `${baseFilename}.png`
      const filepath = path.join(screenshotDir, filename)

      // Take screenshot (element or full page)
      if (params.element) {
        const element = page.locator(params.element).first()
        await element.screenshot({ path: filepath })
      } else {
        await page.screenshot({
          path: filepath,
          fullPage: params.fullPage,
        })
      }

      // Get file size
      const file = Bun.file(filepath)
      const fileSize = file.size || 0
      const fileSizeKB = (fileSize / 1024).toFixed(2)

      return {
        title: `Screenshot saved: ${filename}`,
        output: JSON.stringify(
          {
            success: true,
            filename,
            filepath,
            url: params.url,
            fullPage: params.fullPage,
            fileSizeKB: `${fileSizeKB} KB`,
          },
          null,
          2,
        ),
        metadata: {
          success: true,
          filepath,
          filename,
          fileSize,
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      return {
        title: "Screenshot Failed",
        output: JSON.stringify(
          {
            success: false,
            error: errorMessage,
            url: params.url,
          },
          null,
          2,
        ),
        metadata: {
          success: false,
          filepath: "",
          filename: "",
          fileSize: 0,
          error: errorMessage,
        } as any,
      }
    }
    // Note: Browser stays open for next screenshot (managed by BrowserManager)
  },
})
