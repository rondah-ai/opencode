import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./scan_page.txt"
import { BrowserManager } from "../browser/manager"
import { getInstructions, isRouteExcluded } from "../qa/instructions"
import {
  matchPatterns,
  extractPatternDetails,
  runAllSmokeChecks,
  UI_PATTERNS,
  type PatternMatch,
} from "../qa/patterns"

export const ScanPageTool = Tool.define("scan_page", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z
      .string()
      .describe("The URL to scan (must start with http:// or https://)"),
    waitFor: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("networkidle")
      .describe("What to wait for before scanning"),
    screenshot: z
      .boolean()
      .default(false)
      .describe("Capture a screenshot during scan"),
    runSmoke: z
      .boolean()
      .default(false)
      .describe("Run smoke checks against detected patterns"),
    timeout: z
      .number()
      .default(30000)
      .describe("Navigation timeout in ms (default: 30000, max: 120000)"),
  }),
  async execute(params, ctx) {
    if (
      !params.url.startsWith("http://") &&
      !params.url.startsWith("https://")
    ) {
      throw new Error("URL must start with http:// or https://")
    }

    // Apply instructions overrides if loaded
    const instructions = getInstructions()
    const instructionTimeout = instructions?.global.defaultTimeout
    const timeout = Math.min(params.timeout || instructionTimeout || 30000, 120000)

    // Check route exclusion from instructions
    const route = new URL(params.url).pathname
    if (isRouteExcluded(route)) {
      return {
        title: `Scan: ${route} (excluded)`,
        output: `Route ${route} is excluded by QA_INSTRUCTIONS.json scope.exclude_routes`,
        metadata: { excluded: true, route },
      }
    }

    await ctx.ask({
      permission: "scan_page",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        waitFor: params.waitFor,
        timeout,
      },
    })

    const startTime = Date.now()

    // Navigate to the page
    const page = await BrowserManager.navigate(params.url, {
      waitUntil: params.waitFor,
      timeout,
    })

    // Wait for page stability — no pending network requests for 500ms
    await page
      .waitForLoadState("networkidle", { timeout: 5000 })
      .catch(() => {})

    const title = await page.title()
    const finalUrl = page.url()
    const route = new URL(finalUrl).pathname

    // ── Pattern matching ──────────────────────────────────────────────
    const matches = await matchPatterns(page, UI_PATTERNS)

    // Extract details for each matched pattern
    const patternsWithDetails: (PatternMatch & {
      details?: Record<string, unknown>
    })[] = []
    for (const match of matches) {
      const details = await extractPatternDetails(page, match, UI_PATTERNS)
      patternsWithDetails.push({
        ...match,
        details: Object.keys(details).length > 0 ? details : undefined,
      })
    }

    // ── Smoke checks (optional) ───────────────────────────────────────
    let smokeResults:
      | { pattern: string; checks: { name: string; passed: boolean; error?: string }[] }[]
      | undefined

    if (params.runSmoke) {
      smokeResults = []
      for (const match of matches) {
        const checks = await runAllSmokeChecks(page, match, UI_PATTERNS)
        if (checks.length > 0) {
          smokeResults.push({ pattern: match.type, checks })
        }
      }
    }

    // ── Interactive elements ──────────────────────────────────────────
    const buttons = await collectElements(page, "button:visible", async (el) => ({
      text: ((await el.textContent()) ?? "").trim(),
      selector: await buildSelector(el),
      enabled: await el.isEnabled().catch(() => false),
    }))

    const inputs = await collectElements(
      page,
      "input:visible:not([type='hidden']), select:visible, textarea:visible",
      async (el) => ({
        type: (await el.getAttribute("type")) ?? (await el.evaluate((e) => e.tagName.toLowerCase())),
        name: (await el.getAttribute("name")) ?? "",
        placeholder: (await el.getAttribute("placeholder")) ?? "",
        selector: await buildSelector(el),
      }),
    )

    const linkCount = await page.locator("a[href]").count()

    // ── Outbound routes ───────────────────────────────────────────────
    const origin = new URL(finalUrl).origin
    const outboundRoutes = await collectOutboundRoutes(page, origin)

    // ── Screenshot (optional) ─────────────────────────────────────────
    let screenshotPath: string | undefined
    if (params.screenshot) {
      const fs = await import("fs")
      const path = await import("path")
      const dir = ".opencode/screenshots/scan"
      fs.mkdirSync(dir, { recursive: true })
      const slug = route.replace(/\//g, "-").replace(/^-/, "") || "root"
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      screenshotPath = path.join(dir, `${slug}-${timestamp}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
    }

    const scanDuration = Date.now() - startTime

    // ── Format output ─────────────────────────────────────────────────
    const patternSummary = patternsWithDetails
      .map(
        (p) =>
          `  ${p.type} (${Math.round(p.confidence * 100)}% — ${p.signalHits}/${p.totalSignals} signals)`,
      )
      .join("\n")

    const smokeSummary = smokeResults
      ? smokeResults
          .map((sr) => {
            const passed = sr.checks.filter((c) => c.passed).length
            const total = sr.checks.length
            return `  ${sr.pattern}: ${passed}/${total} passed`
          })
          .join("\n")
      : undefined

    const output = [
      `Page Scan: ${route}`,
      `Title: ${title}`,
      `URL: ${finalUrl}`,
      `Scan duration: ${scanDuration}ms`,
      "",
      `Patterns detected (${patternsWithDetails.length}):`,
      patternSummary || "  (none)",
      ...(smokeSummary
        ? ["", "Smoke checks:", smokeSummary]
        : []),
      "",
      `Interactive elements: ${buttons.length} buttons, ${inputs.length} inputs, ${linkCount} links`,
      `Outbound routes: ${outboundRoutes.length}`,
      ...(screenshotPath ? [`Screenshot: ${screenshotPath}`] : []),
    ].join("\n")

    return {
      title: `Page Scan: ${route}`,
      output,
      metadata: {
        success: true,
        route,
        title,
        url: finalUrl,
        patterns: patternsWithDetails,
        smokeResults,
        interactiveElements: {
          buttons,
          inputs,
          links: linkCount,
        },
        outboundRoutes,
        screenshotPath,
        scanDuration,
      },
    }
  },
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collectElements<T>(
  page: import("playwright").Page,
  selector: string,
  mapper: (el: import("playwright").Locator) => Promise<T>,
  limit = 30,
): Promise<T[]> {
  const locator = page.locator(selector)
  const count = Math.min(await locator.count(), limit)
  const results: T[] = []
  for (let i = 0; i < count; i++) {
    try {
      results.push(await mapper(locator.nth(i)))
    } catch {
      // Element may have gone stale, skip
    }
  }
  return results
}

async function buildSelector(el: import("playwright").Locator): Promise<string> {
  // Try to build a meaningful selector from element attributes
  const id = await el.getAttribute("id").catch(() => null)
  if (id) return `#${id}`

  const ariaLabel = await el.getAttribute("aria-label").catch(() => null)
  const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "")
  if (ariaLabel) return `${tag}[aria-label='${ariaLabel}']`

  const name = await el.getAttribute("name").catch(() => null)
  if (name) return `${tag}[name='${name}']`

  const type = await el.getAttribute("type").catch(() => null)
  const text = ((await el.textContent().catch(() => "")) ?? "").trim()
  if (text && text.length < 40) return `${tag}:has-text('${text.replace(/'/g, "\\'")}')`
  if (type) return `${tag}[type='${type}']`

  return tag
}

async function collectOutboundRoutes(
  page: import("playwright").Page,
  origin: string,
): Promise<string[]> {
  const links = page.locator("a[href]")
  const count = await links.count()
  const routes = new Set<string>()

  for (let i = 0; i < Math.min(count, 100); i++) {
    try {
      const href = await links.nth(i).getAttribute("href")
      if (!href) continue

      // Resolve relative URLs
      let absolute: string
      try {
        absolute = new URL(href, origin).href
      } catch {
        continue
      }

      // Only same-origin links
      if (!absolute.startsWith(origin)) continue

      const pathname = new URL(absolute).pathname
      // Skip anchors, javascript:, mailto:, etc.
      if (pathname && pathname !== "#") {
        routes.add(pathname)
      }
    } catch {
      // Stale element, skip
    }
  }

  return Array.from(routes).sort()
}
