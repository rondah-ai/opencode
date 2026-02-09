import z from "zod"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./browser_interact.txt"
import { BrowserManager } from "../browser/manager"

export const BrowserInteractTool = Tool.define("browser_interact", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().optional().describe("The URL to interact with. If not provided, uses the current page."),
    action: z
      .enum(["click", "type", "fill", "clear", "select", "scroll", "hover", "wait", "press", "check", "uncheck", "verify"])
      .describe("The interaction action to perform"),
    selector: z
      .string()
      .describe("CSS selector for the target element (e.g., 'button#submit', '.login-btn', 'input[name=\"email\"]')"),
    value: z
      .string()
      .optional()
      .describe("Value for type/fill/select/press actions (text to type, option to select, or key to press)"),
    scrollAmount: z
      .number()
      .optional()
      .describe("Pixels to scroll (positive = down, negative = up) - only for scroll action"),
    waitFor: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("load")
      .describe("What to wait for before interacting"),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
    takeScreenshot: z
      .boolean()
      .default(false)
      .describe("Take a screenshot after the interaction"),
    // Verification parameters (for verify action)
    verifyExists: z.boolean().optional().describe("Verify element exists or not (for verify action)"),
    verifyVisible: z.boolean().optional().describe("Verify element is visible or not (for verify action)"),
    verifyContains: z.string().optional().describe("Verify element contains text (for verify action)"),
    verifyCount: z.number().optional().describe("Verify exact element count (for verify action)"),
  }),
  async execute(params, ctx) {
    // Validate URL if provided
    if (params.url && !params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    // Validate action-specific requirements
    if (["type", "fill", "select", "press"].includes(params.action) && !params.value) {
      throw new Error(`Action '${params.action}' requires a 'value' parameter`)
    }

    if (params.action === "scroll" && params.scrollAmount === undefined) {
      throw new Error("Action 'scroll' requires a 'scrollAmount' parameter")
    }

    const timeout = Math.min(params.timeout, 120000)

    // Ask for permission
    await ctx.ask({
      permission: "browser_interact",
      patterns: [params.url || BrowserManager.getCurrentUrl() || "*"],
      always: ["*"],
      metadata: {
        url: params.url,
        action: params.action,
        selector: params.selector,
        value: params.value,
      },
    })

    let screenshotPath: string | undefined

    try {
      // Get or create persistent page
      const page = params.url
        ? await BrowserManager.navigate(params.url, {
            waitUntil: params.waitFor,
            timeout,
          })
        : await BrowserManager.getPage()

      page.setDefaultTimeout(timeout)

      // Perform the interaction
      let interactionResult = ""

      switch (params.action) {
        case "click":
          await page.click(params.selector)
          interactionResult = `Clicked element: ${params.selector}`
          break

        case "type":
          await page.type(params.selector, params.value!)
          interactionResult = `Typed "${params.value}" into: ${params.selector}`
          break

        case "fill":
          await page.fill(params.selector, params.value!)
          interactionResult = `Filled "${params.value}" into: ${params.selector}`
          break

        case "select":
          await page.selectOption(params.selector, params.value!)
          interactionResult = `Selected "${params.value}" in: ${params.selector}`
          break

        case "scroll":
          await page.evaluate((amount) => {
            window.scrollBy(0, amount)
          }, params.scrollAmount!)
          interactionResult = `Scrolled ${params.scrollAmount} pixels`
          break

        case "hover":
          await page.hover(params.selector)
          interactionResult = `Hovered over: ${params.selector}`
          break

        case "wait":
          await page.waitForSelector(params.selector, { state: "visible" })
          interactionResult = `Waited for element to be visible: ${params.selector}`
          break

        case "press":
          await page.press(params.selector, params.value!)
          interactionResult = `Pressed "${params.value}" on: ${params.selector}`
          break

        case "clear":
          await page.fill(params.selector, "")
          interactionResult = `Cleared: ${params.selector}`
          break

        case "check":
          await page.check(params.selector)
          interactionResult = `Checked checkbox: ${params.selector}`
          break

        case "uncheck":
          await page.uncheck(params.selector)
          interactionResult = `Unchecked checkbox: ${params.selector}`
          break

        case "verify": {
          const verifications: string[] = []

          // Verify exists
          if (params.verifyExists !== undefined) {
            const count = await page.locator(params.selector).count()
            if (params.verifyExists && count === 0) {
              throw new Error(`Element not found: ${params.selector}`)
            }
            if (!params.verifyExists && count > 0) {
              throw new Error(`Element should not exist: ${params.selector} (found ${count})`)
            }
            verifications.push(`exists=${params.verifyExists}`)
          }

          // Verify visible
          if (params.verifyVisible !== undefined) {
            const isVisible = await page.locator(params.selector).first().isVisible().catch(() => false)
            if (params.verifyVisible && !isVisible) {
              throw new Error(`Element not visible: ${params.selector}`)
            }
            if (!params.verifyVisible && isVisible) {
              throw new Error(`Element should not be visible: ${params.selector}`)
            }
            verifications.push(`visible=${params.verifyVisible}`)
          }

          // Verify contains
          if (params.verifyContains) {
            const text = await page.locator(params.selector).first().textContent().catch(() => "")
            if (!text?.includes(params.verifyContains)) {
              throw new Error(
                `Element does not contain "${params.verifyContains}". Found: ${text?.substring(0, 100)}`
              )
            }
            verifications.push(`contains="${params.verifyContains}"`)
          }

          // Verify count
          if (params.verifyCount !== undefined) {
            const count = await page.locator(params.selector).count()
            if (count !== params.verifyCount) {
              throw new Error(`Expected ${params.verifyCount} elements, found ${count}`)
            }
            verifications.push(`count=${params.verifyCount}`)
          }

          interactionResult = `Verified ${params.selector}: ${verifications.join(", ")}`
          break
        }

        default:
          throw new Error(`Unknown action: ${params.action}`)
      }

      // Take screenshot if requested
      if (params.takeScreenshot) {
        const screenshotDir = path.join(process.cwd(), ".opencode", "screenshots")
        await Bun.write(Bun.file(path.join(screenshotDir, ".gitkeep")), "").catch(() => {})

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const filename = `interaction-${params.action}-${timestamp}.png`
        screenshotPath = path.join(screenshotDir, filename)

        await page.screenshot({
          path: screenshotPath,
          fullPage: false,
        })
      }

      // Get page info after interaction
      const title = await page.title()
      const currentUrl = page.url()

      return {
        title: `Interaction completed: ${params.action}`,
        output: JSON.stringify(
          {
            success: true,
            action: params.action,
            selector: params.selector,
            value: params.value,
            result: interactionResult,
            url: currentUrl,
            pageTitle: title,
            screenshot: screenshotPath ? path.basename(screenshotPath) : undefined,
          },
          null,
          2,
        ),
        metadata: {
          success: true,
          action: params.action,
          selector: params.selector,
          url: currentUrl,
          screenshot: screenshotPath,
        } as any,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      return {
        title: "Interaction Failed",
        output: JSON.stringify(
          {
            success: false,
            error: errorMessage,
            action: params.action,
            selector: params.selector,
            url: params.url,
          },
          null,
          2,
        ),
        metadata: {
          success: false,
          action: params.action,
          selector: params.selector,
          url: params.url,
          screenshot: undefined,
          error: errorMessage,
        } as any,
      }
    }
    // Note: Browser stays open for next interaction (managed by BrowserManager)
  },
})
