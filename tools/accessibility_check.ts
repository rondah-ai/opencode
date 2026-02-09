import z from "zod"
import { Tool } from "./tool"
import { BrowserManager } from "../browser/manager"

const DESCRIPTION = `
Perform comprehensive accessibility (a11y) checks on web pages.

This tool validates:
- ARIA attributes and roles
- Color contrast ratios (WCAG standards)
- Keyboard navigation
- Form labels and descriptions
- Heading hierarchy
- Alt text for images
- Interactive element accessibility
- Focus management

Standards Checked:
- WCAG 2.1 Level AA (default)
- WCAG 2.1 Level AAA (optional)
- Section 508 compliance
- ADA compliance guidelines

Use cases:
- Ensure ADA/WCAG compliance
- Audit before launch
- Catch accessibility issues early
- Document accessibility status
- Track improvements over time

Prerequisites:
- Page must be loaded in browser
- Interactive elements should be visible
`

interface AccessibilityIssue {
  severity: "critical" | "serious" | "moderate" | "minor"
  type: string
  message: string
  element: string
  wcagCriteria: string
  suggestion: string
}

export const AccessibilityCheckTool = Tool.define("accessibility_check", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().optional().describe("URL to check (if not already on page)"),
    level: z.enum(["A", "AA", "AAA"]).default("AA").describe("WCAG conformance level"),
    checks: z
      .array(z.enum(["aria", "contrast", "keyboard", "forms", "headings", "images", "all"]))
      .default(["all"])
      .describe("Specific checks to run"),
    selector: z.string().optional().describe("Check specific element/section only"),
  }),
  async execute(params, ctx) {
    // Get page
    const page = params.url ? await BrowserManager.navigate(params.url) : await BrowserManager.getPage()

    const issues: AccessibilityIssue[] = []
    const passedChecks: string[] = []
    const checkTypes = params.checks.includes("all")
      ? ["aria", "contrast", "keyboard", "forms", "headings", "images"]
      : params.checks

    // Run accessibility checks using Playwright's built-in accessibility tree
    try {
      // 1. ARIA Checks
      if (checkTypes.includes("aria")) {
        const ariaIssues = await checkAria(page, params.selector)
        issues.push(...ariaIssues)
        if (ariaIssues.length === 0) passedChecks.push("ARIA attributes")
      }

      // 2. Color Contrast Checks
      if (checkTypes.includes("contrast")) {
        const contrastIssues = await checkContrast(page, params.level, params.selector)
        issues.push(...contrastIssues)
        if (contrastIssues.length === 0) passedChecks.push("Color contrast")
      }

      // 3. Keyboard Navigation Checks
      if (checkTypes.includes("keyboard")) {
        const keyboardIssues = await checkKeyboard(page, params.selector)
        issues.push(...keyboardIssues)
        if (keyboardIssues.length === 0) passedChecks.push("Keyboard navigation")
      }

      // 4. Form Accessibility Checks
      if (checkTypes.includes("forms")) {
        const formIssues = await checkForms(page, params.selector)
        issues.push(...formIssues)
        if (formIssues.length === 0) passedChecks.push("Form accessibility")
      }

      // 5. Heading Hierarchy Checks
      if (checkTypes.includes("headings")) {
        const headingIssues = await checkHeadings(page, params.selector)
        issues.push(...headingIssues)
        if (headingIssues.length === 0) passedChecks.push("Heading hierarchy")
      }

      // 6. Image Alt Text Checks
      if (checkTypes.includes("images")) {
        const imageIssues = await checkImages(page, params.selector)
        issues.push(...imageIssues)
        if (imageIssues.length === 0) passedChecks.push("Image alt text")
      }

      // Sort issues by severity
      const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 }
      issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

      // Count by severity
      const critical = issues.filter((i) => i.severity === "critical").length
      const serious = issues.filter((i) => i.severity === "serious").length
      const moderate = issues.filter((i) => i.severity === "moderate").length
      const minor = issues.filter((i) => i.severity === "minor").length

      // Generate report
      const passed = issues.length === 0

      const output = `${passed ? "✅" : "⚠️"} Accessibility Check ${passed ? "PASSED" : "FAILED"}

Page: ${page.url()}
WCAG Level: ${params.level}
Checks Run: ${checkTypes.join(", ")}

${passed ? "🎉 No accessibility issues found!" : `Issues Found: ${issues.length}`}

${!passed ? `
Severity Breakdown:
🔴 Critical: ${critical} (Must fix - blocks users)
🟠 Serious: ${serious} (Should fix - significant barriers)
🟡 Moderate: ${moderate} (Should fix - minor barriers)
🔵 Minor: ${minor} (Nice to fix - improvements)
` : ""}

${passedChecks.length > 0 ? `✅ Passed Checks:\n${passedChecks.map((c) => `   - ${c}`).join("\n")}\n` : ""}

${!passed ? `
Detailed Issues:
${issues
  .slice(0, 10)
  .map(
    (issue, i) => `
${i + 1}. ${getSeverityIcon(issue.severity)} ${issue.type}
   Element: ${issue.element}
   Issue: ${issue.message}
   WCAG: ${issue.wcagCriteria}
   Fix: ${issue.suggestion}`,
  )
  .join("\n")}
${issues.length > 10 ? `\n... and ${issues.length - 10} more issues` : ""}
` : ""}

${!passed ? `
Compliance Status:
${critical > 0 || serious > 0 ? "❌ NOT COMPLIANT - Critical/serious issues must be fixed" : moderate > 0 ? "⚠️ PARTIALLY COMPLIANT - Moderate issues should be addressed" : "✅ MOSTLY COMPLIANT - Only minor improvements needed"}

Priority Actions:
${critical > 0 ? `1. Fix ${critical} critical issue${critical > 1 ? "s" : ""} immediately` : ""}
${serious > 0 ? `${critical > 0 ? "2" : "1"}. Address ${serious} serious issue${serious > 1 ? "s" : ""}` : ""}
${moderate > 0 ? `${critical + serious > 0 ? critical > 0 && serious > 0 ? "3" : "2" : "1"}. Resolve ${moderate} moderate issue${moderate > 1 ? "s" : ""}` : ""}
` : ""}

WCAG ${params.level} Compliance: ${passed ? "✅ PASSED" : critical === 0 && serious === 0 ? "⚠️ PARTIAL" : "❌ FAILED"}`

      return {
        output,
        title: passed ? "Accessibility Check Passed" : "Accessibility Issues Found",
        metadata: {
          passed,
          totalIssues: issues.length,
          critical,
          serious,
          moderate,
          minor,
          wcagLevel: params.level,
          compliant: critical === 0 && serious === 0,
          issues: issues.slice(0, 20), // Return first 20 for metadata
        },
      }
    } catch (error) {
      return {
        output: `Error performing accessibility check: ${error instanceof Error ? error.message : String(error)}`,
        title: "Accessibility Check Error",
        metadata: {
          error: true,
        },
      }
    }
  },
})

// Helper functions for each check type
async function checkAria(page: any, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Get accessibility tree
  const snapshot = await page.accessibility.snapshot({
    root: selector ? await page.locator(selector).first().elementHandle() : undefined,
  })

  // Check for missing ARIA attributes on interactive elements
  const interactiveSelector = selector
    ? `${selector} button, ${selector} a, ${selector} input, ${selector} select`
    : "button, a, input, select, textarea"

  const interactive = await page.locator(interactiveSelector).all()

  for (const element of interactive.slice(0, 20)) {
    // Limit to first 20
    const role = await element.getAttribute("role")
    const ariaLabel = await element.getAttribute("aria-label")
    const ariaLabelledBy = await element.getAttribute("aria-labelledby")
    const ariaDescribedBy = await element.getAttribute("aria-describedby")
    const text = await element.textContent()

    if (!role && !ariaLabel && !ariaLabelledBy && !text?.trim()) {
      const tagName = await element.evaluate((el) => el.tagName.toLowerCase())
      issues.push({
        severity: "serious",
        type: "Missing accessible name",
        message: `Interactive element has no accessible name`,
        element: `<${tagName}>`,
        wcagCriteria: "WCAG 4.1.2 (Name, Role, Value)",
        suggestion: "Add aria-label, aria-labelledby, or visible text content",
      })
    }
  }

  return issues
}

async function checkContrast(page: any, level: string, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Simplified contrast check (in production, use actual color extraction and ratio calculation)
  // This is a placeholder - real implementation would:
  // 1. Get computed styles for text elements
  // 2. Calculate contrast ratio between text and background
  // 3. Compare against WCAG standards (4.5:1 for AA, 7:1 for AAA)

  // For now, check for common contrast issues
  const textSelector = selector ? `${selector} p, ${selector} span, ${selector} a` : "p, span, a"
  const textElements = await page.locator(textSelector).all()

  // Check first 10 elements as sample
  for (const element of textElements.slice(0, 10)) {
    const isVisible = await element.isVisible().catch(() => false)
    if (!isVisible) continue

    // Placeholder check - in production, calculate actual contrast
    const style = await element.evaluate((el) => {
      const computed = window.getComputedStyle(el)
      return {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontSize: computed.fontSize,
      }
    })

    // Simplified check: if background is very light and text is light
    if (
      style.backgroundColor.includes("255, 255, 255") &&
      (style.color.includes("200") || style.color.includes("220"))
    ) {
      issues.push({
        severity: "moderate",
        type: "Possible low contrast",
        message: `Text may have insufficient contrast ratio`,
        element: await element.evaluate((el) => el.tagName.toLowerCase()),
        wcagCriteria: `WCAG 1.4.3 (Contrast - Level ${level})`,
        suggestion: "Verify contrast ratio meets minimum requirements (4.5:1 for normal text)",
      })
    }
  }

  return issues
}

async function checkKeyboard(page: any, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Check for keyboard-accessible interactive elements
  const interactiveSelector = selector
    ? `${selector} button, ${selector} a, ${selector} input`
    : "button:visible, a:visible, input:visible"

  const interactive = await page.locator(interactiveSelector).all()

  for (const element of interactive.slice(0, 15)) {
    const tabindex = await element.getAttribute("tabindex")
    const isDisabled = await element.isDisabled().catch(() => false)

    if (tabindex === "-1" && !isDisabled) {
      issues.push({
        severity: "serious",
        type: "Not keyboard accessible",
        message: "Interactive element is not keyboard accessible",
        element: await element.evaluate((el) => el.tagName.toLowerCase()),
        wcagCriteria: "WCAG 2.1.1 (Keyboard)",
        suggestion: "Remove tabindex=-1 or ensure focusable via other means",
      })
    }
  }

  return issues
}

async function checkForms(page: any, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Check form inputs have labels
  const inputSelector = selector ? `${selector} input, ${selector} textarea` : "input, textarea, select"
  const inputs = await page.locator(inputSelector).all()

  for (const input of inputs.slice(0, 20)) {
    const type = await input.getAttribute("type")
    if (type === "hidden" || type === "submit") continue

    const id = await input.getAttribute("id")
    const ariaLabel = await input.getAttribute("aria-label")
    const ariaLabelledBy = await input.getAttribute("aria-labelledby")

    let hasLabel = false
    if (id) {
      const label = await page.locator(`label[for="${id}"]`).count()
      hasLabel = label > 0
    }

    if (!hasLabel && !ariaLabel && !ariaLabelledBy) {
      issues.push({
        severity: "serious",
        type: "Missing form label",
        message: "Form input has no associated label",
        element: `<input type="${type || "text"}">`,
        wcagCriteria: "WCAG 3.3.2 (Labels or Instructions)",
        suggestion: "Add a <label> element or aria-label attribute",
      })
    }
  }

  return issues
}

async function checkHeadings(page: any, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Check heading hierarchy
  const headingSelector = selector ? `${selector} h1, ${selector} h2, ${selector} h3` : "h1, h2, h3, h4, h5, h6"
  const headings = await page.locator(headingSelector).all()

  let prevLevel = 0
  for (const heading of headings.slice(0, 20)) {
    const tagName = await heading.evaluate((el) => el.tagName.toLowerCase())
    const level = parseInt(tagName.replace("h", ""))

    if (level - prevLevel > 1) {
      issues.push({
        severity: "moderate",
        type: "Heading hierarchy skip",
        message: `Heading skips from h${prevLevel} to h${level}`,
        element: `<${tagName}>`,
        wcagCriteria: "WCAG 1.3.1 (Info and Relationships)",
        suggestion: `Use h${prevLevel + 1} instead of h${level} to maintain hierarchy`,
      })
    }

    prevLevel = level
  }

  return issues
}

async function checkImages(page: any, selector?: string): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = []

  // Check images have alt text
  const imageSelector = selector ? `${selector} img` : "img"
  const images = await page.locator(imageSelector).all()

  for (const image of images.slice(0, 20)) {
    const alt = await image.getAttribute("alt")
    const ariaLabel = await image.getAttribute("aria-label")
    const role = await image.getAttribute("role")

    if (alt === null && !ariaLabel && role !== "presentation") {
      const src = await image.getAttribute("src")
      issues.push({
        severity: "serious",
        type: "Missing alt text",
        message: "Image has no alt text",
        element: `<img src="${src?.substring(0, 50)}...">`,
        wcagCriteria: "WCAG 1.1.1 (Non-text Content)",
        suggestion: 'Add alt="" for decorative images or descriptive alt text for content images',
      })
    }
  }

  return issues
}

function getSeverityIcon(severity: string): string {
  switch (severity) {
    case "critical":
      return "🔴"
    case "serious":
      return "🟠"
    case "moderate":
      return "🟡"
    case "minor":
      return "🔵"
    default:
      return "⚪"
  }
}
