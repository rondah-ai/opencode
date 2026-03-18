import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./verify_behavior.txt"
import { BrowserManager } from "../browser/manager"
import { getKnownIssue, shouldIgnoreConsoleError } from "../qa/instructions"
import {
  captureState,
  getSnapshot,
  runChecks,
  type VerifyCheck,
} from "../qa/state-snapshot"

const CheckSchema = z.object({
  name: z.string().describe("Human label for this check (e.g., 'row count')"),
  type: z
    .enum([
      "element_count_changed",
      "element_appeared",
      "element_disappeared",
      "text_appeared",
      "text_disappeared",
      "url_changed",
      "no_errors",
      "toast_appeared",
      "count_equals",
      "custom_selector_visible",
      "custom_selector_hidden",
    ])
    .describe("The deterministic check type to run"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (required for element_* and count_* checks)"),
  value: z
    .string()
    .optional()
    .describe("Expected value (required for text_* and count_equals checks)"),
})

export const VerifyBehaviorTool = Tool.define("verify_behavior", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z
      .string()
      .describe(
        'What action was performed, or "capture_before" to take a pre-action snapshot',
      ),
    checks: z
      .array(CheckSchema)
      .describe("List of checks to capture/verify"),
    beforeSnapshot: z
      .string()
      .optional()
      .describe("Snapshot ID from a previous capture_before call"),
  }),
  async execute(params, ctx) {
    const page = await BrowserManager.getPage()
    const startTime = Date.now()

    // ── Phase A: Capture Before ───────────────────────────────────────
    if (params.action === "capture_before") {
      await ctx.ask({
        permission: "verify_behavior",
        patterns: ["capture_before"],
        always: ["*"],
        metadata: { phase: "capture_before", checkCount: params.checks.length },
      })

      const snapshot = await captureState(page, params.checks as VerifyCheck[])

      const selectors = params.checks
        .filter((c) => c.selector)
        .map((c) => `  ${c.name}: ${c.selector} = ${snapshot.elementCounts[c.selector!] ?? "n/a"}`)
        .join("\n")

      const output = [
        `State captured: ${snapshot.id}`,
        `URL: ${snapshot.url}`,
        `Timestamp: ${new Date(snapshot.timestamp).toISOString()}`,
        `Element counts:`,
        selectors || "  (no selector-based checks)",
        `Visible text snippets: ${snapshot.visibleText.length}`,
        "",
        "Next: perform your action, then call verify_behavior with:",
        `  beforeSnapshot: "${snapshot.id}"`,
      ].join("\n")

      return {
        title: `Snapshot: ${snapshot.id}`,
        output,
        metadata: {
          phase: "capture_before",
          snapshotId: snapshot.id,
          url: snapshot.url,
          elementCounts: snapshot.elementCounts,
          textSnippetCount: snapshot.visibleText.length,
        },
      }
    }

    // ── Phase B: Verify After ─────────────────────────────────────────
    if (!params.beforeSnapshot) {
      throw new Error(
        'For verification, provide a beforeSnapshot ID from a previous capture_before call. ' +
        'Call with action="capture_before" first.',
      )
    }

    const before = getSnapshot(params.beforeSnapshot)
    if (!before) {
      throw new Error(
        `Snapshot "${params.beforeSnapshot}" not found. It may have expired or the browser was reset. ` +
        'Call capture_before again.',
      )
    }

    await ctx.ask({
      permission: "verify_behavior",
      patterns: [params.action],
      always: ["*"],
      metadata: {
        phase: "verify",
        action: params.action,
        checkCount: params.checks.length,
      },
    })

    const results = await runChecks(
      page,
      params.checks as VerifyCheck[],
      before,
    )

    const passed = results.filter((r) => r.passed).length
    const failed = results.filter((r) => !r.passed).length
    const total = results.length
    const duration = Date.now() - startTime

    const checksOutput = results
      .map((r) => `  ${r.passed ? "PASS" : "FAIL"} [${r.type}] ${r.name}: ${r.detail}`)
      .join("\n")

    const output = [
      `Verification: "${params.action}"`,
      `Result: ${passed}/${total} checks passed${failed > 0 ? ` (${failed} failed)` : ""}`,
      `Duration: ${duration}ms`,
      "",
      "Checks:",
      checksOutput,
    ].join("\n")

    return {
      title: `Verify: ${params.action} — ${passed}/${total} passed`,
      output,
      metadata: {
        phase: "verify",
        action: params.action,
        passed,
        failed,
        total,
        allPassed: failed === 0,
        checks: results,
        duration,
        beforeSnapshot: params.beforeSnapshot,
      },
    }
  },
})
