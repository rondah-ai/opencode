#!/usr/bin/env node

/**
 * QA Agent CI Runner - Standalone Version
 *
 * Runs automated QA tests using Playwright directly
 * No dependency on opencode binary - fully self-contained
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Parse command line arguments
const args = process.argv.slice(2);
const config = {
  url: getArg('--url') || process.env.QA_PREVIEW_URL,
  anchorPoints: getArg('--anchor-points') || process.env.QA_ANCHOR_POINTS || './QA_ANCHOR_POINTS.json',
  flows: getArg('--flows') || process.env.QA_FLOWS || './QA_FLOWS.json',
  outputDir: getArg('--output-dir') || './qa-results',
  suite: getArg('--suite') || 'smoke',
  email: getArg('--email') || process.env.TEST_EMAIL,
  password: getArg('--password') || process.env.TEST_PASSWORD,
  headless: getArg('--headless') !== 'false',
};

console.log('🤖 QA Agent CI Runner (Standalone)');
console.log('='.repeat(50));
console.log('Configuration:');
console.log(JSON.stringify(config, null, 2));
console.log('='.repeat(50));

// Validate required config
if (!config.url) {
  console.error('❌ Error: URL is required. Use --url or set QA_PREVIEW_URL env variable');
  process.exit(1);
}

// Validate files exist
if (!fs.existsSync(config.anchorPoints)) {
  console.error(`❌ Error: Anchor points file not found: ${config.anchorPoints}`);
  process.exit(1);
}

if (!fs.existsSync(config.flows)) {
  console.error(`❌ Error: Flows file not found: ${config.flows}`);
  process.exit(1);
}

// Create output directory
fs.mkdirSync(config.outputDir, { recursive: true });
const screenshotDir = path.join(config.outputDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

// Test suite definitions
const testSuites = {
  smoke: [
    'authentication.login',
    'callLogs.viewCallList',
    'appointmentTypes.viewAppointmentTypes',
    'dashboard.viewDashboard',
  ],
  regression: [
    'complete.endToEndCallLogsJourney',
    'complete.endToEndAppointmentTypeManagement',
    'complete.endToEndDashboardAnalysis',
  ],
  critical: [
    'authentication.login',
    'callLogs.viewCallDetails',
    'callLogs.updateCallStatus',
    'appointmentTypes.addAppointmentType',
  ],
};

// Load anchor points and flows
let anchorPoints, flowsData;
try {
  anchorPoints = JSON.parse(fs.readFileSync(config.anchorPoints, 'utf8'));
  const loadedFlows = JSON.parse(fs.readFileSync(config.flows, 'utf8'));

  // Handle flows with wrapper object (e.g., { "flows": { ... } })
  flowsData = loadedFlows.flows || loadedFlows;

  console.log('✓ Loaded anchor points and flows');
} catch (error) {
  console.error('❌ Error loading JSON files:', error.message);
  process.exit(1);
}

async function main() {
  const startTime = Date.now();
  const results = {
    suite: config.suite,
    url: config.url,
    startTime: new Date().toISOString(),
    flows: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
    },
  };

  let browser, context, page;

  try {
    // Get test flows
    const flowPaths = testSuites[config.suite] || [];
    if (flowPaths.length === 0) {
      throw new Error(`Unknown test suite: ${config.suite}`);
    }

    console.log(`\n📋 Running ${flowPaths.length} flows from '${config.suite}' suite\n`);

    // Launch browser
    console.log('🌐 Launching browser...');
    browser = await chromium.launch({ headless: config.headless });
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    console.log('✓ Browser ready\n');

    // Execute each flow
    for (const flowPath of flowPaths) {
      const flowResult = await executeFlow(flowPath, page, config);
      results.flows.push(flowResult);
      results.summary.total++;

      if (flowResult.status === 'passed') {
        results.summary.passed++;
      } else if (flowResult.status === 'failed') {
        results.summary.failed++;
      } else {
        results.summary.skipped++;
      }
    }

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    results.error = error.message;
  } finally {
    // Cleanup browser
    if (browser) {
      await browser.close();
      console.log('\n🌐 Browser closed');
    }

    // Calculate total duration
    results.summary.duration = Date.now() - startTime;
    results.endTime = new Date().toISOString();

    // Save results
    const summaryPath = path.join(config.outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

    // Generate HTML report
    await generateHtmlReport(results, config.outputDir);

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 Test Summary');
    console.log('='.repeat(50));
    console.log(`Total: ${results.summary.total}`);
    console.log(`✅ Passed: ${results.summary.passed}`);
    console.log(`❌ Failed: ${results.summary.failed}`);
    console.log(`⏭️  Skipped: ${results.summary.skipped}`);
    console.log(`⏱️  Duration: ${(results.summary.duration / 1000).toFixed(2)}s`);
    console.log('='.repeat(50));

    // Exit with appropriate code
    process.exit(results.summary.failed > 0 ? 1 : 0);
  }
}

async function executeFlow(flowPath, page, config) {
  console.log(`\n▶️  Executing: ${flowPath}`);
  const startTime = Date.now();

  const result = {
    flowPath,
    status: 'pending',
    duration: 0,
    error: null,
    screenshots: [],
  };

  try {
    // Find flow definition
    const flow = getFlowByPath(flowPath, flowsData);
    if (!flow) {
      throw new Error(`Flow not found: ${flowPath}`);
    }

    console.log(`   ${flow.name || flowPath}`);

    // Execute flow steps
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      await executeStep(step, page, i + 1, flowPath, result.screenshots, config);
    }

    result.status = 'passed';
    result.duration = Date.now() - startTime;
    console.log(`✅ Passed (${(result.duration / 1000).toFixed(2)}s)`);

  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    result.duration = Date.now() - startTime;
    console.error(`❌ Failed: ${error.message}`);

    // Take error screenshot
    try {
      const errorScreenshot = path.join(screenshotDir, `${flowPath.replace(/\./g, '_')}_error.png`);
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      result.screenshots.push(errorScreenshot);
    } catch (e) {
      // Ignore screenshot errors
    }
  }

  return result;
}

async function executeStep(step, page, stepNumber, flowPath, screenshots, config) {
  console.log(`   ${stepNumber}. ${step.action}: ${step.description || ''}`);

  // Replace parameters (support both ${param} and {param} syntax)
  const params = {
    email: config.email,
    password: config.password,
    baseUrl: config.url,
  };

  // Support both 'selector' and 'target' field names
  let selector = replaceParams(step.selector || step.target || '', params);
  selector = convertSelector(selector); // Convert jQuery-style selectors to Playwright
  let value = replaceParams(step.value || '', params);
  let url = step.url || step.target || '';

  switch (step.action) {
    case 'navigate':
      // If URL is relative (starts with /), prepend base URL
      let fullUrl = url;
      if (url && url.startsWith('/')) {
        fullUrl = config.url + url;
      } else if (!url) {
        fullUrl = config.url;
      }
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(step.wait || 1000);
      break;

    case 'click':
      await page.click(selector, { timeout: 10000 });
      await page.waitForTimeout(500);
      break;

    case 'type':
    case 'fill':
      await page.fill(selector, value, { timeout: 10000 });
      await page.waitForTimeout(300);
      break;

    case 'clear':
      await page.fill(selector, '', { timeout: 10000 });
      break;

    case 'wait':
      if (selector) {
        await page.waitForSelector(selector, { timeout: 10000 });
      } else {
        await page.waitForTimeout(parseInt(value) || 1000);
      }
      break;

    case 'screenshot':
      const screenshotName = `${flowPath.replace(/\./g, '_')}_step${stepNumber}.png`;
      const screenshotPath = path.join(screenshotDir, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      screenshots.push(screenshotPath);
      console.log(`      📸 Screenshot saved: ${screenshotPath}`);
      break;

    case 'verify':
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`Verification failed: element not found: ${selector}`);
      }
      if (step.verifyContains) {
        const text = await element.textContent();
        if (!text.includes(replaceParams(step.verifyContains, params))) {
          throw new Error(`Verification failed: text does not contain "${step.verifyContains}"`);
        }
      }
      break;

    case 'select':
      await page.selectOption(selector, value, { timeout: 10000 });
      break;

    case 'hover':
      await page.hover(selector, { timeout: 10000 });
      break;

    case 'press':
      await page.press(selector, value || 'Enter', { timeout: 10000 });
      break;

    default:
      console.log(`      ⚠️  Unknown action: ${step.action}`);
  }
}

function getFlowByPath(flowPath, flowsData) {
  const parts = flowPath.split('.');
  let current = flowsData.flows;

  for (const part of parts) {
    if (!current[part]) {
      return null;
    }
    current = current[part];
  }

  return current;
}

function replaceParams(str, params) {
  if (!str) return str;
  // Support both ${param} and {param} syntax
  str = str.replace(/\${(\w+)}/g, (match, key) => params[key] || match);
  str = str.replace(/\{(\w+)\}/g, (match, key) => params[key] || match);
  return str;
}

function convertSelector(selector) {
  if (!selector) return selector;

  // Convert jQuery-style :contains() to Playwright text selector
  // button:contains('Login') → button:has-text("Login")
  selector = selector.replace(/:contains\(['"]([^'"]+)['"]\)/g, ':has-text("$1")');

  // If it's just text in contains without element, use text= selector
  // :contains('text') → text=text
  if (selector.startsWith(':contains(')) {
    selector = selector.replace(/:contains\(['"]([^'"]+)['"]\)/, 'text=$1');
  }

  return selector;
}

async function generateHtmlReport(results, outputDir) {
  const reportPath = path.join(outputDir, 'report.html');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>QA Test Report - ${results.suite}</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { border-bottom: 3px solid #667eea; padding-bottom: 24px; margin-bottom: 32px; }
    .header h1 { margin: 0 0 12px 0; color: #1a202c; font-size: 32px; }
    .header p { margin: 4px 0; color: #4a5568; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 32px; }
    .card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 8px; }
    .card.passed { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
    .card.failed { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
    .card.total { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
    .card h3 { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px; }
    .card .value { font-size: 40px; font-weight: 700; margin: 0; }
    .flows-section h2 { margin: 0 0 20px 0; color: #1a202c; font-size: 24px; }
    .flow { background: #f8f9fa; padding: 20px; margin-bottom: 16px; border-radius: 8px; border-left: 4px solid #e2e8f0; transition: all 0.2s; }
    .flow:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); transform: translateY(-1px); }
    .flow.passed { border-left-color: #10b981; background: #f0fdf4; }
    .flow.failed { border-left-color: #ef4444; background: #fef2f2; }
    .flow-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .status { display: inline-block; padding: 6px 14px; border-radius: 16px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .status.passed { background: #d1fae5; color: #065f46; }
    .status.failed { background: #fee2e2; color: #991b1b; }
    .flow-path { font-weight: 600; color: #1a202c; font-size: 16px; margin-left: 10px; }
    .duration { color: #6b7280; font-size: 14px; font-weight: 500; }
    .error { margin-top: 12px; padding: 12px; background: #fef2f2; border-left: 3px solid #ef4444; color: #991b1b; font-size: 14px; border-radius: 4px; }
    .screenshots { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
    .screenshot-link { display: inline-block; padding: 6px 12px; background: #e0e7ff; color: #3730a3; border-radius: 6px; font-size: 13px; text-decoration: none; transition: all 0.2s; }
    .screenshot-link:hover { background: #c7d2fe; }
    .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 QA Test Report</h1>
      <p><strong>Suite:</strong> ${results.suite}</p>
      <p><strong>URL:</strong> ${results.url}</p>
      <p><strong>Started:</strong> ${new Date(results.startTime).toLocaleString()}</p>
      ${results.endTime ? `<p><strong>Ended:</strong> ${new Date(results.endTime).toLocaleString()}</p>` : ''}
    </div>

    <div class="summary">
      <div class="card total">
        <h3>Total Tests</h3>
        <div class="value">${results.summary.total}</div>
      </div>
      <div class="card passed">
        <h3>Passed</h3>
        <div class="value">${results.summary.passed}</div>
      </div>
      <div class="card failed">
        <h3>Failed</h3>
        <div class="value">${results.summary.failed}</div>
      </div>
      <div class="card">
        <h3>Duration</h3>
        <div class="value">${(results.summary.duration / 1000).toFixed(1)}s</div>
      </div>
    </div>

    <div class="flows-section">
      <h2>Flow Results</h2>
      ${results.flows.map(flow => `
        <div class="flow ${flow.status}">
          <div class="flow-header">
            <div>
              <span class="status ${flow.status}">${flow.status}</span>
              <span class="flow-path">${flow.flowPath}</span>
            </div>
            <div class="duration">${(flow.duration / 1000).toFixed(2)}s</div>
          </div>
          ${flow.error ? `<div class="error"><strong>Error:</strong> ${flow.error}</div>` : ''}
          ${flow.screenshots && flow.screenshots.length > 0 ? `
            <div class="screenshots">
              ${flow.screenshots.map((screenshot, i) => `
                <a href="${path.relative(outputDir, screenshot)}" class="screenshot-link" target="_blank">📸 Screenshot ${i + 1}</a>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>

    <div class="footer">
      <p>Generated by QA Agent (Standalone) • ${new Date().toLocaleString()}</p>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log(`\n📄 HTML report generated: ${reportPath}`);
}

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

// Run main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
