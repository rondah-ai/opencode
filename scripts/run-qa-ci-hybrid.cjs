#!/usr/bin/env node

/**
 * QA Agent CI Runner - Hybrid Mode
 *
 * Runs tests using hybrid execution strategy:
 * 1. Deterministic (flow definitions)
 * 2. Learned Solutions (knowledge base)
 * 3. AI Fallback (Claude Haiku)
 *
 * Optimized for CI/CD with:
 * - Environment variable support
 * - Prompt-based testing
 * - Cost tracking
 * - Artifact generation
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

// Parse CLI arguments
const args = process.argv.slice(2);
const config = {
  // Test target
  url: getArg('--url') || process.env.QA_PREVIEW_URL || process.env.TEST_URL,

  // Test configuration
  prompt: getArg('--prompt') || process.env.QA_PROMPT,
  flows: getArg('--flows') || process.env.QA_FLOWS,
  anchorPoints: getArg('--anchor-points') || process.env.QA_ANCHOR_POINTS,
  suite: getArg('--suite') || process.env.QA_SUITE || 'smoke',

  // Authentication
  email: getArg('--email') || process.env.TEST_EMAIL,
  password: getArg('--password') || process.env.TEST_PASSWORD,

  // Mode and output
  mode: getArg('--mode') || process.env.QA_MODE || 'hybrid',
  outputDir: getArg('--output-dir') || process.env.QA_OUTPUT_DIR || './qa-results',
  headless: getArg('--headless') !== 'false',

  // AI configuration
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiModel: process.env.AI_MODEL || 'claude-3-haiku-20240307',

  // Knowledge base
  knowledgeDir: getArg('--knowledge-dir') || process.env.QA_KNOWLEDGE_DIR || './.opencode/qa-knowledge',
};

console.log('🤖 QA Agent CI Runner - Hybrid Mode');
console.log('='.repeat(60));
console.log('Configuration:');
console.log(`  URL: ${config.url}`);
console.log(`  Mode: ${config.mode}`);
console.log(`  Suite: ${config.suite}`);
console.log(`  Prompt: ${config.prompt ? 'Yes' : 'No'}`);
console.log(`  Flows: ${config.flows || 'None'}`);
console.log(`  Anchor Points: ${config.anchorPoints || 'None'}`);
console.log(`  AI Model: ${config.aiModel}`);
console.log(`  Knowledge Dir: ${config.knowledgeDir}`);
console.log('='.repeat(60));

// Validate required configuration
if (!config.url) {
  console.error('❌ Error: URL is required. Use --url or set QA_PREVIEW_URL env variable');
  process.exit(1);
}

if (!config.prompt && !config.flows) {
  console.error('❌ Error: Either --prompt or --flows is required');
  process.exit(1);
}

if (config.mode === 'hybrid' && !config.anthropicApiKey) {
  console.error('❌ Error: ANTHROPIC_API_KEY environment variable is required for hybrid mode');
  process.exit(1);
}

// Create output directories
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.join(config.outputDir, 'screenshots'), { recursive: true });
fs.mkdirSync(config.knowledgeDir, { recursive: true });

// Initialize Anthropic client
const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

// Track execution stats
const stats = {
  totalSteps: 0,
  deterministicSuccess: 0,
  learnedSuccess: 0,
  aiSuccess: 0,
  failures: 0,
  aiCost: 0,
  duration: 0,
};

async function main() {
  const startTime = Date.now();
  let browser, context, page;

  try {
    console.log('\n🌐 Launching browser...');
    browser = await chromium.launch({
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // CI-friendly
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });

    page = await context.newPage();
    console.log('✅ Browser ready\n');

    // Execute tests based on mode
    if (config.prompt) {
      console.log('📝 Running prompt-based test...');
      await executePromptTest(page);
    } else {
      console.log('📋 Running flow-based tests...');
      await executeFlowTests(page);
    }

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    stats.failures++;
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log('\n🌐 Browser closed');
    }

    // Calculate duration
    stats.duration = Date.now() - startTime;

    // Generate reports
    await generateReports();

    // Print summary
    printSummary();

    // Exit with appropriate code
    process.exit(stats.failures > 0 ? 1 : 0);
  }
}

async function executePromptTest(page) {
  console.log(`\n🎯 Prompt: "${config.prompt}"\n`);

  // Generate test steps from prompt using AI
  const steps = await generateStepsFromPrompt(config.prompt);

  console.log(`📝 Generated ${steps.length} steps from prompt\n`);

  // Execute each step with hybrid strategy
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    stats.totalSteps++;

    console.log(`\n[${i + 1}/${steps.length}] ${step.action.toUpperCase()}: ${step.description || ''}`);

    try {
      // Try deterministic execution first
      const success = await executeDeterministicStep(page, step);

      if (success) {
        stats.deterministicSuccess++;
        console.log('  ✅ Deterministic success');
      } else {
        // Try learned solutions
        const learnedSuccess = await tryLearnedSolution(page, step);

        if (learnedSuccess) {
          stats.learnedSuccess++;
          console.log('  ✅ Learned solution success');
        } else {
          // Fall back to AI
          const aiSuccess = await tryAiFallback(page, step);

          if (aiSuccess) {
            stats.aiSuccess++;
            console.log('  ✅ AI fallback success');
          } else {
            throw new Error('All strategies failed');
          }
        }
      }
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
      stats.failures++;

      // Take error screenshot
      const screenshotPath = path.join(config.outputDir, 'screenshots', `error_step${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`  📸 Error screenshot: ${screenshotPath}`);

      throw error; // Stop on first error in CI
    }
  }

  console.log('\n✅ All steps completed successfully!');
}

async function executeFlowTests(page) {
  // Load flows and anchor points
  const flows = config.flows ? JSON.parse(fs.readFileSync(config.flows, 'utf8')) : {};
  const anchorPoints = config.anchorPoints ? JSON.parse(fs.readFileSync(config.anchorPoints, 'utf8')) : {};

  // Get flows for the suite
  const flowsData = flows.flows || flows;
  const suiteFlows = getSuiteFlows(config.suite, flows.suites);

  console.log(`\n📋 Running ${suiteFlows.length} flows from '${config.suite}' suite\n`);

  for (const flowPath of suiteFlows) {
    console.log(`\n▶️  Executing flow: ${flowPath}`);
    const flow = getFlowByPath(flowPath, flowsData);

    if (!flow || !flow.steps) {
      console.error(`  ❌ Flow not found or invalid: ${flowPath}`);
      stats.failures++;
      continue;
    }

    // Execute flow steps
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      stats.totalSteps++;

      console.log(`  [${i + 1}/${flow.steps.length}] ${step.action}: ${step.description || ''}`);

      try {
        // Replace placeholders
        const processedStep = replaceStepParams(step, {
          email: config.email,
          password: config.password,
          baseUrl: config.url,
        });

        // Execute with hybrid strategy
        const success = await executeDeterministicStep(page, processedStep);

        if (success) {
          stats.deterministicSuccess++;
        } else {
          // Try learned or AI
          const learnedSuccess = await tryLearnedSolution(page, processedStep);
          if (learnedSuccess) {
            stats.learnedSuccess++;
          } else {
            const aiSuccess = await tryAiFallback(page, processedStep);
            if (aiSuccess) {
              stats.aiSuccess++;
            } else {
              throw new Error('All strategies failed');
            }
          }
        }
      } catch (error) {
        console.error(`    ❌ Failed: ${error.message}`);
        stats.failures++;
        throw error; // Stop on error
      }
    }

    console.log(`  ✅ Flow completed: ${flowPath}`);
  }
}

async function generateStepsFromPrompt(prompt) {
  console.log('🤖 Generating test steps from prompt...');

  // Load anchor points if available
  let anchorContext = '';
  if (config.anchorPoints && fs.existsSync(config.anchorPoints)) {
    const anchors = JSON.parse(fs.readFileSync(config.anchorPoints, 'utf8'));
    anchorContext = `\n\nAvailable anchor patterns:\n${JSON.stringify(anchors.commonPatterns, null, 2)}`;
  }

  const response = await anthropic.messages.create({
    model: config.aiModel,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a QA automation expert. Convert this test description into executable steps.

Test URL: ${config.url}
${config.email ? `Test Email: ${config.email}` : ''}
${config.password ? `Test Password: [REDACTED]` : ''}
${anchorContext}

Test Description: ${prompt}

Generate a JSON array of test steps. Each step should have:
- action: "navigate" | "click" | "type" | "verify" | "wait" | "screenshot"
- target: selector or URL
- value: (optional) text to type
- description: human-readable description

Return ONLY valid JSON array, no markdown or explanation.

Example:
[
  {"action": "navigate", "target": "${config.url}", "description": "Navigate to app"},
  {"action": "click", "target": "input[type='email']", "description": "Focus email input"},
  {"action": "type", "target": "input[type='email']", "value": "${config.email}", "description": "Enter email"}
]`
    }]
  });

  const content = response.content[0].text;

  // Extract JSON from response (handle markdown code blocks)
  let jsonText = content;
  if (content.includes('```')) {
    const match = content.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (match) {
      jsonText = match[1];
    }
  }

  const steps = JSON.parse(jsonText);

  // Track AI cost
  stats.aiCost += (response.usage.input_tokens * 0.00025 / 1000) + (response.usage.output_tokens * 0.00125 / 1000);

  return steps;
}

async function executeDeterministicStep(page, step) {
  try {
    const selector = step.target || step.selector;
    const value = step.value;

    switch (step.action) {
      case 'navigate':
        let url = step.target;
        if (url.startsWith('/')) url = config.url + url;
        else if (!url.startsWith('http')) url = config.url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(step.wait || 2000);
        return true;

      case 'click':
        const clickable = await page.locator(selector).first();
        await clickable.click({ timeout: 10000 });
        await page.waitForTimeout(500);
        return true;

      case 'type':
      case 'fill':
        await page.fill(selector, value, { timeout: 10000 });
        await page.waitForTimeout(300);
        return true;

      case 'clear':
        await page.fill(selector, '', { timeout: 10000 });
        return true;

      case 'verify':
        if (step.exists === false) {
          const count = await page.locator(selector).count();
          if (count > 0) throw new Error('Element should not exist');
        } else {
          const element = await page.waitForSelector(selector, { timeout: 10000 });
          if (!element) throw new Error('Element not found');
        }
        return true;

      case 'wait':
        const waitTime = step.duration || step.value;
        if (waitTime) {
          await page.waitForTimeout(parseInt(waitTime));
        } else if (selector) {
          await page.waitForSelector(selector, { timeout: 30000 });
        }
        return true;

      case 'screenshot':
        const filename = step.filename || `step_${Date.now()}.png`;
        const screenshotPath = path.join(config.outputDir, 'screenshots', filename);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`    📸 Screenshot: ${screenshotPath}`);
        return true;

      default:
        console.log(`    ⚠️  Unknown action: ${step.action}`);
        return false;
    }
  } catch (error) {
    // Deterministic execution failed, return false to try other strategies
    return false;
  }
}

async function tryLearnedSolution(page, step) {
  // Check knowledge base for learned solutions
  const solutionsPath = path.join(config.knowledgeDir, 'solutions.json');

  if (!fs.existsSync(solutionsPath)) {
    return false;
  }

  try {
    const knowledge = JSON.parse(fs.readFileSync(solutionsPath, 'utf8'));
    const solution = knowledge.solutions.find(s =>
      s.stepAction === step.action &&
      s.confidence > 0.7
    );

    if (solution) {
      console.log(`    🧠 Trying learned solution: ${solution.learnedSelector}`);

      // Try the learned selector
      const modifiedStep = { ...step, target: solution.learnedSelector };
      const success = await executeDeterministicStep(page, modifiedStep);

      if (success) {
        // Update success count
        solution.successCount++;
        solution.confidence = Math.min(0.99, solution.confidence + 0.05);
        solution.lastUsed = new Date().toISOString();
        fs.writeFileSync(solutionsPath, JSON.stringify(knowledge, null, 2));
        return true;
      }
    }
  } catch (error) {
    // Ignore knowledge base errors
  }

  return false;
}

async function tryAiFallback(page, step) {
  if (!anthropic) {
    return false;
  }

  console.log('    🤖 Using AI fallback...');

  try {
    // Take screenshot for AI analysis
    const screenshot = await page.screenshot({ type: 'png' });
    const screenshotBase64 = screenshot.toString('base64');

    // Get page HTML structure
    const htmlStructure = await page.evaluate(() => {
      function getStructure(el, depth = 0) {
        if (depth > 3) return '';
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const rawClass = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
        const classes = rawClass ? `.${rawClass.split(' ').join('.')}` : '';
        const text = el.innerText ? el.innerText.substring(0, 50) : '';
        let result = `${'  '.repeat(depth)}${tag}${id}${classes}${text ? ` "${text}"` : ''}\n`;
        for (const child of el.children) {
          result += getStructure(child, depth + 1);
        }
        return result;
      }
      return getStructure(document.body);
    });

    const response = await anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshotBase64,
            }
          },
          {
            type: 'text',
            text: `Find the best selector for this action.

Action: ${step.action}
Original selector: ${step.target || step.selector}
Description: ${step.description || ''}

HTML Structure:
${htmlStructure.substring(0, 2000)}

Return ONLY a valid Playwright selector, nothing else.
Examples: "button:has-text('Login')", "input[type='email']", "[data-testid='submit']"`
          }
        ]
      }]
    });

    const aiSelector = response.content[0].text.trim();
    console.log(`    🎯 AI suggested: ${aiSelector}`);

    // Track AI cost
    stats.aiCost += (response.usage.input_tokens * 0.00025 / 1000) + (response.usage.output_tokens * 0.00125 / 1000);

    // Try AI selector
    const modifiedStep = { ...step, target: aiSelector };
    const success = await executeDeterministicStep(page, modifiedStep);

    if (success) {
      // Save to knowledge base
      saveLearnedSolution(step, aiSelector);
      return true;
    }
  } catch (error) {
    console.error(`    ⚠️  AI fallback error: ${error.message}`);
  }

  return false;
}

function saveLearnedSolution(step, learnedSelector) {
  const solutionsPath = path.join(config.knowledgeDir, 'solutions.json');

  let knowledge = { version: '1.0', solutions: [] };
  if (fs.existsSync(solutionsPath)) {
    knowledge = JSON.parse(fs.readFileSync(solutionsPath, 'utf8'));
  }

  knowledge.solutions.push({
    id: `${step.action}-${Date.now()}`,
    stepAction: step.action,
    originalSelector: step.target || step.selector,
    learnedSelector: learnedSelector,
    confidence: 0.7,
    successCount: 1,
    failureCount: 0,
    learnedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  });

  knowledge.lastUpdated = new Date().toISOString();
  fs.writeFileSync(solutionsPath, JSON.stringify(knowledge, null, 2));

  console.log(`    💾 Saved learned solution`);
}

function replaceStepParams(step, params) {
  const replaced = { ...step };

  ['target', 'selector', 'value', 'description'].forEach(field => {
    if (replaced[field]) {
      replaced[field] = replaced[field]
        .replace(/\{email\}/g, params.email || '')
        .replace(/\{password\}/g, params.password || '')
        .replace(/\{baseUrl\}/g, params.baseUrl || '');
    }
  });

  return replaced;
}

function getSuiteFlows(suiteName, suites) {
  if (!suites || !suites[suiteName]) {
    return [];
  }
  return suites[suiteName];
}

function getFlowByPath(flowPath, flowsData) {
  const parts = flowPath.split('.');
  let current = flowsData;

  for (const part of parts) {
    if (!current[part]) return null;
    current = current[part];
  }

  return current;
}

async function generateReports() {
  const summary = {
    url: config.url,
    mode: config.mode,
    suite: config.suite,
    prompt: config.prompt,
    timestamp: new Date().toISOString(),
    stats: {
      ...stats,
      deterministicRate: ((stats.deterministicSuccess / stats.totalSteps) * 100).toFixed(1),
      learnedRate: ((stats.learnedSuccess / stats.totalSteps) * 100).toFixed(1),
      aiRate: ((stats.aiSuccess / stats.totalSteps) * 100).toFixed(1),
      successRate: (((stats.totalSteps - stats.failures) / stats.totalSteps) * 100).toFixed(1),
    }
  };

  // Save summary JSON
  fs.writeFileSync(
    path.join(config.outputDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  // Generate HTML report
  const html = generateHtmlReport(summary);
  fs.writeFileSync(
    path.join(config.outputDir, 'report.html'),
    html
  );

  console.log(`\n📄 Reports generated:`);
  console.log(`  - ${path.join(config.outputDir, 'summary.json')}`);
  console.log(`  - ${path.join(config.outputDir, 'report.html')}`);
}

function generateHtmlReport(summary) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>QA Test Report - Hybrid Mode</title>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1000px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; }
    h1 { color: #1a202c; margin: 0 0 8px 0; }
    .meta { color: #718096; margin-bottom: 32px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
    .stat.success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
    .stat.failure { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
    .stat h3 { margin: 0 0 8px 0; font-size: 13px; opacity: 0.9; }
    .stat .value { font-size: 32px; font-weight: 700; }
    .breakdown { background: #f7fafc; padding: 24px; border-radius: 8px; }
    .breakdown h2 { margin: 0 0 16px 0; color: #2d3748; }
    .bar { background: #e2e8f0; height: 32px; border-radius: 6px; overflow: hidden; display: flex; }
    .bar-segment { display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600; }
    .deterministic { background: #10b981; }
    .learned { background: #3b82f6; }
    .ai { background: #8b5cf6; }
    .failed { background: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 QA Test Report - Hybrid Mode</h1>
    <div class="meta">
      <div>URL: ${summary.url}</div>
      <div>Mode: ${summary.mode} | Suite: ${summary.suite}</div>
      <div>Timestamp: ${summary.timestamp}</div>
      ${summary.prompt ? `<div>Prompt: "${summary.prompt}"</div>` : ''}
    </div>

    <div class="stats">
      <div class="stat">
        <h3>Total Steps</h3>
        <div class="value">${stats.totalSteps}</div>
      </div>
      <div class="stat success">
        <h3>Success Rate</h3>
        <div class="value">${summary.stats.successRate}%</div>
      </div>
      <div class="stat ${stats.failures > 0 ? 'failure' : ''}">
        <h3>Failures</h3>
        <div class="value">${stats.failures}</div>
      </div>
      <div class="stat">
        <h3>AI Cost</h3>
        <div class="value">$${stats.aiCost.toFixed(3)}</div>
      </div>
      <div class="stat">
        <h3>Duration</h3>
        <div class="value">${(stats.duration / 1000).toFixed(1)}s</div>
      </div>
    </div>

    <div class="breakdown">
      <h2>Execution Strategy Breakdown</h2>
      <div class="bar">
        ${stats.deterministicSuccess > 0 ? `<div class="bar-segment deterministic" style="width: ${summary.stats.deterministicRate}%">Deterministic ${summary.stats.deterministicRate}%</div>` : ''}
        ${stats.learnedSuccess > 0 ? `<div class="bar-segment learned" style="width: ${summary.stats.learnedRate}%">Learned ${summary.stats.learnedRate}%</div>` : ''}
        ${stats.aiSuccess > 0 ? `<div class="bar-segment ai" style="width: ${summary.stats.aiRate}%">AI ${summary.stats.aiRate}%</div>` : ''}
        ${stats.failures > 0 ? `<div class="bar-segment failed" style="width: ${((stats.failures / stats.totalSteps) * 100).toFixed(1)}%">Failed ${((stats.failures / stats.totalSteps) * 100).toFixed(1)}%</div>` : ''}
      </div>
      <div style="margin-top: 16px; font-size: 14px; color: #4a5568;">
        <div>✅ Deterministic: ${stats.deterministicSuccess} steps (${summary.stats.deterministicRate}%)</div>
        <div>🧠 Learned Solutions: ${stats.learnedSuccess} steps (${summary.stats.learnedRate}%)</div>
        <div>🤖 AI Fallback: ${stats.aiSuccess} steps (${summary.stats.aiRate}%)</div>
        <div>❌ Failed: ${stats.failures} steps</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY - HYBRID MODE');
  console.log('='.repeat(60));
  console.log(`Total Steps: ${stats.totalSteps}`);
  console.log(`✅ Deterministic Success: ${stats.deterministicSuccess} (${((stats.deterministicSuccess / stats.totalSteps) * 100).toFixed(1)}%)`);
  console.log(`🧠 Learned Success: ${stats.learnedSuccess} (${((stats.learnedSuccess / stats.totalSteps) * 100).toFixed(1)}%)`);
  console.log(`🤖 AI Success: ${stats.aiSuccess} (${((stats.aiSuccess / stats.totalSteps) * 100).toFixed(1)}%)`);
  console.log(`❌ Failures: ${stats.failures}`);
  console.log(`💰 AI Cost: $${stats.aiCost.toFixed(4)}`);
  console.log(`⏱️  Duration: ${(stats.duration / 1000).toFixed(2)}s`);
  console.log('='.repeat(60));

  if (stats.failures === 0) {
    console.log('✅ ALL TESTS PASSED!');
  } else {
    console.log('❌ TESTS FAILED');
  }
  console.log('='.repeat(60));
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
