import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./browser_navigate.txt"
import { BrowserManager } from "../browser/manager"

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to navigate to (must start with http:// or https://)"),
    waitFor: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("load")
      .describe("What event to wait for: load (default), domcontentloaded, or networkidle"),
    timeout: z
      .number()
      .default(30000)
      .describe("Timeout in milliseconds (default: 30000, max: 120000)"),
  }),
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    // Limit timeout to max 2 minutes
    const timeout = Math.min(params.timeout, 120000)

    // Ask for permission
    await ctx.ask({
      permission: "browser_navigate",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        waitFor: params.waitFor,
        timeout: timeout,
      },
    })

    try {
      // Use persistent browser manager
      const page = await BrowserManager.navigate(params.url, {
        waitUntil: params.waitFor,
        timeout,
      })

      // Collect page information
      const title = await page.title()
      const finalUrl = page.url() // May differ from params.url due to redirects

      // Note: We can't easily get status code with persistent browser navigation
      // Consider success if we got a title and URL
      const success = Boolean(title && finalUrl)

      return {
        title: `Navigated to: ${title}`,
        output: JSON.stringify(
          {
            success,
            title,
            url: finalUrl,
            requestedUrl: params.url,
            redirected: finalUrl !== params.url,
            waitedFor: params.waitFor,
          },
          null,
          2,
        ),
        metadata: {
          success,
          url: finalUrl,
          title,
        } as any,
      }
    } catch (error) {
      // Handle navigation errors gracefully
      const errorMessage = error instanceof Error ? error.message : String(error)

      return {
        title: "Navigation Failed",
        output: JSON.stringify(
          {
            success: false,
            error: errorMessage,
            url: params.url,
            timeout: timeout,
          },
          null,
          2,
        ),
        metadata: {
          success: false,
          url: params.url,
          title: "",
          error: errorMessage,
        } as any,
      }
    }
    // Note: Browser stays open for next navigation (managed by BrowserManager)
  },
})
