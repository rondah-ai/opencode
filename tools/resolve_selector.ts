import z from "zod"
import { Tool } from "./tool"
import { getQAContext } from "./load_qa_context"

const DESCRIPTION = `
Resolve natural language element descriptions to CSS selectors using anchor points.

This tool converts human-friendly element descriptions into precise CSS selectors
by querying the QA_ANCHOR_POINTS.json blueprint. It understands:
- Common patterns (buttons, inputs, tables, dialogs)
- Framework-specific components (NextUI chips, shadcn/ui elements)
- Role-based selectors
- Custom element descriptions

Examples:
- "Add Appointment Type button" → "button:contains('Add Appointment Type')"
- "email input" → "input[type='email']"
- "first row status chip" → "tbody tr:first-child [class*='nextui-chip']"
- "close dialog button" → "[role='dialog'] button[aria-label='Close']"
- "search input in call logs" → "input[placeholder*='Search']"

Prerequisites:
- QA context must be loaded first using load_qa_context tool

This helps when:
- Writing custom test scenarios
- Debugging selector issues
- Understanding anchor point patterns
- Building new flows
`

export const ResolveSelectorTool = Tool.define("resolve_selector", {
  description: DESCRIPTION,
  parameters: z.object({
    description: z.string().describe("Natural language description of the element"),
    context: z.string().optional().describe("Additional context (page/section where element appears)"),
    returnAll: z.boolean().default(false).describe("Return all possible selectors instead of best match"),
  }),
  async execute(params, ctx) {
    // Get QA context
    const qaContext = getQAContext()
    if (!qaContext) {
      return {
        output: `Error: QA context not loaded.

Please load the QA context first using:
  load_qa_context(directory="/path/to/project")`,
        title: "Resolve Selector - Error",
      }
    }

    const anchorPoints = qaContext.anchorPoints
    const description = params.description.toLowerCase()
    const matches: Array<{ selector: string; confidence: number; source: string; description: string }> = []

    // Helper to add match
    function addMatch(selector: string, confidence: number, source: string, desc: string) {
      matches.push({ selector, confidence, source, description: desc })
    }

    // 1. Check common patterns first
    if (anchorPoints.commonPatterns) {
      const patterns = anchorPoints.commonPatterns

      // Button patterns
      if (description.includes("button")) {
        const buttonText = extractQuotedText(description) || extractKeywords(description, ["button"])
        if (buttonText) {
          const selector = patterns.buttonByText?.replace("{text}", buttonText) || `button:contains('${buttonText}')`
          addMatch(selector, 95, "commonPatterns.buttonByText", `Button containing "${buttonText}"`)
        }

        // Icon-based buttons
        const iconMatch = description.match(/(\w+)\s+icon|icon\s+(\w+)/)
        if (iconMatch) {
          const iconName = iconMatch[1] || iconMatch[2]
          const selector =
            patterns.buttonByIcon?.replace("{iconName}", iconName) || `button svg[class*='lucide-${iconName}']`
          addMatch(selector, 90, "commonPatterns.buttonByIcon", `Button with ${iconName} icon`)
        }
      }

      // Input patterns
      if (description.includes("input") || description.includes("field")) {
        const labelText = extractQuotedText(description) || extractKeywords(description, ["input", "field"])
        if (labelText) {
          const selector =
            patterns.inputByLabel?.replace("{label}", labelText) || `label:contains('${labelText}') ~ input`
          addMatch(selector, 95, "commonPatterns.inputByLabel", `Input with label "${labelText}"`)
        }

        const placeholder = extractAfterKeyword(description, "placeholder")
        if (placeholder) {
          const selector =
            patterns.inputByPlaceholder?.replace("{placeholder}", placeholder) ||
            `input[placeholder='${placeholder}']`
          addMatch(selector, 95, "commonPatterns.inputByPlaceholder", `Input with placeholder "${placeholder}"`)
        }
      }

      // Chip/tag patterns
      if (description.includes("chip") || description.includes("tag") || description.includes("badge")) {
        const chipText = extractQuotedText(description) || extractKeywords(description, ["chip", "tag", "badge"])
        if (chipText) {
          const selector = patterns.chipByText?.replace("{text}", chipText) || `[class*='nextui-chip']:contains('${chipText}')`
          addMatch(selector, 90, "commonPatterns.chipByText", `Chip containing "${chipText}"`)
        }
      }

      // Table patterns
      if (description.includes("table") || description.includes("row") || description.includes("cell")) {
        if (description.includes("row")) {
          const rowText = extractQuotedText(description)
          if (rowText) {
            const selector = patterns.tableRowByText?.replace("{text}", rowText) || `tbody tr:contains('${rowText}')`
            addMatch(selector, 90, "commonPatterns.tableRowByText", `Table row containing "${rowText}"`)
          }

          const rowMatch = description.match(/(\d+)(?:st|nd|rd|th)?\s+row|row\s+(\d+)/)
          if (rowMatch) {
            const rowNum = rowMatch[1] || rowMatch[2]
            addMatch(`tbody tr:nth-child(${rowNum})`, 95, "commonPatterns.tableRow", `Row ${rowNum}`)
          }
        }

        if (description.includes("cell")) {
          const cellMatch = description.match(/row\s+(\d+).*?(?:column|col)\s+(\d+)|(?:column|col)\s+(\d+).*?row\s+(\d+)/)
          if (cellMatch) {
            const row = cellMatch[1] || cellMatch[4]
            const col = cellMatch[2] || cellMatch[3]
            const selector = patterns.tableCell?.replace("{row}", row).replace("{col}", col) || `tbody tr:nth-child(${row}) td:nth-child(${col})`
            addMatch(selector, 95, "commonPatterns.tableCell", `Cell at row ${row}, column ${col}`)
          }
        }
      }
    }

    // 2. Check specific button definitions
    if (description.includes("button") && anchorPoints.buttons?.primary) {
      const buttons = anchorPoints.buttons.primary

      if (description.includes("add") && buttons.add) {
        if (buttons.add.examples) {
          for (const example of buttons.add.examples) {
            if (description.includes(example.text.toLowerCase())) {
              addMatch(example.selector, 98, "buttons.primary.add", example.text)
            }
          }
        }
        if (buttons.add.pattern) {
          addMatch(buttons.add.pattern, 85, "buttons.primary.add.pattern", "Add button (generic)")
        }
      }

      if (description.includes("edit") && buttons.edit) {
        addMatch(buttons.edit.selector || buttons.edit.pattern, 95, "buttons.primary.edit", "Edit button")
      }

      if (description.includes("delete") && buttons.delete) {
        addMatch(buttons.delete.selector || buttons.delete.pattern, 95, "buttons.primary.delete", "Delete button")
      }

      if (description.includes("save") && buttons.save) {
        addMatch(buttons.save.selector || buttons.save.pattern, 95, "buttons.primary.save", "Save button")
      }

      if (description.includes("cancel") && buttons.cancel) {
        addMatch(buttons.cancel.selector || buttons.cancel.pattern, 95, "buttons.primary.cancel", "Cancel button")
      }
    }

    // 3. Check action buttons
    if (anchorPoints.buttons?.actions) {
      const actions = anchorPoints.buttons.actions

      if (description.includes("copy") && actions.copy) {
        addMatch(actions.copy.selector, 95, "buttons.actions.copy", actions.copy.tooltip || "Copy action")
      }

      if (description.includes("share") && actions.share) {
        addMatch(actions.share.selector, 95, "buttons.actions.share", actions.share.tooltip || "Share action")
      }

      if (description.includes("view") && actions.view) {
        addMatch(actions.view.selector, 95, "buttons.actions.view", actions.view.tooltip || "View action")
      }
    }

    // 4. Check form inputs
    if (anchorPoints.forms?.inputs) {
      const inputs = anchorPoints.forms.inputs

      if (description.includes("email") && inputs.text) {
        addMatch("input[type='email']", 98, "forms.inputs.text", "Email input")
      }

      if (description.includes("password") && inputs.text) {
        addMatch("input[type='password']", 98, "forms.inputs.text", "Password input")
      }

      if (description.includes("text") && inputs.text) {
        addMatch("input[type='text']", 90, "forms.inputs.text", "Text input")
      }

      if ((description.includes("select") || description.includes("dropdown")) && inputs.select) {
        addMatch(inputs.select.trigger, 95, "forms.inputs.select", "Select/dropdown trigger")
      }

      if (description.includes("checkbox") && inputs.checkbox) {
        const labelText = extractQuotedText(description)
        if (labelText) {
          const selector = inputs.checkbox.byLabel?.replace("{labelText}", labelText) || `label:contains('${labelText}') input[type='checkbox']`
          addMatch(selector, 95, "forms.inputs.checkbox", `Checkbox with label "${labelText}"`)
        } else {
          addMatch(inputs.checkbox.byRole || "[role='checkbox']", 85, "forms.inputs.checkbox", "Checkbox (generic)")
        }
      }

      if ((description.includes("radio") || description.includes("option")) && inputs.radio) {
        addMatch(inputs.radio.group, 85, "forms.inputs.radio", "Radio group")
      }

      if ((description.includes("switch") || description.includes("toggle")) && inputs.switch) {
        const labelText = extractQuotedText(description)
        if (labelText) {
          const selector = inputs.switch.byLabel?.replace("{labelText}", labelText) || `label:contains('${labelText}') [role='switch']`
          addMatch(selector, 95, "forms.inputs.switch", `Switch with label "${labelText}"`)
        } else {
          addMatch(inputs.switch.element || "[role='switch']", 85, "forms.inputs.switch", "Switch (generic)")
        }
      }

      if (description.includes("date") && inputs.dateRange) {
        addMatch(inputs.dateRange.input, 95, "forms.inputs.dateRange", "Date range input")
      }
    }

    // 5. Check dialogs/modals
    if (description.includes("dialog") || description.includes("modal")) {
      if (anchorPoints.dialogs) {
        if (description.includes("close")) {
          addMatch(anchorPoints.dialogs.close, 98, "dialogs.close", "Close dialog button")
        } else if (description.includes("title")) {
          addMatch(anchorPoints.dialogs.title, 95, "dialogs.title", "Dialog title")
        } else {
          addMatch(anchorPoints.dialogs.container, 90, "dialogs.container", "Dialog container")
        }
      }
    }

    // 6. Check tables
    if (anchorPoints.tables?.generic) {
      const table = anchorPoints.tables.generic

      if (description.includes("table")) {
        if (description.includes("header")) {
          addMatch(table.header || "thead th", 95, "tables.generic.header", "Table header")
        } else if (description.includes("row")) {
          addMatch(table.rows || "tbody tr", 95, "tables.generic.rows", "Table rows")
        } else if (description.includes("cell")) {
          addMatch(table.cells || "tbody td", 95, "tables.generic.cells", "Table cells")
        } else if (description.includes("checkbox")) {
          addMatch(table.checkbox || "input[type='checkbox']", 95, "tables.generic.checkbox", "Table checkbox")
        }
      }

      if (description.includes("pagination") || description.includes("next") || description.includes("previous")) {
        if (description.includes("next")) {
          addMatch(table.pagination?.next || "button:contains('Next')", 95, "tables.pagination.next", "Next page button")
        } else if (description.includes("previous") || description.includes("prev")) {
          addMatch(table.pagination?.previous || "button:contains('Previous')", 95, "tables.pagination.previous", "Previous page button")
        }
      }
    }

    // 7. Check search/filter elements
    if (description.includes("search") && anchorPoints.filters?.search) {
      if (params.context?.includes("call") || description.includes("call")) {
        addMatch(anchorPoints.filters.search.callLogs || "input[placeholder*='Search call']", 95, "filters.search.callLogs", "Call logs search")
      } else {
        addMatch(anchorPoints.filters.search.general || "input[placeholder*='Search']", 90, "filters.search.general", "Search input (generic)")
      }
    }

    // 8. Check navigation elements
    if (description.includes("nav") || description.includes("sidebar") || description.includes("menu")) {
      if (anchorPoints.navigation?.sidebar?.items) {
        const items = anchorPoints.navigation.sidebar.items
        for (const [key, item] of Object.entries(items)) {
          if (description.includes(key.toLowerCase()) || description.includes(item.text.toLowerCase())) {
            addMatch(item.selector, 95, `navigation.sidebar.items.${key}`, `${item.text} navigation item`)
          }
        }
      }
    }

    // 9. Context-specific matches based on page
    if (params.context) {
      const context = params.context.toLowerCase()

      // Call logs specific
      if (context.includes("call") && anchorPoints.tables?.callLogs) {
        const callLogsTable = anchorPoints.tables.callLogs

        if (description.includes("status") && callLogsTable.statusDropdown) {
          addMatch(callLogsTable.statusDropdown.trigger, 95, "tables.callLogs.statusDropdown", "Call status dropdown")
        }

        if (callLogsTable.actions) {
          if (description.includes("copy") || description.includes("call id")) {
            addMatch(callLogsTable.actions.copyCallId.selector, 95, "tables.callLogs.actions.copyCallId", "Copy call ID")
          }
          if (description.includes("share") || description.includes("link")) {
            addMatch(callLogsTable.actions.shareLink.selector, 95, "tables.callLogs.actions.shareLink", "Share call link")
          }
          if (description.includes("view") || description.includes("details")) {
            addMatch(callLogsTable.actions.viewDetails.selector, 95, "tables.callLogs.actions.viewDetails", "View call details")
          }
        }
      }
    }

    // Sort by confidence
    matches.sort((a, b) => b.confidence - a.confidence)

    // Format output
    if (matches.length === 0) {
      return {
        output: `No selector matches found for: "${params.description}"

Suggestions:
- Try using more specific keywords (e.g., "Add button", "email input")
- Check if the element is defined in anchor points
- Use context parameter to specify the page/section
- Try describing the element differently

Example queries that work:
- "Add Appointment Type button"
- "email input"
- "first row status chip"
- "close dialog button"
- "search input"`,
        title: "Resolve Selector - No Matches",
      }
    }

    if (params.returnAll) {
      const output = `Found ${matches.length} selector matches for: "${params.description}"

All Matches (sorted by confidence):
${matches
  .map(
    (m, i) =>
      `${i + 1}. [${m.confidence}%] ${m.selector}
   Source: ${m.source}
   Description: ${m.description}`,
  )
  .join("\n\n")}

Usage:
- Use the highest confidence match for most reliable results
- Consider context when choosing between similar matches`

      return {
        output,
        title: "Resolve Selector - Multiple Matches",
        metadata: {
          matches: matches.map((m) => ({ selector: m.selector, confidence: m.confidence })),
        },
      }
    }

    // Return best match
    const best = matches[0]
    const alternatives = matches.slice(1, 3)

    const output = `Best Match: ${best.selector}

Confidence: ${best.confidence}%
Source: ${best.source}
Description: ${best.description}

${alternatives.length > 0 ? `Alternative Selectors:\n${alternatives.map((m, i) => `${i + 1}. [${m.confidence}%] ${m.selector}\n   ${m.description}`).join("\n")}` : ""}

Usage in browser_interact:
  browser_interact(action="click", selector="${best.selector}")

Usage in execute_flow:
  Flows already use optimal selectors from anchor points!`

    return {
      output,
      title: "Resolve Selector - Match Found",
      metadata: {
        selector: best.selector,
        confidence: best.confidence,
        alternatives: alternatives.map((m) => m.selector),
      },
    }
  },
})

// Helper functions
function extractQuotedText(str: string): string | null {
  const match = str.match(/["']([^"']+)["']/)
  return match ? match[1] : null
}

function extractKeywords(str: string, exclude: string[]): string {
  const words = str
    .split(/\s+/)
    .filter((w) => !exclude.includes(w.toLowerCase()) && w.length > 2)
  return words[0] || ""
}

function extractAfterKeyword(str: string, keyword: string): string | null {
  const regex = new RegExp(`${keyword}\\s+["']?([^"'\\s]+)["']?`)
  const match = str.match(regex)
  return match ? match[1] : null
}
