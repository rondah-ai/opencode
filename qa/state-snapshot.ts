import type { Page } from "playwright"
import { BrowserManager } from "../browser/manager"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StateSnapshot {
  id: string
  timestamp: number
  url: string
  elementCounts: Record<string, number> // selector → count
  visibleText: string[] // visible text snippets
  consoleErrors: string[] // captured console.error messages
}

export interface VerifyCheck {
  name: string
  type: string
  selector?: string
  value?: string
}

export interface CheckResult {
  name: string
  type: string
  passed: boolean
  before?: string | number
  after?: string | number
  detail: string
}

type CheckRunner = (
  page: Page,
  check: VerifyCheck,
  before: StateSnapshot,
) => Promise<CheckResult>

// ─── Snapshot Store ──────────────────────────────────────────────────────────

const snapshots = new Map<string, StateSnapshot>()

export function getSnapshot(id: string): StateSnapshot | undefined {
  return snapshots.get(id)
}

export function storeSnapshot(snapshot: StateSnapshot): void {
  snapshots.set(snapshot.id, snapshot)
}

export function clearSnapshots(): void {
  snapshots.clear()
}

// ─── Capture State ───────────────────────────────────────────────────────────

export async function captureState(
  page: Page,
  checks: VerifyCheck[],
): Promise<StateSnapshot> {
  // Extract selectors from checks that need them
  const selectors = new Set<string>()
  for (const check of checks) {
    if (check.selector) selectors.add(check.selector)
    // Also add standard selectors needed by specific check types
    if (check.type === "toast_appeared") {
      selectors.add("[role='alert']")
      selectors.add("[role='status']")
      selectors.add("[aria-live='polite']")
      selectors.add("[aria-live='assertive']")
    }
    if (check.type === "no_errors") {
      selectors.add("[role='alert'][class*='error']")
      selectors.add(".error-boundary")
    }
  }

  const counts: Record<string, number> = {}
  for (const sel of selectors) {
    counts[sel] = await page.locator(sel).count().catch(() => 0)
  }

  const consoleErrors = BrowserManager.getConsoleErrors()
    .filter((e) => e.type === "error" || e.type === "pageerror")
    .map((e) => e.text)

  const snapshot: StateSnapshot = {
    id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    url: page.url(),
    elementCounts: counts,
    visibleText: await getVisibleTextSnippets(page),
    consoleErrors,
  }

  storeSnapshot(snapshot)
  return snapshot
}

async function getVisibleTextSnippets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const texts: string[] = []
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim()
      if (text && text.length > 2 && text.length < 200) texts.push(text)
    }
    return texts.slice(0, 500)
  })
}

// ─── Check Runners ───────────────────────────────────────────────────────────

export const CHECK_RUNNERS: Record<string, CheckRunner> = {
  element_count_changed: async (page, check, before) => {
    const sel = check.selector!
    const afterCount = await page.locator(sel).count().catch(() => 0)
    const beforeCount = before.elementCounts[sel] ?? 0
    return {
      name: check.name,
      type: check.type,
      passed: afterCount !== beforeCount,
      before: beforeCount,
      after: afterCount,
      detail:
        beforeCount === afterCount
          ? `${sel} count unchanged at ${beforeCount}`
          : `${sel} count changed from ${beforeCount} to ${afterCount}`,
    }
  },

  element_appeared: async (page, check, before) => {
    const sel = check.selector!
    const afterCount = await page.locator(sel).count().catch(() => 0)
    const beforeCount = before.elementCounts[sel] ?? 0
    return {
      name: check.name,
      type: check.type,
      passed: beforeCount === 0 && afterCount > 0,
      before: beforeCount,
      after: afterCount,
      detail: afterCount > 0 ? `${sel} appeared` : `${sel} still not present`,
    }
  },

  element_disappeared: async (page, check, before) => {
    const sel = check.selector!
    const afterCount = await page.locator(sel).count().catch(() => 0)
    const beforeCount = before.elementCounts[sel] ?? 0
    return {
      name: check.name,
      type: check.type,
      passed: beforeCount > 0 && afterCount === 0,
      before: beforeCount,
      after: afterCount,
      detail:
        afterCount === 0
          ? `${sel} disappeared`
          : `${sel} still present (${afterCount})`,
    }
  },

  text_appeared: async (page, check) => {
    const text = check.value!
    const visible = await page
      .locator(`:text("${text}")`)
      .count()
      .catch(() => 0)
    return {
      name: check.name,
      type: check.type,
      passed: visible > 0,
      after: visible,
      detail:
        visible > 0
          ? `Text "${text}" found on page`
          : `Text "${text}" not found`,
    }
  },

  text_disappeared: async (page, check) => {
    const text = check.value!
    const visible = await page
      .locator(`:text("${text}")`)
      .count()
      .catch(() => 0)
    return {
      name: check.name,
      type: check.type,
      passed: visible === 0,
      after: visible,
      detail:
        visible === 0
          ? `Text "${text}" no longer on page`
          : `Text "${text}" still present`,
    }
  },

  url_changed: async (page, check, before) => {
    const afterUrl = page.url()
    const changed = afterUrl !== before.url
    let beforePath: string
    let afterPath: string
    try {
      beforePath = new URL(before.url).pathname + new URL(before.url).search
      afterPath = new URL(afterUrl).pathname + new URL(afterUrl).search
    } catch {
      beforePath = before.url
      afterPath = afterUrl
    }
    return {
      name: check.name,
      type: check.type,
      passed: changed,
      before: beforePath,
      after: afterPath,
      detail: changed ? "URL changed" : "URL unchanged",
    }
  },

  no_errors: async (page) => {
    const errorSelectors =
      "[role='alert'][class*='error'], .error-boundary, .toast-error, [class*='error-message']"
    const errors = await page.locator(errorSelectors).count().catch(() => 0)
    return {
      name: "no_errors",
      type: "no_errors",
      passed: errors === 0,
      after: errors,
      detail:
        errors === 0
          ? "No error indicators detected"
          : `Found ${errors} error elements`,
    }
  },

  toast_appeared: async (page) => {
    const toastSelectors =
      "[role='alert'], [role='status'], .toast, .notification, [aria-live='polite'], [aria-live='assertive']"
    const count = await page.locator(toastSelectors).count().catch(() => 0)
    return {
      name: "toast",
      type: "toast_appeared",
      passed: count > 0,
      after: count,
      detail:
        count > 0
          ? `Toast/notification appeared (${count} found)`
          : "No toast detected",
    }
  },

  count_equals: async (page, check) => {
    const sel = check.selector!
    const expected = parseInt(check.value!, 10)
    const actual = await page.locator(sel).count().catch(() => 0)
    return {
      name: check.name,
      type: check.type,
      passed: actual === expected,
      after: actual,
      detail: `${sel} count: ${actual} (expected: ${expected})`,
    }
  },

  custom_selector_visible: async (page, check) => {
    const visible = await page
      .locator(check.selector!)
      .isVisible()
      .catch(() => false)
    return {
      name: check.name,
      type: check.type,
      passed: visible,
      detail: visible
        ? `${check.selector} is visible`
        : `${check.selector} is not visible`,
    }
  },

  custom_selector_hidden: async (page, check) => {
    const visible = await page
      .locator(check.selector!)
      .isVisible()
      .catch(() => false)
    return {
      name: check.name,
      type: check.type,
      passed: !visible,
      detail: !visible
        ? `${check.selector} is hidden`
        : `${check.selector} is still visible`,
    }
  },
}

// ─── Run Checks ──────────────────────────────────────────────────────────────

export async function runChecks(
  page: Page,
  checks: VerifyCheck[],
  before: StateSnapshot,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    const runner = CHECK_RUNNERS[check.type]
    if (!runner) {
      results.push({
        name: check.name,
        type: check.type,
        passed: false,
        detail: `Unknown check type: "${check.type}"`,
      })
      continue
    }
    try {
      results.push(await runner(page, check, before))
    } catch (err) {
      results.push({
        name: check.name,
        type: check.type,
        passed: false,
        detail: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return results
}
