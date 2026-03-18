/**
 * Interaction Tracker — captures user interactions in the browser
 *
 * Injects event listeners into the page via page.evaluate() to capture:
 * - click events (buttons, links, inputs)
 * - input events (typing, selecting)
 * - submit events (form submissions)
 * - navigation events (pushState, popstate)
 *
 * The tracker polls window.__qaTracker.flush() every 500ms to collect events
 * without interfering with app behavior.
 */

import type { Page } from "playwright"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TrackedEvent {
  type: "click" | "input" | "submit" | "navigation"
  timestamp: number
  selector: string
  text?: string
  tag?: string
  value?: string
  field?: string
  url: string
}

export interface InteractionGroup {
  events: TrackedEvent[]
  startUrl: string
  endUrl: string
  startTime: number
  endTime: number
  route: string
}

// ─── Injection Script ────────────────────────────────────────────────────────

const TRACKER_SCRIPT = `
(() => {
  if (window.__qaTracker) return;

  window.__qaTracker = {
    events: [],

    init() {
      // Track clicks
      document.addEventListener('click', (e) => {
        const target = e.target.closest('button, a, input, select, [role="button"], [onclick], [role="tab"], [role="menuitem"]');
        if (!target) return;
        this.events.push({
          type: 'click',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          text: (target.textContent || '').trim().slice(0, 100),
          tag: target.tagName.toLowerCase(),
          url: window.location.href,
        });
      }, { capture: true });

      // Track input changes
      document.addEventListener('input', (e) => {
        const target = e.target;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        this.events.push({
          type: 'input',
          timestamp: Date.now(),
          selector: this.getSelector(target),
          value: target.type === 'password' ? '***' : target.value,
          field: target.placeholder || target.name || target.id || target.getAttribute('aria-label') || 'unknown',
          url: window.location.href,
        });
      }, { capture: true });

      // Track form submissions
      document.addEventListener('submit', (e) => {
        const form = e.target;
        this.events.push({
          type: 'submit',
          timestamp: Date.now(),
          selector: this.getSelector(form),
          tag: 'form',
          url: window.location.href,
        });
      }, { capture: true });

      // Track navigation (pushState)
      const originalPushState = history.pushState;
      const tracker = this;
      history.pushState = function() {
        originalPushState.apply(this, arguments);
        tracker.events.push({
          type: 'navigation',
          timestamp: Date.now(),
          selector: '',
          url: window.location.href,
        });
      };

      // Track navigation (popstate)
      window.addEventListener('popstate', () => {
        tracker.events.push({
          type: 'navigation',
          timestamp: Date.now(),
          selector: '',
          url: window.location.href,
        });
      });
    },

    getSelector(el) {
      // Priority: data-testid > id > aria-label > text-based > CSS path
      if (el.getAttribute('data-testid')) {
        return '[data-testid="' + el.getAttribute('data-testid') + '"]';
      }
      if (el.id && !el.id.match(/^(:|react|ember|vue)/)) {
        return '#' + el.id;
      }
      if (el.getAttribute('aria-label')) {
        return '[aria-label="' + el.getAttribute('aria-label') + '"]';
      }
      if (['BUTTON', 'A'].includes(el.tagName)) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 50) {
          return el.tagName.toLowerCase() + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
        }
      }
      if (el.name) {
        return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
      }
      return this.cssPath(el);
    },

    cssPath(el) {
      const parts = [];
      let current = el;
      while (current && current !== document.body && parts.length < 5) {
        let selector = current.tagName.toLowerCase();
        if (current.className && typeof current.className === 'string') {
          const classes = current.className.trim().split(/\\s+/)
            .filter(c => c && !c.match(/^(hover|focus|active|disabled|selected|open)/))
            .slice(0, 2);
          if (classes.length > 0) {
            selector += '.' + classes.join('.');
          }
        }
        parts.unshift(selector);
        current = current.parentElement;
      }
      return parts.join(' > ');
    },

    flush() {
      const events = [...this.events];
      this.events = [];
      return events;
    }
  };

  window.__qaTracker.init();
})();
`

// ─── Tracker Class ───────────────────────────────────────────────────────────

export class InteractionTracker {
  private page: Page
  private events: TrackedEvent[] = []
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private injected = false

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Inject the tracker script into the current page.
   * Must be called after each navigation.
   */
  async inject(): Promise<void> {
    try {
      await this.page.evaluate(TRACKER_SCRIPT)
      this.injected = true
    } catch {
      // Page might not be ready yet, will retry on next poll
      this.injected = false
    }
  }

  /**
   * Start polling for events every `intervalMs` milliseconds.
   */
  startPolling(intervalMs = 500): void {
    if (this.pollInterval) return

    this.pollInterval = setInterval(async () => {
      await this.poll()
    }, intervalMs)
  }

  /**
   * Stop polling for events.
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  /**
   * Poll the page for new events and append to our buffer.
   */
  async poll(): Promise<TrackedEvent[]> {
    try {
      // Re-inject if needed (after navigation)
      if (!this.injected) {
        await this.inject()
      }

      const newEvents = await this.page.evaluate(() => {
        if (typeof (window as any).__qaTracker?.flush === "function") {
          return (window as any).__qaTracker.flush()
        }
        return []
      })

      if (newEvents && newEvents.length > 0) {
        this.events.push(...newEvents)
        return newEvents
      }
    } catch {
      // Page navigated or closed, mark as needing re-injection
      this.injected = false
    }

    return []
  }

  /**
   * Get all accumulated events.
   */
  getEvents(): TrackedEvent[] {
    return [...this.events]
  }

  /**
   * Drain all events (returns and clears buffer).
   */
  drainEvents(): TrackedEvent[] {
    const events = [...this.events]
    this.events = []
    return events
  }

  /**
   * Get events since the last drain, grouped by interaction.
   * An interaction group is events that happen close together (within gapMs).
   */
  groupInteractions(events?: TrackedEvent[], gapMs = 2000): InteractionGroup[] {
    const source = events ?? this.events
    if (source.length === 0) return []

    const groups: InteractionGroup[] = []
    let current: TrackedEvent[] = [source[0]]

    for (let i = 1; i < source.length; i++) {
      const event = source[i]
      const prev = source[i - 1]

      if (event.timestamp - prev.timestamp > gapMs) {
        // Start a new group
        groups.push(this.makeGroup(current))
        current = [event]
      } else {
        current.push(event)
      }
    }

    if (current.length > 0) {
      groups.push(this.makeGroup(current))
    }

    return groups
  }

  /**
   * Re-inject tracker after page navigation.
   * Call this in page.on('load') or page.on('domcontentloaded').
   */
  async onPageLoad(): Promise<void> {
    this.injected = false
    await this.inject()
  }

  /**
   * Clean up: stop polling and clear events.
   */
  destroy(): void {
    this.stopPolling()
    this.events = []
    this.injected = false
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private makeGroup(events: TrackedEvent[]): InteractionGroup {
    const first = events[0]
    const last = events[events.length - 1]
    const lastNavEvent = [...events].reverse().find((e) => e.type === "navigation")
    const route = new URL(lastNavEvent?.url ?? last.url).pathname

    return {
      events,
      startUrl: first.url,
      endUrl: last.url,
      startTime: first.timestamp,
      endTime: last.timestamp,
      route,
    }
  }
}

/**
 * Describe an interaction group in human-readable form.
 * Used for generating interaction descriptions in the feature model.
 */
export function describeInteraction(group: InteractionGroup): string {
  const parts: string[] = []

  for (const event of group.events) {
    if (event.type === "click") {
      const target = event.text
        ? `"${event.text}"`
        : event.selector
      parts.push(`click ${event.tag ?? "element"} ${target}`)
    } else if (event.type === "input") {
      const field = event.field !== "unknown" ? event.field : event.selector
      const value = event.value === "***" ? "(password)" : `"${event.value}"`
      parts.push(`type ${value} in ${field}`)
    } else if (event.type === "submit") {
      parts.push("submit form")
    } else if (event.type === "navigation") {
      const path = new URL(event.url).pathname
      parts.push(`navigate to ${path}`)
    }
  }

  // Deduplicate consecutive similar actions
  const deduped: string[] = []
  for (const part of parts) {
    if (deduped[deduped.length - 1] !== part) {
      deduped.push(part)
    }
  }

  return deduped.join(", ")
}
