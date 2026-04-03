/**
 * Model Generator — deterministic pattern→capability mapping
 *
 * Takes a site model (output of map_site) and generates a skeleton
 * QA_FEATURE_MODEL.json using hardcoded pattern→capability rules.
 *
 * AI is used only for: natural language descriptions, feature grouping,
 * and dependency inference. All verify checks and capability types
 * come from the deterministic mapping table.
 */

import type { PatternMatch } from "./patterns"

// ─── Types ───────────────────────────────────────────────────────────────────

/** The page scan data we receive from map_site's siteModel output */
export interface PageScanData {
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
  landmarks?: {
    h1: string
    h2: string
    dataPages: string[]
    dataTestIds: string[]
  }
  consoleErrors: { type: string; text: string }[]
  success: boolean
}

export interface GeneratedCapability {
  interaction: string
  expected: string[]
  verify: Record<string, { type: string; selector?: string; value?: string }>
  preconditions?: string[]
  cleanup?: string
  test_data?: Record<string, string>
  source: "init" | "learn"
  mode: "passive" | "interactive"
  _confidence: "init"
  _observed: 0
}

export interface HealthBlock {
  route: string
  landmark?: { selector: string; text: string }
  checks: Array<{ type: string; value?: string; selector?: string; text?: string }>
}

export interface GeneratedFeature {
  description: string
  route: string
  requires: string[]
  capabilities: Record<string, GeneratedCapability>
  health?: HealthBlock
}

export interface GeneratedFeatureModel {
  version: "1.0"
  meta: {
    generated_by: "init"
    learn_sessions: 0
    confidence: "skeleton"
    generated_at: string
  }
  features: Record<string, GeneratedFeature>
  shared: Record<string, { how: string; verify: string; route?: string }>
}

// ─── Pattern → Capability Mapping Table ──────────────────────────────────────

interface CapabilityTemplate {
  interaction: string
  expected: string[]
  verify: Record<string, { type: string; selector?: string }>
  preconditions?: string[]
  cleanup?: string
  test_data?: Record<string, string>
}

const PATTERN_CAPABILITY_MAP: Record<string, Record<string, CapabilityTemplate>> = {
  auth_form: {
    login: {
      interaction: "fill email and password fields, click submit",
      expected: ["redirect away from login page", "navigation or dashboard visible"],
      verify: {
        redirected: { type: "url_changed" },
        no_errors: { type: "no_errors" },
      },
    },
  },

  data_table: {
    view_list: {
      interaction: "navigate to page",
      expected: ["page loads without errors"],
      verify: {
        no_errors: { type: "no_errors" },
      },
    },
  },

  crud_page: {
    view_list: {
      interaction: "navigate to page",
      expected: ["page loads without errors"],
      verify: {
        no_errors: { type: "no_errors" },
      },
    },
  },
}

// Patterns that are structural (no direct capabilities generated)
const STRUCTURAL_PATTERNS = new Set(["nav_sidebar", "modal_dialog", "toast_notification"])

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate a feature model from a site model (map_site output).
 * Pure deterministic mapping — no AI calls.
 */
export function generateFeatureModel(
  siteModel: Record<string, PageScanData>,
  options: {
    authRoute?: string
    excludeRoutes?: string[]
  } = {},
): GeneratedFeatureModel {
  const features: Record<string, GeneratedFeature> = {}
  const hasAuth = Object.values(siteModel).some((p) =>
    p.patterns.some((m) => m.type === "auth_form"),
  )

  // Determine auth route
  let authRoute = options.authRoute
  if (!authRoute && hasAuth) {
    const authPage = Object.values(siteModel).find((p) =>
      p.patterns.some((m) => m.type === "auth_form"),
    )
    authRoute = authPage?.route
  }

  // Generate "authenticated" shared capability if auth detected
  const shared: Record<string, { how: string; verify: string; route?: string }> = {}
  if (hasAuth && authRoute) {
    shared.authenticated = {
      how: "fill email and password on login page, submit form",
      verify: "URL no longer contains login/sign-in path",
      route: authRoute,
    }
  }

  // Process each page
  for (const [route, pageScan] of Object.entries(siteModel)) {
    if (!pageScan.success) continue
    if (options.excludeRoutes?.some((ex) => route.startsWith(ex))) continue

    // Generate feature name from route
    const featureName = routeToFeatureName(route)
    if (!featureName) continue

    // Skip if this is the auth page — handled separately
    const isAuthPage = pageScan.patterns.some((m) => m.type === "auth_form")
    if (isAuthPage) {
      features.authentication = generateAuthFeature(pageScan, route)
      continue
    }

    // Determine dependencies
    const requires: string[] = []
    if (hasAuth && !isAuthPage) {
      requires.push("authenticated")
    }

    // Filter out structural-only patterns for capability generation
    const meaningfulPatterns = pageScan.patterns.filter(
      (p) => !STRUCTURAL_PATTERNS.has(p.type),
    )

    // Generate capabilities from patterns (may be empty)
    const capabilities = meaningfulPatterns.length > 0
      ? generateCapabilitiesFromPatterns(meaningfulPatterns, pageScan)
      : {}

    // Every successfully crawled route gets a feature with a health block
    const health = buildHealthBlock(route, pageScan)

    if (features[featureName]) {
      Object.assign(features[featureName].capabilities, capabilities)
      // Keep the first health block (don't overwrite)
      if (!features[featureName].health) {
        features[featureName].health = health
      }
    } else {
      features[featureName] = {
        description: generateDescription(featureName, pageScan),
        route,
        requires,
        capabilities,
        health,
      }
    }
  }

  return {
    version: "1.0",
    meta: {
      generated_by: "init",
      learn_sessions: 0,
      confidence: "skeleton",
      generated_at: new Date().toISOString(),
    },
    features,
    shared,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateCapabilitiesFromPatterns(
  patterns: (PatternMatch & { details?: Record<string, unknown> })[],
  pageScan: PageScanData,
): Record<string, GeneratedCapability> {
  const capabilities: Record<string, GeneratedCapability> = {}
  const seenCapabilities = new Set<string>()

  for (const pattern of patterns) {
    const templateMap = PATTERN_CAPABILITY_MAP[pattern.type]
    if (!templateMap) continue

    for (const [capName, template] of Object.entries(templateMap)) {
      // Avoid duplicates (e.g., data_table.view_list + crud_page.view_list)
      if (seenCapabilities.has(capName)) continue
      seenCapabilities.add(capName)

      // Refine selectors if pattern details available
      const verify = { ...template.verify }

      capabilities[capName] = {
        interaction: template.interaction,
        expected: [...template.expected],
        verify,
        ...(template.preconditions && { preconditions: [...template.preconditions] }),
        ...(template.cleanup && { cleanup: template.cleanup }),
        ...(template.test_data && { test_data: { ...template.test_data } }),
        source: "init",
        mode: "passive",
        _confidence: "init",
        _observed: 0,
      }
    }
  }

  return capabilities
}

function generateAuthFeature(
  pageScan: PageScanData,
  route: string,
): GeneratedFeature {
  const templates = PATTERN_CAPABILITY_MAP.auth_form
  const capabilities: Record<string, GeneratedCapability> = {}

  for (const [capName, template] of Object.entries(templates)) {
    capabilities[capName] = {
      interaction: template.interaction,
      expected: [...template.expected],
      verify: { ...template.verify },
      ...(template.test_data && { test_data: { ...template.test_data } }),
      source: "init",
      mode: "passive",
      _confidence: "init",
      _observed: 0,
    }
  }

  return {
    description: "User login and session management",
    route,
    requires: [],
    capabilities,
  }
}

function routeToFeatureName(route: string): string {
  // /home/call-logs → call_logs
  // /auth/sign-in → authentication (handled separately)
  // /home/dashboard → dashboard
  // / → home
  const cleaned = route
    .replace(/^\/home\//, "")
    .replace(/^\/app\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "")

  if (!cleaned || cleaned === "/") return "home"

  // Take the last meaningful segment
  const segments = cleaned.split("/").filter(Boolean)
  const last = segments[segments.length - 1]

  return last
    .replace(/-/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase()
}

function generateDescription(featureName: string, pageScan: PageScanData): string {
  const title = pageScan.title
  const patternTypes = pageScan.patterns.map((p) => p.type)

  // Use page title if meaningful
  if (title && !title.toLowerCase().includes("loading") && title.length > 2) {
    return title
  }

  // Fallback: describe based on patterns
  const name = featureName.replace(/_/g, " ")
  if (patternTypes.includes("crud_page")) return `Manage ${name}`
  if (patternTypes.includes("data_table")) return `View and manage ${name}`
  if (patternTypes.includes("form_generic")) return `${name} settings`
  return `${name.charAt(0).toUpperCase() + name.slice(1)} page`
}

// ─── Health Block Helpers ────────────────────────────────────────────────────

function buildHealthBlock(route: string, pageScan: PageScanData): HealthBlock {
  const landmark = pickInitLandmark(pageScan)
  return {
    route,
    ...(landmark && { landmark }),
    checks: [
      { type: "url_is", value: route },
      { type: "no_js_errors" },
      { type: "no_console_errors" },
      { type: "no_error_alerts" },
    ],
  }
}

function pickInitLandmark(pageScan: PageScanData): { selector: string; text: string } | null {
  const lm = pageScan.landmarks

  // 1. data-page attribute (most stable, explicitly set by developers)
  if (lm?.dataPages && lm.dataPages.length > 0) {
    return { selector: `[data-page="${lm.dataPages[0]}"]`, text: lm.dataPages[0] }
  }

  // 2. data-testid (stable across deploys)
  if (lm?.dataTestIds && lm.dataTestIds.length > 0) {
    return { selector: `[data-testid="${lm.dataTestIds[0]}"]`, text: lm.dataTestIds[0] }
  }

  // 3. h1 text (visible page heading)
  if (lm?.h1 && lm.h1.length > 1 && !/loading/i.test(lm.h1)) {
    return { selector: "h1", text: lm.h1 }
  }

  // 4. h2 text (secondary heading fallback)
  if (lm?.h2 && lm.h2.length > 1 && !/loading/i.test(lm.h2)) {
    return { selector: "h2", text: lm.h2 }
  }

  // 5. Page title (least specific but always available)
  if (pageScan.title && pageScan.title.length > 2 && !/loading/i.test(pageScan.title)) {
    return { selector: "title", text: pageScan.title }
  }

  return null
}

// ─── Instructions Generator ──────────────────────────────────────────────────

export interface GeneratedInstructions {
  version: "1.0"
  global: {
    viewport: { width: number; height: number }
    defaultTimeout: number
    waitAfterAction: number
    toastTimeout: number
    screenshotsOn: string[]
    customSelectors: Record<string, string>
  }
  scope: {
    exclude_routes: string[]
    exclude_capabilities: string[]
    include_only: null
    max_pages: number
  }
  timing: {
    slow_transitions: { after: string; wait: number; reason?: string }[]
    toast_appear_delay: number
    page_load_buffer: number
  }
  known_issues: {
    page: string
    issue: string
    pattern?: string
    action: "skip_check" | "ignore" | "warn"
    reason: string
  }[]
  auth: {
    strategy: "form" | "token" | "cookie"
    session_duration: string
    reauth_on_redirect: boolean
    mfa: boolean
  }
  environment_overrides: Record<string, Record<string, unknown>>
  agent_hints: string[]
}

/**
 * Generate QA_INSTRUCTIONS.json from scan results.
 * Analyzes page timings, console errors, detected patterns, and route structure.
 */
export function generateInstructions(
  siteModel: Record<string, PageScanData>,
  options: {
    excludeRoutes?: string[]
    hasAuth?: boolean
  } = {},
): GeneratedInstructions {
  const pages = Object.values(siteModel)
  const pageCount = pages.filter((p) => p.success).length

  // Detect console error patterns that should be known_issues
  const knownIssues: GeneratedInstructions["known_issues"] = []
  const consoleErrorPatterns = new Map<string, { pages: Set<string>; count: number }>()

  for (const page of pages) {
    for (const err of page.consoleErrors) {
      // Common benign patterns
      if (err.text.includes("ResizeObserver loop")) {
        const existing = consoleErrorPatterns.get("ResizeObserver loop")
        if (existing) {
          existing.pages.add(page.route)
          existing.count++
        } else {
          consoleErrorPatterns.set("ResizeObserver loop", { pages: new Set([page.route]), count: 1 })
        }
      }
    }
  }

  for (const [pattern, data] of consoleErrorPatterns) {
    for (const page of data.pages) {
      knownIssues.push({
        page,
        issue: "console_error",
        pattern,
        action: "ignore",
        reason: "Benign browser warning detected during scan",
      })
    }
  }

  // Detect exclude routes: pages that returned errors or redirects to 403/404
  const detectedExcludeRoutes: string[] = [...(options.excludeRoutes ?? [])]
  for (const page of pages) {
    if (!page.success && page.route) {
      detectedExcludeRoutes.push(page.route)
    }
  }
  // Always exclude /api/* if any API routes were discovered
  const hasApiRoutes = pages.some((p) => p.route.startsWith("/api"))
  if (hasApiRoutes) {
    detectedExcludeRoutes.push("/api/*")
  }

  // Detect custom selectors for toast elements
  const customSelectors: Record<string, string> = {}
  const hasToastPattern = pages.some((p) =>
    p.patterns.some((m) => m.type === "toast_notification"),
  )
  if (hasToastPattern) {
    customSelectors.toast = "[data-sonner-toast], [role='status'], [role='alert']"
  }

  // Detect slow transitions from page scan durations
  const slowTransitions: { after: string; wait: number; reason?: string }[] = []
  const scanDurations = pages.filter((p) => p.success).map((p) => (p as any).scanDuration ?? 0)
  const avgScanTime = scanDurations.length > 0
    ? scanDurations.reduce((a, b) => a + b, 0) / scanDurations.length
    : 0
  const pageLoadBuffer = avgScanTime > 2000 ? 1500 : 1000

  // Agent hints
  const hints: string[] = []
  if (avgScanTime > 3000) {
    hints.push(`Pages are slow to load (~${Math.round(avgScanTime / 1000)}s average). Be patient with transitions.`)
  }

  return {
    version: "1.0",
    global: {
      viewport: { width: 1920, height: 1080 },
      defaultTimeout: avgScanTime > 5000 ? 15000 : 10000,
      waitAfterAction: 500,
      toastTimeout: 5000,
      screenshotsOn: ["failure", "capability_complete"],
      customSelectors,
    },
    scope: {
      exclude_routes: [...new Set(detectedExcludeRoutes)],
      exclude_capabilities: [],
      include_only: null,
      max_pages: Math.max(pageCount + 5, 20),
    },
    timing: {
      slow_transitions: slowTransitions,
      toast_appear_delay: 3000,
      page_load_buffer: pageLoadBuffer,
    },
    known_issues: knownIssues,
    auth: {
      strategy: "form",
      session_duration: "30m",
      reauth_on_redirect: true,
      mfa: false,
    },
    environment_overrides: {},
    agent_hints: hints,
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface InitSummary {
  pagesScanned: number
  patternsRecognized: { type: string; count: number }[]
  featuresGenerated: number
  totalCapabilities: number
  todoCount: number
  featureBreakdown: { name: string; capabilities: string[] }[]
}

export function summarizeModel(model: GeneratedFeatureModel): InitSummary {
  const patternCounts = new Map<string, number>()
  let totalCapabilities = 0
  let todoCount = 0
  const breakdown: { name: string; capabilities: string[] }[] = []

  for (const [name, feature] of Object.entries(model.features)) {
    const capNames = Object.keys(feature.capabilities)
    totalCapabilities += capNames.length
    breakdown.push({ name, capabilities: capNames })

    for (const cap of Object.values(feature.capabilities)) {
      if (cap.test_data) {
        for (const v of Object.values(cap.test_data)) {
          if (v === "TODO") todoCount++
        }
      }
    }
  }

  return {
    pagesScanned: 0, // filled by caller
    patternsRecognized: Array.from(patternCounts.entries()).map(([type, count]) => ({ type, count })),
    featuresGenerated: Object.keys(model.features).length,
    totalCapabilities,
    todoCount,
    featureBreakdown: breakdown,
  }
}
