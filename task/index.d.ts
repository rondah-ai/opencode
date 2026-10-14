import type { Buffer } from "node:buffer"

export type PolicyMethod = "GET" | "POST"

export interface AllowRule {
  origin: string
  methods: PolicyMethod[]
  pathExact?: string
  pathPrefix?: string
  resourceTypes?: string[]
}

export type BlockCategory = "detail" | "secret" | "mutation"

export interface BlockRule {
  pathRegex: string
  category: BlockCategory
}

export type FieldLocator = ({ labelText: string } | { selector: string }) & { value?: true }
export interface ActionRule {
  origin: string
  methods: ["GET"]
  pathTemplate: string
  resourceTypes: ("fetch" | "xhr")[]
  emptyQuery: true
  maxCount: 1
}
export interface DetailAction { type: "click" | "waitFor" | "dismiss"; selector: string; mutation?: true }
export interface BeforeAction { index: number; type: DetailAction["type"]; mutation: boolean }

export interface TaskDocument {
  checkpoint?: "authenticated_list" | "matched_client" | "details_opened"
  viewport?: { width: number; height: number }
  screenshots?: Partial<Record<"login" | "authenticated_list" | "matched_client" | "details_opened", { requiredMaskSelectors: string[] }>>
  schemaVersion: 1
  name: string
  version: string
  startUrl: string
  origins: { login: string[]; list: string[] }
  auth: {
    mode: "env" | "manual"
    loginOrigin: string
    usernameSelector: string
    passwordSelector: string
    submitSelector: string
    usernameInput: string
    passwordInput: string
    maxWaitMs: number
  }
  requestPolicy: { login: AllowRule[]; list: AllowRule[]; action?: ActionRule[]; blocked: BlockRule[] }
  list: {
    pathPrefix: string
    markers: string[]
    recordSelector: string
    fields: { integrationName: FieldLocator; status: FieldLocator; pgid: FieldLocator; clientId: FieldLocator }
    pagination: { nextSelector: string | null; advertisedTotalSelector: string | null; advertisedTotalFormat?: "digits" | "total_items"; maxPages: number }
  }
  details?: { linkSelector: string; pathPrefix: string; markers: string[]; pgid: FieldLocator; clientId?: FieldLocator; clientSecret?: FieldLocator; integrationId?: FieldLocator; expect?: { field: FieldLocator; sensitiveInput: string }; actions?: DetailAction[] }
  match: { pgid: { parameter: string }; status: string; integrationName: string }
  output: { name: string; field: "clientId" | "clientSecret"; format: "uuid" | { exactLength: number; rejectValues: string[] }; source?: "list" | "details" }
  limits: { actionTimeoutMs: number; totalTimeoutMs: number; cleanupTimeoutMs: number }
}

export interface TaskRunEvent {
  type: "stage"
  stage: string
}

export interface SensitiveOutput {
  runId: string
  outputId: string
  value: string
}

export interface TaskRunResult {
  status: "succeeded" | "failed" | "cancelled"
  code: string
  errorName?: string
  stage: string
  completedCheckpoint?: "authenticated_list" | "matched_client" | "details_opened"
  elapsedMs: number
  pagesScanned: number
  recordsSeen: number
  matchCount: number
  advertisedTotal: number | null
  listStructure?: Record<"integrationName" | "status" | "pgid", {
    count: number
    ancestors?: { tag: string; classes: string[] }[]
    nextSiblingTag?: string | null
    lastLabelStructure?: { tag: string; ancestors: { tag: string; classes: string[]; knownLabelCounts?: Record<"integrationName" | "status" | "pgid", number>; display: "none" | "contents" | "block" | "inline" | "inline-block" | "flex" | "inline-flex" | "grid" | "inline-grid" | "table" | "table-row" | "table-cell" | "list-item" | "other" }[]; nextSiblingTag: string | null }
  }> & {
    totalItems: { count: number; tag?: string; classes?: string[] }
    recordCandidates: {
      count: number
      visibleCount: number
      firstDisplay?: "none" | "contents" | "block" | "inline" | "inline-block" | "flex" | "inline-flex" | "grid" | "inline-grid" | "table" | "table-row" | "table-cell" | "list-item" | "other"
      firstHasVisibleDescendant?: boolean
    }
  }
  blockedRequests: {
    attempted: number
    byCategory: Record<string, number>
    samples?: { method: string; resourceType: string; category: string; origin: string; path: string }[]
  }
  mutationDispatched?: boolean
  dispatchedProhibited: 0
  popupsClosed: number
  outputs: Record<string, "delivered" | "not_delivered">
  cleanup: "closed" | "forced" | "failed"
}

export interface RunTaskOptions {
  execution: { runId: string; taskDigest: string }
  task: TaskDocument
  parameters: Record<string, string>
  sensitiveInputs?: Record<string, string>
  signal?: AbortSignal
  browser?: { headless?: boolean }
  hooks?: {
    onBeforeAction?: (action: BeforeAction) => Promise<void>
    onBeforeMutation?: () => Promise<void>
    onBrowserProcess?: (pid: number) => Promise<void>
    onEvent?: (event: TaskRunEvent) => void
    onSensitiveOutput?: (output: SensitiveOutput) => Promise<void>
    onScreenshot?: (screenshot: { stage: "login" | "authenticated_list" | "matched_client" | "details_opened"; png: Buffer }) => Promise<void>
  }
}

export declare class TaskValidationError extends Error {
  code: "invalid_task" | "missing_parameter" | "missing_sensitive_input"
  issues: string[]
}

export declare class TaskFailure extends Error {
  code: string
  stage: string
}

export declare const FAILURE_CODES: readonly string[]

export declare function validateTask(task: unknown): TaskDocument

export declare function runTask(options: RunTaskOptions): Promise<TaskRunResult>

export interface RequestGuard {
  readonly phase: "login" | "list" | "action"
  setPhase(phase: "login" | "list" | "action"): void
  setDetailUrl(url: string): void
  setActionBindings(bindings: { integrationId: string; pgid: string }): void
  armAction(): void
  counts: { attempted: number; byCategory: Record<string, number> }
  reject(category: string): void
  decide(request: { url: string; method: string; resourceType: string }): { allow: true; mutation?: true } | { allow: false; category: string }
}

export declare function createRequestGuard(policy: TaskDocument["requestPolicy"]): RequestGuard
