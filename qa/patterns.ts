import type { Page } from "playwright"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UIPattern {
  recognize: {
    signals: string[] // Playwright selectors that indicate this pattern
    minMatch: number // Minimum signals that must match
    context?: string // Human hint for ambiguous cases
  }
  smoke: string[] // Smoke check names (mapped to SMOKE_CHECK_MAP)
  regression: string[] // Regression test descriptions (used by compose_test)
  extract?: Record<string, string> // Selectors to extract details from matched pattern
}

export type UIPatterns = Record<string, UIPattern>

export interface PatternMatch {
  type: string
  confidence: number
  rootSelector: string
  signalHits: number
  totalSignals: number
  details?: Record<string, unknown>
}

// ─── Pattern Definitions ─────────────────────────────────────────────────────

export const UI_PATTERNS: UIPatterns = {
  auth_form: {
    recognize: {
      signals: [
        "input[type='email'], input[name='email'], input[type='text'][name*='user']",
        "input[type='password']",
        "button[type='submit'], input[type='submit']",
      ],
      minMatch: 2,
      context: "Login or registration form with email/password fields",
    },
    smoke: [
      "form renders without errors",
      "all inputs accept text",
      "submit button is clickable",
    ],
    regression: [
      "Submit with valid credentials → redirects to dashboard",
      "Submit with invalid credentials → shows error message",
      "Submit with empty fields → shows validation errors",
      "Password field masks input",
    ],
    extract: {
      emailInput:
        "input[type='email'], input[name='email'], input[type='text'][name*='user']",
      passwordInput: "input[type='password']",
      submitButton: "button[type='submit'], input[type='submit']",
    },
  },

  data_table: {
    recognize: {
      signals: [
        "table, [role='grid']",
        "thead th, [role='columnheader']",
        "tbody tr, [role='row']",
      ],
      minMatch: 2,
      context: "Data table with headers and rows",
    },
    smoke: [
      "table renders",
      "has header row with column names",
      "has data rows or empty state message",
    ],
    regression: [
      "Table displays correct number of rows",
      "Column headers match expected labels",
      "Sorting toggles column order",
      "Pagination controls navigate between pages",
      "Empty state shows when no data",
    ],
    extract: {
      headers: "thead th, [role='columnheader']",
      rows: "tbody tr, [role='row']",
      pagination:
        "nav[aria-label='pagination'], [class*='pagination'], [class*='pager']",
    },
  },

  nav_sidebar: {
    recognize: {
      signals: [
        "nav a[href], [role='navigation'] a[href]",
        "aside nav, aside [role='navigation']",
        "[role='navigation'], nav",
      ],
      minMatch: 2,
      context: "Sidebar or top navigation with links to app sections",
    },
    smoke: ["navigation renders", "all nav links are visible"],
    regression: [
      "Each nav link navigates to correct route",
      "Active link is visually distinguished",
      "Navigation is accessible via keyboard",
    ],
    extract: {
      links: "nav a[href], [role='navigation'] a[href]",
      activeLink:
        "nav a[aria-current='page'], nav a.active, [role='navigation'] a[aria-current='page']",
    },
  },

  crud_page: {
    recognize: {
      signals: [
        "button:has-text('Add'), button:has-text('Create'), button:has-text('New')",
        "table, [role='grid']",
        "button[aria-label='Edit'], button:has-text('Edit'), a:has-text('Edit')",
      ],
      minMatch: 2,
      context: "Page with create/read/update/delete operations on a data set",
    },
    smoke: [
      "add/create button visible and clickable",
      "table renders",
      "page loads without errors",
    ],
    regression: [
      "Add button opens creation form or modal",
      "Edit button opens edit form with pre-filled data",
      "Delete button shows confirmation dialog",
      "List updates after create/edit/delete",
    ],
    extract: {
      addButton:
        "button:has-text('Add'), button:has-text('Create'), button:has-text('New')",
      editButtons:
        "button[aria-label='Edit'], button:has-text('Edit'), a:has-text('Edit')",
      deleteButtons:
        "button[aria-label='Delete'], button:has-text('Delete'), a:has-text('Delete')",
    },
  },

  form_generic: {
    recognize: {
      signals: [
        "form",
        "label",
        "input:not([type='hidden']), select, textarea",
        "button[type='submit'], input[type='submit']",
      ],
      minMatch: 3,
      context: "Generic form with labeled inputs and a submit action",
    },
    smoke: [
      "form renders without errors",
      "all inputs accept text",
      "submit button is clickable",
    ],
    regression: [
      "Form submits successfully with valid data",
      "Validation errors shown for required empty fields",
      "Form resets on successful submission or cancel",
    ],
    extract: {
      inputs: "input:not([type='hidden']), select, textarea",
      labels: "label",
      submitButton: "button[type='submit'], input[type='submit']",
    },
  },

  search_filter: {
    recognize: {
      signals: [
        "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i]",
        "button:has-text('Search'), button:has-text('Filter'), button:has-text('Apply')",
      ],
      minMatch: 1,
      context: "Search or filter input that narrows displayed data",
    },
    smoke: ["search/filter input is visible and accepts text"],
    regression: [
      "Typing in search filters displayed results",
      "Clearing search restores full list",
      "Filter apply button triggers filtering",
    ],
    extract: {
      searchInput:
        "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i]",
      applyButton:
        "button:has-text('Search'), button:has-text('Filter'), button:has-text('Apply')",
    },
  },

  modal_dialog: {
    recognize: {
      signals: [
        "[role='dialog'], dialog",
        "[aria-modal='true']",
        "[class*='modal'], [class*='dialog']",
      ],
      minMatch: 1,
      context:
        "Modal or dialog overlay — typically triggered by an action, not present on load",
    },
    smoke: [],
    regression: [
      "Modal opens when triggered",
      "Modal closes on backdrop click or escape key",
      "Modal traps focus within itself",
      "Modal content is accessible",
    ],
    extract: {
      dialog: "[role='dialog'], dialog",
      closeButton:
        "button[aria-label='Close'], button:has-text('Close'), button:has-text('Cancel')",
    },
  },

  toast_notification: {
    recognize: {
      signals: [
        "[role='alert']",
        "[role='status']",
        "[aria-live='polite'], [aria-live='assertive']",
      ],
      minMatch: 1,
      context: "Transient notification — appears after an action, disappears automatically",
    },
    smoke: [],
    regression: [
      "Toast appears after triggering action",
      "Toast disappears after timeout",
      "Toast displays correct message",
      "Multiple toasts stack properly",
    ],
    extract: {
      toast: "[role='alert'], [role='status']",
    },
  },
}

// ─── Smoke Check Map ─────────────────────────────────────────────────────────

export const SMOKE_CHECK_MAP: Record<
  string,
  (page: Page, pattern: PatternMatch) => Promise<boolean>
> = {
  "table renders": async (page, p) => {
    return await page
      .locator(p.rootSelector || "table")
      .isVisible()
      .catch(() => false)
  },

  "has header row with column names": async (page) => {
    return (await page.locator("thead th, [role='columnheader']").count()) > 0
  },

  "has data rows or empty state message": async (page) => {
    const rows = await page.locator("tbody tr, [role='row']").count()
    const empty = await page
      .locator("[class*='empty'], :text('No data'), :text('No results')")
      .count()
    return rows > 0 || empty > 0
  },

  "form renders without errors": async (page) => {
    const form = await page.locator("form").count()
    const errors = await page
      .locator("[role='alert'][class*='error'], .error-boundary")
      .count()
    return form > 0 && errors === 0
  },

  "all inputs accept text": async (page) => {
    const inputs = page.locator(
      "input:not([type='hidden']):not([disabled]):not([type='checkbox']):not([type='radio'])"
    )
    return (await inputs.count()) > 0
  },

  "submit button is clickable": async (page) => {
    const btn = page.locator("button[type='submit'], input[type='submit']")
    return (
      (await btn.count()) > 0 && (await btn.first().isEnabled().catch(() => false))
    )
  },

  "navigation renders": async (page) => {
    return await page
      .locator("nav, [role='navigation']")
      .first()
      .isVisible()
      .catch(() => false)
  },

  "all nav links are visible": async (page) => {
    const links = page.locator("nav a[href], [role='navigation'] a[href]")
    const count = await links.count()
    if (count === 0) return false
    for (let i = 0; i < Math.min(count, 10); i++) {
      if (!(await links.nth(i).isVisible())) return false
    }
    return true
  },

  "add/create button visible and clickable": async (page) => {
    const btn = page.locator(
      "button:has-text('Add'), button:has-text('Create'), button:has-text('New')"
    )
    return (
      (await btn.count()) > 0 && (await btn.first().isEnabled().catch(() => false))
    )
  },

  "page loads without errors": async (page) => {
    const errors = await page
      .locator("[class*='error-boundary'], [role='alert'][class*='error']")
      .count()
    return errors === 0
  },

  "search/filter input is visible and accepts text": async (page) => {
    const input = page.locator(
      "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i]"
    )
    return (
      (await input.count()) > 0 &&
      (await input.first().isVisible().catch(() => false))
    )
  },
}

// ─── Core Functions ──────────────────────────────────────────────────────────

export async function matchPatterns(
  page: Page,
  patterns: UIPatterns = UI_PATTERNS
): Promise<PatternMatch[]> {
  const matches: PatternMatch[] = []

  for (const [patternName, pattern] of Object.entries(patterns)) {
    let signalHits = 0
    let rootSelector = ""

    for (const signal of pattern.recognize.signals) {
      const selectors = signal.split(",").map((s) => s.trim())
      for (const selector of selectors) {
        try {
          const count = await page.locator(selector).count()
          if (count > 0) {
            signalHits++
            if (!rootSelector) rootSelector = selector
            break // One hit per signal group is enough
          }
        } catch {
          // Invalid selector, skip
        }
      }
    }

    const confidence = signalHits / pattern.recognize.signals.length
    if (signalHits >= (pattern.recognize.minMatch || 1)) {
      matches.push({
        type: patternName,
        confidence: Math.round(confidence * 100) / 100,
        rootSelector,
        signalHits,
        totalSignals: pattern.recognize.signals.length,
      })
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence)
}

export async function extractPatternDetails(
  page: Page,
  match: PatternMatch,
  patterns: UIPatterns = UI_PATTERNS
): Promise<Record<string, unknown>> {
  const pattern = patterns[match.type]
  if (!pattern?.extract) return {}

  const details: Record<string, unknown> = {}

  for (const [key, selector] of Object.entries(pattern.extract)) {
    try {
      const selectors = selector.split(",").map((s) => s.trim())
      for (const sel of selectors) {
        const locator = page.locator(sel)
        const count = await locator.count()
        if (count === 0) continue

        if (key === "links" || key === "activeLink") {
          // Extract link text and href
          const items: { text: string; href: string }[] = []
          for (let i = 0; i < Math.min(count, 50); i++) {
            const el = locator.nth(i)
            const text = (await el.textContent())?.trim() || ""
            const href = (await el.getAttribute("href")) || ""
            if (text || href) items.push({ text, href })
          }
          details[key] = items
        } else if (key === "headers") {
          // Extract column header text
          const headers: string[] = []
          for (let i = 0; i < count; i++) {
            const text = (await locator.nth(i).textContent())?.trim() || ""
            if (text) headers.push(text)
          }
          details[key] = headers
        } else if (key === "rows") {
          details[key] = { count }
        } else if (key === "pagination") {
          details[key] = { present: count > 0 }
        } else if (key === "inputs" || key === "labels") {
          details[key] = { count }
        } else {
          // Default: report presence and selector
          details[key] = {
            present: count > 0,
            selector: sel,
            count,
          }
        }
        break // Found a matching selector variant, stop
      }
    } catch {
      // Selector failed, skip this extract key
    }
  }

  return details
}

export async function runSmokeCheck(
  page: Page,
  checkName: string,
  pattern: PatternMatch
): Promise<{ name: string; passed: boolean; error?: string }> {
  const checkFn = SMOKE_CHECK_MAP[checkName]
  if (!checkFn) {
    return {
      name: checkName,
      passed: false,
      error: `Unknown smoke check: "${checkName}" — no entry in SMOKE_CHECK_MAP`,
    }
  }

  try {
    const passed = await checkFn(page, pattern)
    return { name: checkName, passed }
  } catch (err) {
    return {
      name: checkName,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function runAllSmokeChecks(
  page: Page,
  match: PatternMatch,
  patterns: UIPatterns = UI_PATTERNS
): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const pattern = patterns[match.type]
  if (!pattern?.smoke.length) return []

  const results: { name: string; passed: boolean; error?: string }[] = []
  for (const checkName of pattern.smoke) {
    results.push(await runSmokeCheck(page, checkName, match))
  }
  return results
}
