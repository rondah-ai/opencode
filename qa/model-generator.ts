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
  _confidence: "init"
  _observed: 0
}

export interface GeneratedFeature {
  description: string
  route: string
  requires: string[]
  capabilities: Record<string, GeneratedCapability>
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
    login_invalid: {
      interaction: "fill invalid credentials, click submit",
      expected: ["error message appears", "stays on login page"],
      verify: {
        error_shown: { type: "element_appeared", selector: "[role='alert'], .text-red-500, .error" },
      },
      test_data: { email: "invalid@example.com", password: "wrongpassword" },
    },
  },

  data_table: {
    view_list: {
      interaction: "navigate to page",
      expected: ["table with records visible"],
      verify: {
        table_visible: { type: "custom_selector_visible", selector: "table, [role='grid']" },
        has_rows: { type: "element_appeared", selector: "tbody tr, [role='row']" },
        no_errors: { type: "no_errors" },
      },
    },
    sort: {
      interaction: "click column header to sort",
      expected: ["table row order changes", "sort indicator appears"],
      verify: {
        rows_changed: { type: "element_count_changed", selector: "tbody tr" },
      },
      preconditions: ["view_list"],
    },
    pagination: {
      interaction: "click next page or page number in pagination controls",
      expected: ["table rows update to show next page of data"],
      verify: {
        rows_changed: { type: "element_count_changed", selector: "tbody tr" },
        no_errors: { type: "no_errors" },
      },
      preconditions: ["view_list"],
    },
  },

  crud_page: {
    view_list: {
      interaction: "navigate to page",
      expected: ["list or table of records visible"],
      verify: {
        table_visible: { type: "custom_selector_visible", selector: "table, [role='grid']" },
        has_rows: { type: "element_appeared", selector: "tbody tr, [role='row']" },
        no_errors: { type: "no_errors" },
      },
    },
    create: {
      interaction: "click Add/Create button, fill form, submit",
      expected: ["new record appears in list", "success toast or confirmation"],
      verify: {
        element_appeared: { type: "element_appeared", selector: "tbody tr" },
        toast_appeared: { type: "toast_appeared" },
        no_errors: { type: "no_errors" },
      },
      preconditions: ["view_list"],
      cleanup: "delete the created record if possible",
      test_data: { name: "TODO", description: "TODO" },
    },
    edit: {
      interaction: "click Edit on a record, modify fields, submit",
      expected: ["record updated in list", "success toast or confirmation"],
      verify: {
        toast_appeared: { type: "toast_appeared" },
        no_errors: { type: "no_errors" },
      },
      preconditions: ["view_list"],
    },
    delete: {
      interaction: "click Delete on a record, confirm in dialog",
      expected: ["record removed from list", "success toast or confirmation"],
      verify: {
        element_disappeared: { type: "element_disappeared", selector: "tbody tr" },
        no_errors: { type: "no_errors" },
      },
      preconditions: ["view_list"],
    },
  },

  search_filter: {
    search: {
      interaction: "type search term in search input, wait for results to update",
      expected: ["displayed results filtered to match search term"],
      verify: {
        rows_changed: { type: "element_count_changed", selector: "tbody tr" },
        no_errors: { type: "no_errors" },
      },
      cleanup: "clear search input",
      test_data: { search_term: "TODO" },
    },
    clear_search: {
      interaction: "clear the search input or click clear button",
      expected: ["full unfiltered results restored"],
      verify: {
        rows_changed: { type: "element_count_changed", selector: "tbody tr" },
      },
      preconditions: ["search"],
    },
  },

  form_generic: {
    submit_form: {
      interaction: "fill all required fields, click submit",
      expected: ["form submitted successfully", "success toast or redirect"],
      verify: {
        toast_appeared: { type: "toast_appeared" },
        no_errors: { type: "no_errors" },
      },
      test_data: { field_value: "TODO" },
    },
    submit_invalid: {
      interaction: "submit form with empty required fields",
      expected: ["validation errors shown on required fields"],
      verify: {
        error_shown: { type: "element_appeared", selector: "[role='alert'], .error, .text-red-500" },
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

    // Skip pages with only structural patterns
    const meaningfulPatterns = pageScan.patterns.filter(
      (p) => !STRUCTURAL_PATTERNS.has(p.type),
    )
    if (meaningfulPatterns.length === 0) continue

    // Generate feature name from route
    const featureName = routeToFeatureName(route)
    if (!featureName) continue

    // Skip if this is the auth page — handled separately
    const isAuthPage = pageScan.patterns.some((m) => m.type === "auth_form")
    if (isAuthPage) {
      // Auth feature always gets generated
      features.authentication = generateAuthFeature(pageScan, route)
      continue
    }

    // Determine dependencies
    const requires: string[] = []
    if (hasAuth && !isAuthPage) {
      requires.push("authenticated")
    }

    // Generate capabilities from patterns
    const capabilities = generateCapabilitiesFromPatterns(
      meaningfulPatterns,
      pageScan,
    )

    if (Object.keys(capabilities).length === 0) continue

    // Merge with existing feature (multiple patterns on same page)
    if (features[featureName]) {
      Object.assign(features[featureName].capabilities, capabilities)
    } else {
      features[featureName] = {
        description: generateDescription(featureName, pageScan),
        route,
        requires,
        capabilities,
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

      // Skip pagination if no pagination element detected
      if (capName === "pagination" && pattern.details) {
        const pagination = pattern.details.pagination as { present?: boolean } | undefined
        if (pagination && !pagination.present) continue
      }

      // Refine selectors if pattern details available
      const verify = { ...template.verify }

      capabilities[capName] = {
        interaction: template.interaction,
        expected: [...template.expected],
        verify,
        ...(template.preconditions && { preconditions: [...template.preconditions] }),
        ...(template.cleanup && { cleanup: template.cleanup }),
        ...(template.test_data && { test_data: { ...template.test_data } }),
        _confidence: "init",
        _observed: 0,
      }
    }

    // Enrich: if we have search_filter alongside data_table, link them
    if (pattern.type === "search_filter") {
      const hasTable = patterns.some((p) => p.type === "data_table" || p.type === "crud_page")
      if (hasTable && capabilities.search) {
        capabilities.search.preconditions = ["view_list"]
      }
      if (hasTable && capabilities.clear_search) {
        capabilities.clear_search.preconditions = ["search"]
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
