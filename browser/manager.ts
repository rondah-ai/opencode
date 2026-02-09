import { chromium, type Browser, type Page, type BrowserContext } from "playwright"

/**
 * Browser Manager - Maintains a persistent browser instance across tool calls
 *
 * This solves the problem where each browser tool (navigate, interact, screenshot)
 * was launching a new browser instance and losing state between calls.
 *
 * Usage:
 *   const page = await BrowserManager.getPage()
 *   await page.goto('https://example.com')
 *   // Page state persists for next tool call
 */
export namespace BrowserManager {
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  let page: Page | null = null
  let lastActivityTime: number = Date.now()

  // Auto-close browser after 5 minutes of inactivity
  const INACTIVITY_TIMEOUT = 5 * 60 * 1000

  /**
   * Get or create a browser instance
   */
  export async function getBrowser(): Promise<Browser> {
    // Check if browser is still alive
    if (browser && browser.isConnected()) {
      lastActivityTime = Date.now()
      return browser
    }

    // Launch new browser
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    })

    lastActivityTime = Date.now()
    return browser
  }

  /**
   * Get or create a browser context (like an incognito window)
   * Contexts can have their own cookies, storage, etc.
   */
  export async function getContext(): Promise<BrowserContext> {
    if (context && !context.pages().every(p => p.isClosed())) {
      lastActivityTime = Date.now()
      return context
    }

    const b = await getBrowser()
    context = await b.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })

    lastActivityTime = Date.now()
    return context
  }

  /**
   * Get or create a page
   * This returns the same page instance across tool calls, maintaining state
   */
  export async function getPage(): Promise<Page> {
    // Check if page is still usable
    if (page && !page.isClosed()) {
      lastActivityTime = Date.now()
      return page
    }

    // Create new page
    const ctx = await getContext()
    page = await ctx.newPage()

    // Set reasonable defaults
    page.setDefaultTimeout(30000)
    page.setDefaultNavigationTimeout(60000)

    lastActivityTime = Date.now()
    return page
  }

  /**
   * Navigate to a URL using the persistent page
   */
  export async function navigate(url: string, options?: {
    waitUntil?: "load" | "domcontentloaded" | "networkidle"
    timeout?: number
  }): Promise<Page> {
    const p = await getPage()

    await p.goto(url, {
      waitUntil: options?.waitUntil || "load",
      timeout: options?.timeout || 60000,
    })

    lastActivityTime = Date.now()
    return p
  }

  /**
   * Get current page URL (if page exists)
   */
  export function getCurrentUrl(): string | null {
    if (page && !page.isClosed()) {
      return page.url()
    }
    return null
  }

  /**
   * Close the current page (but keep browser alive)
   */
  export async function closePage(): Promise<void> {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {})
    }
    page = null
  }

  /**
   * Close the entire browser
   */
  export async function close(): Promise<void> {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {})
    }
    if (context) {
      await context.close().catch(() => {})
    }
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {})
    }

    page = null
    context = null
    browser = null
  }

  /**
   * Reset browser state (close current page and create fresh one)
   */
  export async function reset(): Promise<void> {
    await closePage()
    await getPage()
  }

  /**
   * Check for inactivity and close browser if idle too long
   */
  export async function checkInactivity(): Promise<void> {
    const now = Date.now()
    const inactive = now - lastActivityTime

    if (inactive > INACTIVITY_TIMEOUT && browser) {
      await close()
    }
  }

  /**
   * Get browser status for debugging
   */
  export function getStatus(): {
    hasBrowser: boolean
    hasContext: boolean
    hasPage: boolean
    currentUrl: string | null
    inactiveDuration: number
  } {
    return {
      hasBrowser: browser !== null && browser.isConnected(),
      hasContext: context !== null,
      hasPage: page !== null && !page.isClosed(),
      currentUrl: getCurrentUrl(),
      inactiveDuration: Date.now() - lastActivityTime,
    }
  }
}

// Cleanup on process exit
process.on('beforeExit', async () => {
  await BrowserManager.close()
})

process.on('SIGINT', async () => {
  await BrowserManager.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await BrowserManager.close()
  process.exit(0)
})
