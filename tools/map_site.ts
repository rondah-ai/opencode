import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./map_site.txt"
import { BrowserManager } from "../browser/manager"
import { getInstructions } from "../qa/instructions"
import {
  matchPatterns,
  extractPatternDetails,
  runAllSmokeChecks,
  UI_PATTERNS,
  type PatternMatch,
} from "../qa/patterns"

// ─── Types ───────────────────────────────────────────────────────────────────

interface PageScan {
  url: string
  route: string
  title: string
  patterns: (PatternMatch & { details?: Record<string, unknown> })[]
  interactiveElements: {
    buttons: { text: string; selector: string }[]
    inputs: { type: string; name: string; placeholder: string }[]
    links: number
  }
  outboundRoutes: string[]
  consoleErrors: { type: string; text: string }[]
  scanDuration: number
  success: boolean
  error?: string
}

interface SmokeResult {
  route: string
  pattern: string
  checks: { name: string; passed: boolean; error?: string }[]
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const MapSiteTool = Tool.define("map_site", {
  description: DESCRIPTION,
  parameters: z.object({
    rootUrl: z
      .string()
      .describe("The root URL to start crawling from (must start with http:// or https://)"),
    maxPages: z
      .number()
      .default(20)
      .describe("Maximum number of pages to scan (default: 20)"),
    loginUrl: z
      .string()
      .optional()
      .describe("Login page URL — if provided, will authenticate before crawling"),
    email: z
      .string()
      .optional()
      .describe("Email/username for login"),
    password: z
      .string()
      .optional()
      .describe("Password for login"),
    excludePatterns: z
      .array(z.string())
      .default([])
      .describe("URL path patterns to skip (e.g., ['/settings', '/admin'])"),
    runSmoke: z
      .boolean()
      .default(true)
      .describe("Run smoke checks on detected patterns (default: true)"),
    timeout: z
      .number()
      .default(30000)
      .describe("Per-page navigation timeout in ms (default: 30000)"),
  }),
  async execute(params, ctx) {
    if (
      !params.rootUrl.startsWith("http://") &&
      !params.rootUrl.startsWith("https://")
    ) {
      throw new Error("rootUrl must start with http:// or https://")
    }

    await ctx.ask({
      permission: "map_site",
      patterns: [params.rootUrl],
      always: ["*"],
      metadata: {
        rootUrl: params.rootUrl,
        maxPages: params.maxPages,
        hasAuth: Boolean(params.loginUrl),
      },
    })

    const startTime = Date.now()
    const origin = new URL(params.rootUrl).origin
    const siteModel: Record<string, PageScan> = {}
    const smokeResults: SmokeResult[] = []
    const visited = new Set<string>()
    const queue: string[] = []
    let authSuccess: boolean | undefined

    // Merge instructions into params where applicable
    const instructions = getInstructions()
    const excludePatterns = [
      ...params.excludePatterns,
      ...(instructions?.scope.exclude_routes ?? []),
    ]
    const maxPages = params.maxPages || instructions?.scope.max_pages || 20
    const timeout = params.timeout || instructions?.global.defaultTimeout || 30000

    // ── Step A: Authentication ─────────────────────────────────────────
    if (params.loginUrl && params.email && params.password) {
      authSuccess = await performAuth(
        params.loginUrl,
        params.email,
        params.password,
        timeout,
      )
      if (!authSuccess) {
        return {
          title: "Site Map: Authentication Failed",
          output: `Failed to authenticate at ${params.loginUrl}. Check credentials and login page structure.`,
          metadata: {
            success: false,
            error: "auth_failed",
            loginUrl: params.loginUrl,
          },
        }
      }

      // After login, use the redirected URL as starting point if rootUrl is the login page
      const currentUrl = BrowserManager.getCurrentUrl()
      if (currentUrl && normalizeUrl(currentUrl) !== normalizeUrl(params.loginUrl)) {
        queue.push(currentUrl)
      }
    }

    // Seed the queue
    if (queue.length === 0) {
      queue.push(params.rootUrl)
    }

    // ── Step B: BFS Crawl ──────────────────────────────────────────────
    while (queue.length > 0 && visited.size < maxPages) {
      const url = queue.shift()!
      const normalized = normalizeUrl(url)

      if (visited.has(normalized)) continue
      if (isExcluded(normalized, excludePatterns, origin)) continue

      visited.add(normalized)

      ctx.metadata({
        title: `Scanning ${visited.size}/${maxPages}: ${new URL(normalized).pathname}`,
      })

      const scan = await scanSinglePage(url, origin, timeout)
      const route = scan.route
      siteModel[route] = scan

      if (scan.success) {
        // Add outbound routes to queue
        for (const outRoute of scan.outboundRoutes) {
          const outUrl = origin + outRoute
          const outNorm = normalizeUrl(outUrl)
          if (!visited.has(outNorm) && !isExcluded(outNorm, excludePatterns, origin)) {
            queue.push(outUrl)
          }
        }

        // Also extract nav_sidebar links (Decision 4 from plan)
        const navPattern = scan.patterns.find((p) => p.type === "nav_sidebar")
        if (navPattern?.details?.links && Array.isArray(navPattern.details.links)) {
          for (const link of navPattern.details.links as { href: string }[]) {
            if (!link.href) continue
            try {
              const linkUrl = new URL(link.href, origin).href
              if (!linkUrl.startsWith(origin)) continue
              const linkNorm = normalizeUrl(linkUrl)
              if (!visited.has(linkNorm) && !isExcluded(linkNorm, excludePatterns, origin)) {
                queue.push(linkUrl)
              }
            } catch {
              // Invalid URL, skip
            }
          }
        }
      }

      // Rate limit: 500ms between pages
      await new Promise((r) => setTimeout(r, 500))
    }

    // ── Step C: Smoke Checks ───────────────────────────────────────────
    if (params.runSmoke) {
      ctx.metadata({ title: "Running smoke checks..." })

      for (const [route, scan] of Object.entries(siteModel)) {
        if (!scan.success || scan.patterns.length === 0) continue

        // Navigate back to the page for smoke checks
        try {
          const page = await BrowserManager.navigate(scan.url, {
            waitUntil: "networkidle",
            timeout,
          })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

          for (const pattern of scan.patterns) {
            const checks = await runAllSmokeChecks(page, pattern, UI_PATTERNS)
            if (checks.length > 0) {
              smokeResults.push({
                route,
                pattern: pattern.type,
                checks,
              })
            }
          }
        } catch {
          // Page failed to load for smoke, skip
        }

        await new Promise((r) => setTimeout(r, 300))
      }
    }

    // ── Step D: Save Results ───────────────────────────────────────────
    const fs = await import("fs")
    const path = await import("path")
    const dir = ".opencode/site-maps"
    fs.mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

    const modelPath = path.join(dir, `site-model-${timestamp}.json`)
    fs.writeFileSync(modelPath, JSON.stringify(siteModel, null, 2))

    let smokePath: string | undefined
    if (params.runSmoke && smokeResults.length > 0) {
      smokePath = path.join(dir, `smoke-report-${timestamp}.json`)
      const totalChecks = smokeResults.reduce((sum, sr) => sum + sr.checks.length, 0)
      const totalPassed = smokeResults.reduce(
        (sum, sr) => sum + sr.checks.filter((c) => c.passed).length,
        0,
      )
      fs.writeFileSync(
        smokePath,
        JSON.stringify({ totalChecks, totalPassed, totalFailed: totalChecks - totalPassed, results: smokeResults }, null, 2),
      )
    }

    // ── Step E: Format Output ──────────────────────────────────────────
    const totalDuration = Date.now() - startTime
    const pages = Object.values(siteModel)
    const successPages = pages.filter((p) => p.success)
    const failedPages = pages.filter((p) => !p.success)
    const allPatterns = successPages.flatMap((p) => p.patterns)
    const totalConsoleErrors = pages.reduce((sum, p) => sum + p.consoleErrors.length, 0)

    const smokeTotal = smokeResults.reduce((sum, sr) => sum + sr.checks.length, 0)
    const smokePassed = smokeResults.reduce(
      (sum, sr) => sum + sr.checks.filter((c) => c.passed).length,
      0,
    )

    const output = [
      `Site Map: ${origin}`,
      `Pages scanned: ${successPages.length}/${visited.size} (${failedPages.length} failed)`,
      `Total patterns detected: ${allPatterns.length}`,
      `Console errors captured: ${totalConsoleErrors}`,
      `Duration: ${(totalDuration / 1000).toFixed(1)}s`,
      "",
      "Pages:",
      ...Object.entries(siteModel).map(([route, scan]) => {
        const patterns = scan.patterns.map((p) => `${p.type}(${Math.round(p.confidence * 100)}%)`).join(", ")
        return `  ${scan.success ? "✓" : "✗"} ${route} — ${patterns || "(no patterns)"}`
      }),
      ...(params.runSmoke && smokeTotal > 0
        ? [
            "",
            `Smoke checks: ${smokePassed}/${smokeTotal} passed`,
            ...smokeResults
              .filter((sr) => sr.checks.some((c) => !c.passed))
              .map((sr) => {
                const failed = sr.checks.filter((c) => !c.passed).map((c) => c.name)
                return `  ✗ ${sr.route} [${sr.pattern}]: ${failed.join(", ")}`
              }),
          ]
        : []),
      ...(authSuccess !== undefined
        ? ["", `Auth: ${authSuccess ? "success" : "failed"}`]
        : []),
      "",
      `Site model saved: ${modelPath}`,
      ...(smokePath ? [`Smoke report saved: ${smokePath}`] : []),
    ].join("\n")

    return {
      title: `Site Map: ${origin} (${successPages.length} pages)`,
      output,
      metadata: {
        success: true,
        origin,
        pagesScanned: successPages.length,
        pagesFailed: failedPages.length,
        totalPatterns: allPatterns.length,
        totalConsoleErrors,
        smokeChecks: params.runSmoke ? { total: smokeTotal, passed: smokePassed, failed: smokeTotal - smokePassed } : undefined,
        authSuccess,
        siteModel,
        smokeResults: params.runSmoke ? smokeResults : undefined,
        modelPath,
        smokePath,
        duration: totalDuration,
      },
    }
  },
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ""
    u.pathname = u.pathname.replace(/\/$/, "") || "/"
    u.searchParams.sort()
    return u.toString()
  } catch {
    return url
  }
}

function isExcluded(url: string, excludePatterns: string[], origin: string): boolean {
  try {
    const pathname = new URL(url).pathname
    return excludePatterns.some((pattern) => pathname.startsWith(pattern))
  } catch {
    return false
  }
}

async function performAuth(
  loginUrl: string,
  email: string,
  password: string,
  timeout: number,
): Promise<boolean> {
  try {
    const page = await BrowserManager.navigate(loginUrl, {
      waitUntil: "networkidle",
      timeout,
    })
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

    // Detect auth_form pattern
    const matches = await matchPatterns(page, UI_PATTERNS)
    const authPattern = matches.find((m) => m.type === "auth_form")

    if (!authPattern) {
      // Try common selectors as fallback
      const emailInput = page.locator(
        "input[type='email'], input[name='email'], input[type='text'][name*='user']",
      )
      const passwordInput = page.locator("input[type='password']")

      if ((await emailInput.count()) === 0 || (await passwordInput.count()) === 0) {
        return false
      }

      await emailInput.first().fill(email)
      await passwordInput.first().fill(password)
    } else {
      // Use pattern-extracted selectors
      const details = await extractPatternDetails(page, authPattern, UI_PATTERNS)
      const emailSel =
        (details.emailInput as { selector?: string })?.selector ??
        "input[type='email'], input[name='email']"
      const passSel =
        (details.passwordInput as { selector?: string })?.selector ??
        "input[type='password']"

      await page.locator(emailSel).first().fill(email)
      await page.locator(passSel).first().fill(password)
    }

    // Submit
    const submitBtn = page.locator("button[type='submit'], input[type='submit']")
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click()
    } else {
      // Try pressing Enter in the password field
      await page.locator("input[type='password']").first().press("Enter")
    }

    // Wait for navigation away from login page
    await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 10000 }).catch(() => {})

    // Check if we're still on the login page
    const currentUrl = page.url()
    return !currentUrl.includes("login")
  } catch {
    return false
  }
}

async function scanSinglePage(
  url: string,
  origin: string,
  timeout: number,
): Promise<PageScan> {
  const startTime = Date.now()
  BrowserManager.clearConsoleErrors()

  try {
    const page = await BrowserManager.navigate(url, {
      waitUntil: "networkidle",
      timeout,
    })
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

    const title = await page.title()
    const finalUrl = page.url()
    const route = new URL(finalUrl).pathname

    // Pattern matching
    const matches = await matchPatterns(page, UI_PATTERNS)
    const patternsWithDetails: (PatternMatch & { details?: Record<string, unknown> })[] = []
    for (const match of matches) {
      const details = await extractPatternDetails(page, match, UI_PATTERNS)
      patternsWithDetails.push({
        ...match,
        details: Object.keys(details).length > 0 ? details : undefined,
      })
    }

    // Interactive elements (lightweight — just counts and key selectors)
    const buttons: { text: string; selector: string }[] = []
    const btnLocator = page.locator("button:visible")
    const btnCount = Math.min(await btnLocator.count(), 20)
    for (let i = 0; i < btnCount; i++) {
      try {
        const text = ((await btnLocator.nth(i).textContent()) ?? "").trim()
        if (text) buttons.push({ text, selector: `button:has-text('${text.replace(/'/g, "\\'")}')` })
      } catch { /* stale */ }
    }

    const inputs: { type: string; name: string; placeholder: string }[] = []
    const inputLocator = page.locator("input:visible:not([type='hidden']), select:visible, textarea:visible")
    const inputCount = Math.min(await inputLocator.count(), 20)
    for (let i = 0; i < inputCount; i++) {
      try {
        const el = inputLocator.nth(i)
        inputs.push({
          type: (await el.getAttribute("type")) ?? (await el.evaluate((e) => e.tagName.toLowerCase())),
          name: (await el.getAttribute("name")) ?? "",
          placeholder: (await el.getAttribute("placeholder")) ?? "",
        })
      } catch { /* stale */ }
    }

    const linkCount = await page.locator("a[href]").count()

    // Outbound routes
    const outboundRoutes = await collectOutboundRoutes(page, origin)

    // Drain console errors for this page
    const consoleErrors = BrowserManager.drainConsoleErrors().map((e) => ({
      type: e.type,
      text: e.text,
    }))

    return {
      url: finalUrl,
      route,
      title,
      patterns: patternsWithDetails,
      interactiveElements: { buttons, inputs, links: linkCount },
      outboundRoutes,
      consoleErrors,
      scanDuration: Date.now() - startTime,
      success: true,
    }
  } catch (err) {
    const consoleErrors = BrowserManager.drainConsoleErrors().map((e) => ({
      type: e.type,
      text: e.text,
    }))

    return {
      url,
      route: new URL(url).pathname,
      title: "",
      patterns: [],
      interactiveElements: { buttons: [], inputs: [], links: 0 },
      outboundRoutes: [],
      consoleErrors,
      scanDuration: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
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

      let absolute: string
      try {
        absolute = new URL(href, origin).href
      } catch {
        continue
      }

      if (!absolute.startsWith(origin)) continue

      const pathname = new URL(absolute).pathname
      if (pathname && pathname !== "#") {
        routes.add(pathname)
      }
    } catch { /* stale */ }
  }

  return Array.from(routes).sort()
}
