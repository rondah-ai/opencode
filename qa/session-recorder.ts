/**
 * Session Recorder — accumulates user interactions into capability observations
 *
 * During a learn session, the recorder:
 * 1. Tracks which route the user is on
 * 2. Captures state snapshots before/after interactions
 * 3. Groups interactions into capability observations
 * 4. Allows the user to mark ([Enter]), skip ([s]), name ([n]), or edge-case ([e])
 * 5. Auto-saves session state every 30 seconds
 */

import type { InteractionGroup, TrackedEvent } from "./interaction-tracker"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StateSnapshot {
  url: string
  route: string
  timestamp: number
  elementCounts: Record<string, number>
  visibleTexts: string[]
  consoleErrorCount: number
}

export interface StateDiff {
  urlChanged: boolean
  oldUrl: string
  newUrl: string
  elementChanges: { selector: string; before: number; after: number }[]
  newTexts: string[]
  removedTexts: string[]
  consoleErrorsDelta: number
}

export interface CapabilityObservation {
  id: string
  route: string
  interaction: InteractionGroup
  interactionDescription: string
  stateBefore: StateSnapshot
  stateAfter: StateSnapshot
  diff: StateDiff
  inferredVerifyChecks: InferredCheck[]
  userLabel?: string        // User-given name via [n] command
  isEdgeCase: boolean       // Marked via [e] command
  edgeCaseOf?: string       // ID of the parent capability this is an edge case of
  timestamp: number
}

export interface InferredCheck {
  type: string
  selector?: string
  value?: string
  reason: string
}

export interface LearnSession {
  id: string
  sessionNumber: number
  startTime: number
  endTime?: number
  url: string
  observations: CapabilityObservation[]
  skippedCount: number
  modelPath: string
}

// ─── Session Recorder ────────────────────────────────────────────────────────

export class SessionRecorder {
  private session: LearnSession
  private lastObservationId = 0
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    url: string,
    sessionNumber: number,
    modelPath: string,
  ) {
    this.session = {
      id: `learn-${Date.now()}`,
      sessionNumber,
      startTime: Date.now(),
      url,
      observations: [],
      skippedCount: 0,
      modelPath,
    }
  }

  /**
   * Record a capability observation from an interaction group.
   */
  recordObservation(
    group: InteractionGroup,
    description: string,
    stateBefore: StateSnapshot,
    stateAfter: StateSnapshot,
  ): CapabilityObservation {
    const diff = computeDiff(stateBefore, stateAfter)
    const checks = inferVerifyChecks(diff)

    const observation: CapabilityObservation = {
      id: `obs-${++this.lastObservationId}`,
      route: new URL(group.endUrl).pathname,
      interaction: group,
      interactionDescription: description,
      stateBefore,
      stateAfter,
      diff,
      inferredVerifyChecks: checks,
      isEdgeCase: false,
      timestamp: Date.now(),
    }

    this.session.observations.push(observation)
    return observation
  }

  /**
   * Mark the last observation as skipped (remove it).
   */
  skipLast(): void {
    if (this.session.observations.length > 0) {
      this.session.observations.pop()
      this.session.skippedCount++
    }
  }

  /**
   * Label the last observation with a user-given name.
   */
  labelLast(name: string): void {
    const last = this.session.observations[this.session.observations.length - 1]
    if (last) {
      last.userLabel = name
    }
  }

  /**
   * Mark the last observation as an edge case of a specific capability.
   */
  markEdgeCase(parentCapabilityId?: string): void {
    const last = this.session.observations[this.session.observations.length - 1]
    if (last) {
      last.isEdgeCase = true
      last.edgeCaseOf = parentCapabilityId
    }
  }

  /**
   * Get all observations recorded so far.
   */
  getObservations(): CapabilityObservation[] {
    return [...this.session.observations]
  }

  /**
   * Get the last N observations.
   */
  getRecentObservations(n = 5): CapabilityObservation[] {
    return this.session.observations.slice(-n)
  }

  /**
   * Get the full session data.
   */
  getSession(): LearnSession {
    return { ...this.session }
  }

  /**
   * Finish the session.
   */
  finish(): LearnSession {
    this.session.endTime = Date.now()
    this.stopAutoSave()
    return this.getSession()
  }

  /**
   * Start auto-saving session to a file every `intervalMs`.
   */
  startAutoSave(saveFn: (session: LearnSession) => void, intervalMs = 30000): void {
    if (this.autoSaveInterval) return
    this.autoSaveInterval = setInterval(() => {
      saveFn(this.session)
    }, intervalMs)
  }

  /**
   * Stop auto-saving.
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval)
      this.autoSaveInterval = null
    }
  }

  /**
   * Restore from a saved session (for --resume).
   */
  static restore(saved: LearnSession): SessionRecorder {
    const recorder = new SessionRecorder(saved.url, saved.sessionNumber, saved.modelPath)
    recorder.session = { ...saved }
    recorder.lastObservationId = saved.observations.length
    return recorder
  }
}

// ─── State Diff ──────────────────────────────────────────────────────────────

export function computeDiff(before: StateSnapshot, after: StateSnapshot): StateDiff {
  const elementChanges: { selector: string; before: number; after: number }[] = []

  // Compare element counts
  const allSelectors = new Set([
    ...Object.keys(before.elementCounts),
    ...Object.keys(after.elementCounts),
  ])

  for (const selector of allSelectors) {
    const beforeCount = before.elementCounts[selector] ?? 0
    const afterCount = after.elementCounts[selector] ?? 0
    if (beforeCount !== afterCount) {
      elementChanges.push({ selector, before: beforeCount, after: afterCount })
    }
  }

  // Compare visible texts
  const beforeTexts = new Set(before.visibleTexts)
  const afterTexts = new Set(after.visibleTexts)

  const newTexts = after.visibleTexts.filter((t) => !beforeTexts.has(t))
  const removedTexts = before.visibleTexts.filter((t) => !afterTexts.has(t))

  return {
    urlChanged: before.url !== after.url,
    oldUrl: before.url,
    newUrl: after.url,
    elementChanges,
    newTexts: newTexts.slice(0, 20), // Cap to prevent huge diffs
    removedTexts: removedTexts.slice(0, 20),
    consoleErrorsDelta: after.consoleErrorCount - before.consoleErrorCount,
  }
}

// ─── Verify Check Inference ──────────────────────────────────────────────────

/**
 * Infer verify checks from observed state changes.
 * These are deterministic — no AI involved.
 */
export function inferVerifyChecks(diff: StateDiff): InferredCheck[] {
  const checks: InferredCheck[] = []

  // URL changed → url_changed check
  if (diff.urlChanged) {
    checks.push({
      type: "url_changed",
      reason: `URL changed from ${new URL(diff.oldUrl).pathname} to ${new URL(diff.newUrl).pathname}`,
    })
  }

  // Element count changes
  for (const change of diff.elementChanges) {
    if (change.before === 0 && change.after > 0) {
      checks.push({
        type: "element_appeared",
        selector: change.selector,
        reason: `${change.selector}: 0 → ${change.after}`,
      })
    } else if (change.before > 0 && change.after === 0) {
      checks.push({
        type: "element_disappeared",
        selector: change.selector,
        reason: `${change.selector}: ${change.before} → 0`,
      })
    } else if (change.before !== change.after) {
      checks.push({
        type: "element_count_changed",
        selector: change.selector,
        reason: `${change.selector}: ${change.before} → ${change.after}`,
      })
    }
  }

  // New texts (could indicate toast or success message)
  for (const text of diff.newTexts.slice(0, 3)) {
    const lowerText = text.toLowerCase()
    if (
      lowerText.includes("success") ||
      lowerText.includes("saved") ||
      lowerText.includes("created") ||
      lowerText.includes("updated") ||
      lowerText.includes("deleted")
    ) {
      checks.push({
        type: "toast_appeared",
        reason: `Success message appeared: "${text.slice(0, 60)}"`,
      })
      break // Only one toast check
    }
  }

  // No new console errors → no_errors check
  if (diff.consoleErrorsDelta === 0) {
    checks.push({
      type: "no_errors",
      reason: "No new console errors during interaction",
    })
  }

  return checks
}

// ─── Selectors to Monitor ────────────────────────────────────────────────────

/**
 * Standard selectors to track element counts for state snapshots.
 * These are checked before and after each interaction.
 */
export const MONITORED_SELECTORS = [
  "tbody tr",
  "[role='row']",
  "table",
  "[role='dialog']",
  "[role='alert']",
  "[role='status']",
  ".toast, [data-sonner-toast]",
  "form",
  "input:visible",
  "button:visible",
  ".error, .text-red-500, [class*='error']",
  ".empty-state, :text('No results'), :text('No data')",
  "nav a.active, nav [aria-current='page']",
  "[class*='modal']",
  "[class*='filter-chip'], [class*='badge']",
  "thead th",
]
