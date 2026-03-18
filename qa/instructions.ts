import z from "zod"
import fs from "fs/promises"

// ─── Schema ──────────────────────────────────────────────────────────────────

const ViewportSchema = z.object({
  width: z.number().default(1920),
  height: z.number().default(1080),
})

const GlobalSchema = z.object({
  viewport: ViewportSchema.default({}),
  defaultTimeout: z.number().default(30000),
  waitAfterAction: z.number().default(500),
  toastTimeout: z.number().default(5000),
  screenshotsOn: z
    .array(z.enum(["failure", "capability_complete", "every_step", "smoke_fail"]))
    .default(["failure", "capability_complete"]),
  customSelectors: z.record(z.string(), z.string()).default({}),
})

const ScopeSchema = z.object({
  exclude_routes: z.array(z.string()).default([]),
  exclude_capabilities: z.array(z.string()).default([]),
  include_only: z.array(z.string()).nullable().default(null),
  max_pages: z.number().default(20),
})

const SlowTransitionSchema = z.object({
  after: z.string(),
  wait: z.number(),
  reason: z.string().optional(),
})

const TimingSchema = z.object({
  slow_transitions: z.array(SlowTransitionSchema).default([]),
  toast_appear_delay: z.number().default(3000),
  page_load_buffer: z.number().default(1000),
})

const KnownIssueSchema = z.object({
  page: z.string(),
  issue: z.string(),
  pattern: z.string().optional(),
  action: z.enum(["skip_check", "ignore", "warn"]),
  reason: z.string(),
})

const AuthSchema = z.object({
  strategy: z.enum(["form", "token", "cookie"]).default("form"),
  session_duration: z.string().default("30m"),
  reauth_on_redirect: z.boolean().default(true),
  mfa: z.boolean().default(false),
})

export const QAInstructionsSchema = z.object({
  version: z.string(),
  global: GlobalSchema.default({}),
  scope: ScopeSchema.default({}),
  timing: TimingSchema.default({}),
  known_issues: z.array(KnownIssueSchema).default([]),
  auth: AuthSchema.default({}),
  environment_overrides: z.record(z.string(), z.record(z.string(), z.any())).default({}),
  agent_hints: z.array(z.string()).default([]),
})

export type QAInstructions = z.infer<typeof QAInstructionsSchema>

// ─── Cache ───────────────────────────────────────────────────────────────────

let cached: QAInstructions | null = null
let cachedEnvironment: string | null = null

export function getInstructions(): QAInstructions | null {
  return cached
}

export function clearInstructions(): void {
  cached = null
  cachedEnvironment = null
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loadInstructions(
  filePath: string,
  environment?: string,
): Promise<QAInstructions> {
  const content = await fs.readFile(filePath, "utf-8")
  let raw: unknown

  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error(`Invalid JSON in instructions file: ${filePath}`)
  }

  const result = QAInstructionsSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`QA instructions validation failed:\n${issues}`)
  }

  let instructions = result.data

  // Apply environment overrides
  if (environment && instructions.environment_overrides[environment]) {
    instructions = applyOverrides(instructions, instructions.environment_overrides[environment])
  }

  cached = instructions
  cachedEnvironment = environment ?? null
  return instructions
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

/**
 * Check if a route should be excluded from scanning/crawling
 */
export function isRouteExcluded(route: string): boolean {
  if (!cached) return false
  return cached.scope.exclude_routes.some((pattern) => {
    if (pattern.endsWith("/*")) {
      return route.startsWith(pattern.slice(0, -2))
    }
    return route === pattern
  })
}

/**
 * Check if a capability should be excluded from test plans
 */
export function isCapabilityExcluded(feature: string, capability: string): boolean {
  if (!cached) return false
  const fullName = `${feature}.${capability}`
  return cached.scope.exclude_capabilities.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return capability === pattern.slice(2)
    }
    return fullName === pattern
  })
}

/**
 * Get the wait time after a specific action type
 */
export function getWaitAfterAction(actionType: string): number {
  if (!cached) return 500

  const transition = cached.timing.slow_transitions.find(
    (t) => t.after === actionType,
  )
  return transition?.wait ?? cached.global.waitAfterAction
}

/**
 * Check if a known issue applies to a page and should be skipped/ignored
 */
export function getKnownIssue(
  page: string,
  issue: string,
): { action: "skip_check" | "ignore" | "warn"; reason: string } | null {
  if (!cached) return null

  const match = cached.known_issues.find(
    (ki) => ki.page === page && ki.issue === issue,
  )
  if (!match) return null

  return { action: match.action, reason: match.reason }
}

/**
 * Check if a console error should be ignored (matches known_issues pattern)
 */
export function shouldIgnoreConsoleError(page: string, errorText: string): boolean {
  if (!cached) return false

  return cached.known_issues.some(
    (ki) =>
      ki.page === page &&
      ki.issue === "console_error" &&
      ki.action === "ignore" &&
      ki.pattern &&
      errorText.includes(ki.pattern),
  )
}

/**
 * Check if screenshots should be taken for a given event
 */
export function shouldScreenshot(event: "failure" | "capability_complete" | "every_step" | "smoke_fail"): boolean {
  if (!cached) return event === "failure"
  return cached.global.screenshotsOn.includes(event)
}

// ─── Internal ────────────────────────────────────────────────────────────────

function applyOverrides(
  base: QAInstructions,
  overrides: Record<string, any>,
): QAInstructions {
  const merged = { ...base }

  for (const [section, values] of Object.entries(overrides)) {
    if (section in merged && typeof values === "object" && values !== null) {
      (merged as any)[section] = {
        ...(merged as any)[section],
        ...values,
      }
    }
  }

  return merged
}
