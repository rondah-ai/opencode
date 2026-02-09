import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { Instance } from "../project/instance"
import fs from "fs/promises"

const DESCRIPTION = `
Generate comprehensive HTML QA test reports with screenshots and execution details.

This tool creates professional, shareable QA reports that include:
- Test execution summary (pass/fail counts, duration)
- Detailed step-by-step results
- Embedded screenshots
- Error messages and stack traces
- Test metadata and parameters
- Performance metrics

The reports are saved as HTML files that can be:
- Opened in any browser
- Shared with team members
- Archived for historical tracking
- Used for compliance/audit trails

Prerequisites:
- Test execution data (flows, screenshots, results)

This is useful for:
- Documenting test results
- Sharing with stakeholders
- Creating audit trails
- Tracking test history
- Bug reporting
`

interface TestResult {
  flowName: string
  flowPath: string
  status: "passed" | "failed" | "skipped"
  duration: number
  steps?: Array<{
    step: number
    action: string
    description: string
    status: "passed" | "failed"
    screenshot?: string
    error?: string
  }>
  error?: string
  screenshots?: string[]
}

export const GenerateQAReportTool = Tool.define("generate_qa_report", {
  description: DESCRIPTION,
  parameters: z.object({
    title: z.string().describe("Report title (e.g., 'Smoke Test Results - 2024-01-22')"),
    results: z
      .array(
        z.object({
          flowName: z.string(),
          flowPath: z.string(),
          status: z.enum(["passed", "failed", "skipped"]),
          duration: z.number(),
          error: z.string().optional(),
          screenshots: z.array(z.string()).optional(),
        }),
      )
      .describe("Array of test results"),
    summary: z.string().optional().describe("Optional summary/notes about the test run"),
    metadata: z
      .record(z.string(), z.any())
      .optional()
      .describe("Additional metadata (environment, tester, etc.)"),
    outputFilename: z.string().optional().describe("Custom output filename (without extension)"),
  }),
  async execute(params, ctx) {
    const timestamp = new Date().toISOString()
    const reportDir = path.join(Instance.worktree, ".opencode", "qa-reports")
    await fs.mkdir(reportDir, { recursive: true })

    // Generate filename
    const filename =
      params.outputFilename || `qa-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`
    const filepath = path.join(reportDir, filename)

    // Calculate statistics
    const totalTests = params.results.length
    const passed = params.results.filter((r) => r.status === "passed").length
    const failed = params.results.filter((r) => r.status === "failed").length
    const skipped = params.results.filter((r) => r.status === "skipped").length
    const totalDuration = params.results.reduce((sum, r) => sum + r.duration, 0)
    const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : "0"

    // Generate HTML report
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${params.title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
        }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 14px; }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
            border-bottom: 1px solid #e0e0e0;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 6px;
            border-left: 4px solid #667eea;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .stat-card h3 {
            font-size: 14px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }
        .stat-card .value {
            font-size: 32px;
            font-weight: bold;
            color: #333;
        }
        .stat-card.passed { border-left-color: #10b981; }
        .stat-card.failed { border-left-color: #ef4444; }
        .stat-card.skipped { border-left-color: #f59e0b; }
        .stat-card.passed .value { color: #10b981; }
        .stat-card.failed .value { color: #ef4444; }
        .stat-card.skipped .value { color: #f59e0b; }
        .content { padding: 30px; }
        .test-result {
            background: #f8f9fa;
            border-radius: 6px;
            margin-bottom: 20px;
            overflow: hidden;
            border: 1px solid #e0e0e0;
        }
        .test-header {
            padding: 20px;
            background: white;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .test-header h3 {
            font-size: 18px;
            color: #333;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .status-badge.passed {
            background: #d1fae5;
            color: #065f46;
        }
        .status-badge.failed {
            background: #fee2e2;
            color: #991b1b;
        }
        .status-badge.skipped {
            background: #fef3c7;
            color: #92400e;
        }
        .test-details {
            padding: 20px;
        }
        .test-meta {
            display: flex;
            gap: 30px;
            margin-bottom: 15px;
            font-size: 14px;
            color: #666;
        }
        .test-meta strong { color: #333; }
        .error {
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 4px;
            padding: 15px;
            margin: 15px 0;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            color: #991b1b;
        }
        .screenshots {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .screenshot {
            border: 1px solid #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
            background: white;
        }
        .screenshot img {
            width: 100%;
            height: auto;
            display: block;
        }
        .screenshot-label {
            padding: 8px;
            font-size: 12px;
            color: #666;
            background: #f8f9fa;
            border-top: 1px solid #e0e0e0;
        }
        .metadata {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 6px;
            margin-top: 20px;
        }
        .metadata h3 {
            margin-bottom: 10px;
            color: #333;
        }
        .metadata dl {
            display: grid;
            grid-template-columns: 150px 1fr;
            gap: 10px;
            font-size: 14px;
        }
        .metadata dt {
            font-weight: 600;
            color: #666;
        }
        .metadata dd {
            color: #333;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 14px;
            border-top: 1px solid #e0e0e0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${params.title}</h1>
            <p>Generated on ${new Date(timestamp).toLocaleString()}</p>
        </div>

        <div class="summary">
            <div class="stat-card">
                <h3>Total Tests</h3>
                <div class="value">${totalTests}</div>
            </div>
            <div class="stat-card passed">
                <h3>Passed</h3>
                <div class="value">${passed}</div>
            </div>
            <div class="stat-card failed">
                <h3>Failed</h3>
                <div class="value">${failed}</div>
            </div>
            <div class="stat-card skipped">
                <h3>Skipped</h3>
                <div class="value">${skipped}</div>
            </div>
            <div class="stat-card">
                <h3>Pass Rate</h3>
                <div class="value">${passRate}%</div>
            </div>
            <div class="stat-card">
                <h3>Total Duration</h3>
                <div class="value">${(totalDuration / 1000).toFixed(1)}s</div>
            </div>
        </div>

        ${params.summary ? `<div class="content"><div class="metadata"><h3>Summary</h3><p>${params.summary}</p></div></div>` : ""}

        <div class="content">
            <h2 style="margin-bottom: 20px;">Test Results</h2>
            ${params.results
              .map(
                (result) => `
                <div class="test-result">
                    <div class="test-header">
                        <h3>
                            <span class="status-badge ${result.status}">${result.status}</span>
                            ${result.flowName}
                        </h3>
                        <span style="color: #666; font-size: 14px;">${(result.duration / 1000).toFixed(2)}s</span>
                    </div>
                    <div class="test-details">
                        <div class="test-meta">
                            <div><strong>Flow Path:</strong> ${result.flowPath}</div>
                            <div><strong>Duration:</strong> ${result.duration}ms</div>
                        </div>
                        ${result.error ? `<div class="error"><strong>Error:</strong><br>${result.error}</div>` : ""}
                        ${
                          result.screenshots && result.screenshots.length > 0
                            ? `
                            <div class="screenshots">
                                ${result.screenshots
                                  .map(
                                    (screenshot, i) => `
                                    <div class="screenshot">
                                        <img src="${screenshot}" alt="Screenshot ${i + 1}">
                                        <div class="screenshot-label">Screenshot ${i + 1}</div>
                                    </div>
                                `,
                                  )
                                  .join("")}
                            </div>
                        `
                            : ""
                        }
                    </div>
                </div>
            `,
              )
              .join("")}
        </div>

        ${
          params.metadata
            ? `
            <div class="content">
                <div class="metadata">
                    <h3>Test Metadata</h3>
                    <dl>
                        ${Object.entries(params.metadata)
                          .map(
                            ([key, value]) => `
                            <dt>${key}:</dt>
                            <dd>${String(value)}</dd>
                        `,
                          )
                          .join("")}
                    </dl>
                </div>
            </div>
        `
            : ""
        }

        <div class="footer">
            <p>Generated by OpenCode QA Agent • ${new Date(timestamp).toLocaleString()}</p>
        </div>
    </div>
</body>
</html>`

    // Write report
    await fs.writeFile(filepath, html, "utf-8")

    // Calculate file size
    const stats = await fs.stat(filepath)
    const fileSizeKB = (stats.size / 1024).toFixed(2)

    const output = `✅ QA Report Generated Successfully

Report: ${filename}
Location: ${filepath}
File Size: ${fileSizeKB} KB

Summary:
- Total Tests: ${totalTests}
- Passed: ${passed} (${passRate}%)
- Failed: ${failed}
- Skipped: ${skipped}
- Total Duration: ${(totalDuration / 1000).toFixed(1)}s

Open in browser:
  file://${filepath}`

    return {
      output,
      title: "QA Report Generated",
      metadata: {
        filepath,
        filename,
        fileSize: stats.size,
        totalTests,
        passed,
        failed,
        skipped,
        passRate: parseFloat(passRate),
        totalDuration,
      },
    }
  },
})
