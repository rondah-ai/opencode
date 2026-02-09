#!/usr/bin/env node

/**
 * QA Agent - Unified Mode
 *
 * Accepts flows, anchor points, AND prompts all together
 * - Flows provide fallback selectors
 * - Anchor points provide common patterns
 * - Prompt guides AI execution
 *
 * Best of all worlds!
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

// Parse CLI arguments
const args = process.argv.slice(2);
const config = {
  // Target
  url: getArg('--url') || process.env.QA_URL || process.env.TEST_URL,

  // Test definition
  prompt: getArg('--prompt') || process.env.QA_PROMPT,
  flows: getArg('--flows') || process.env.QA_FLOWS,
  anchorPoints: getArg('--anchor-points') || process.env.QA_ANCHOR_POINTS,

  // Credentials
  email: getArg('--email') || process.env.TEST_EMAIL,
  password: getArg('--password') || process.env.TEST_PASSWORD,

  // Options
  outputDir: getArg('--output-dir') || './qa-results',
  headless: getArg('--headless') !== 'false',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: getArg('--model') || 'claude-sonnet-4-5-20250929',
  maxSteps: parseInt(getArg('--max-steps') || '50'),
  verbose: getArg('--verbose') === 'true',
};

console.log('🤖 QA Agent - Unified Mode');
console.log('═'.repeat(70));
console.log('Configuration:');
console.log(`  URL: ${config.url}`);
console.log(`  Prompt: ${config.prompt || '(none - will use flows)'}`);
console.log(`  Flows: ${config.flows || '(none)'}`);
console.log(`  Anchor Points: ${config.anchorPoints || '(none)'}`);
console.log(`  Model: ${config.model}`);
console.log('═'.repeat(70));

// Validate
if (!config.url) {
  console.error('❌ Error: URL required (--url or QA_URL)');
  process.exit(1);
}

if (!config.prompt && !config.flows) {
  console.error('❌ Error: Either --prompt or --flows required');
  process.exit(1);
}

if (!config.anthropicApiKey) {
  console.error('❌ Error: ANTHROPIC_API_KEY required');
  process.exit(1);
}

// Create output directories
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.join(config.outputDir, 'screenshots'), { recursive: true });

// Initialize
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Load optional context
let flowsData = null;
let anchorPointsData = null;

if (config.flows && fs.existsSync(config.flows)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(config.flows, 'utf8'));
    flowsData = loaded.flows || loaded;
    console.log('✓ Loaded flows');
  } catch (e) {
    console.warn('⚠️  Failed to load flows:', e.message);
  }
}

if (config.anchorPoints && fs.existsSync(config.anchorPoints)) {
  try {
    anchorPointsData = JSON.parse(fs.readFileSync(config.anchorPoints, 'utf8'));
    console.log('✓ Loaded anchor points');
  } catch (e) {
    console.warn('⚠️  Failed to load anchor points:', e.message);
  }
}

// Execution tracking
const execution = {
  startTime: Date.now(),
  steps: [],
  totalCost: 0,
};

async function main() {
  let browser, context, page;

  try {
    console.log('\n🌐 Launching browser...');
    browser = await chromium.launch({
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });

    page = await context.newPage();
    console.log('✅ Browser ready\n');

    // Navigate
    console.log(`📍 Navigating to ${config.url}...`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('✅ Page loaded\n');

    // Execute test
    await executeTest(page);

    console.log('\n✅ Test completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);

    if (page) {
      try {
        const errorPath = path.join(config.outputDir, 'screenshots', 'error.png');
        await page.screenshot({ path: errorPath, fullPage: true });
        console.log(`📸 Error screenshot: ${errorPath}`);
      } catch (e) {}
    }

    process.exit(1);

  } finally {
    if (browser) {
      await browser.close();
      console.log('\n🌐 Browser closed');
    }

    await generateReport();
    printSummary();
  }
}

async function executeTest(page) {
  console.log('═'.repeat(70));
  console.log('🎯 Test Goal:', config.prompt || 'Execute flows');
  console.log('═'.repeat(70));

  const conversationHistory = [];
  let stepNumber = 0;

  // Build initial context
  conversationHistory.push({
    role: 'user',
    content: buildInitialContext()
  });

  while (stepNumber < config.maxSteps) {
    stepNumber++;
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Step ${stepNumber}: Analyzing and deciding next action...`);
    console.log('─'.repeat(70));

    // Capture state
    const screenshot = await page.screenshot({ type: 'png' });
    const screenshotBase64 = screenshot.toString('base64');
    const screenshotPath = path.join(config.outputDir, 'screenshots', `step_${stepNumber}.png`);
    fs.writeFileSync(screenshotPath, screenshot);

    const pageContext = await getPageContext(page);

    // Ask AI
    conversationHistory.push({
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
          text: buildStepPrompt(pageContext, stepNumber)
        }
      ]
    });

    const startTime = Date.now();
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 4096,
      messages: conversationHistory
    });

    const aiMessage = response.content[0].text;
    conversationHistory.push({
      role: 'assistant',
      content: aiMessage
    });

    const cost = calculateCost(response.usage);
    execution.totalCost += cost;

    if (config.verbose) {
      console.log(`\n🤖 AI Response:\n${aiMessage}\n`);
    }

    // Parse action
    const action = parseAIResponse(aiMessage);

    if (!action) {
      console.error('❌ Could not parse AI response');
      throw new Error('Invalid AI response');
    }

    console.log(`📋 Action: ${action.type}`);
    console.log(`💭 Reasoning: ${action.reasoning}`);
    if (action.selector) console.log(`🎯 Target: ${action.selector}`);
    if (action.value) console.log(`💬 Value: ${action.value}`);

    // Record step
    execution.steps.push({
      number: stepNumber,
      action: action.type,
      reasoning: action.reasoning,
      selector: action.selector,
      value: action.value,
      url: page.url(),
      duration: Date.now() - startTime,
      cost: cost,
      screenshot: screenshotPath,
    });

    // Execute
    try {
      await executeAction(page, action);
      console.log('✅ Action executed successfully');

      if (action.type === 'complete') {
        console.log('\n🎉 Test objective achieved!');
        break;
      }

    } catch (error) {
      console.error(`❌ Action failed: ${error.message}`);

      conversationHistory.push({
        role: 'user',
        content: `Action failed: ${error.message}. Try a different approach.`
      });

      continue;
    }

    await page.waitForTimeout(1000);
  }
}

function buildInitialContext() {
  let context = `You are an expert QA automation engineer testing a web application.

**Test Objective:**
${config.prompt || 'Execute the test flows provided'}

**Application URL:**
${config.url}

${config.email ? `**Test Credentials:**\n- Email: ${config.email}\n- Password: [PROVIDED]\n` : ''}
`;

  // Add flows context if available
  if (flowsData) {
    context += `\n**Available Test Flows:**\n`;
    const flowNames = getAllFlowPaths(flowsData);
    flowNames.slice(0, 10).forEach(name => {
      context += `- ${name}\n`;
    });
    context += `\nYou can reference these flows for common selectors and patterns.\n`;
  }

  // Add anchor points if available
  if (anchorPointsData) {
    context += `\n**Common Patterns (Anchor Points):**\n`;
    if (anchorPointsData.commonPatterns) {
      Object.entries(anchorPointsData.commonPatterns).forEach(([category, patterns]) => {
        context += `\n${category}:\n`;
        Object.entries(patterns).forEach(([name, selector]) => {
          context += `  - ${name}: ${selector}\n`;
        });
      });
    }
  }

  context += `

**Your Task:**
1. Analyze screenshots of the current page
2. Decide the next action to achieve the test objective
3. Execute actions one at a time
4. Verify the objective is achieved

**Response Format:**
Return ONLY a JSON object:
{
  "type": "navigate|click|type|verify|wait|complete",
  "reasoning": "why you're taking this action",
  "selector": "playwright selector",
  "value": "text to type (if applicable)",
  "assertion": "what to verify (if applicable)"
}

**Action Types:**
- navigate: Go to a URL
- click: Click an element
- type: Type text into input
- verify: Check element exists/visible
- wait: Wait for element or time
- complete: Test objective achieved

**Selector Tips:**
${anchorPointsData ? '- Use anchor point patterns when applicable\n' : ''}
${flowsData ? '- Reference flow definitions for common selectors\n' : ''}
- "button:has-text('Login')"
- "input[type='email']"
- "a[href='/dashboard']"

Ready? Look at the screenshot and tell me the first action.`;

  return context;
}

function buildStepPrompt(pageContext, stepNumber) {
  return `**Current State:**
URL: ${pageContext.url}
Title: ${pageContext.title}

**Visible Elements:**
${pageContext.elements.slice(0, 30).join('\n')}

**Step ${stepNumber}:**
What's the next action to achieve the test objective?

Return ONLY the JSON object.`;
}

async function getPageContext(page) {
  return await page.evaluate(() => {
    const elements = [];
    const selectors = ['button', 'a', 'input', 'select', 'h1', 'h2', '[data-testid]'];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (el.offsetParent !== null) {
          const text = el.innerText?.trim() || el.value || '';
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const testId = el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : '';

          if ((text && text.length < 100) || id || testId) {
            elements.push(`${tag}${id}${testId}${text ? `: "${text}"` : ''}`);
          }
        }
      });
    });

    return {
      url: window.location.href,
      title: document.title,
      elements: elements.slice(0, 30)
    };
  });
}

function parseAIResponse(aiMessage) {
  try {
    let jsonText = aiMessage.trim();

    if (jsonText.includes('```')) {
      const match = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) jsonText = match[1];
    }

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];

    const action = JSON.parse(jsonText);

    if (!action.type || !action.reasoning) {
      throw new Error('Missing required fields');
    }

    // Replace credentials
    if (action.value) {
      action.value = action.value
        .replace(/{email}/g, config.email || '')
        .replace(/{password}/g, config.password || '');
    }

    return action;

  } catch (error) {
    console.error('Parse error:', error.message);
    console.error('Raw response:', aiMessage);
    return null;
  }
}

async function executeAction(page, action) {
  switch (action.type) {
    case 'navigate':
      let url = action.selector || action.url || action.value;
      if (url.startsWith('/')) url = config.url + url;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      break;

    case 'click':
      if (!action.selector) throw new Error('No selector for click');
      await page.click(action.selector, { timeout: 10000 });
      await page.waitForTimeout(1000);
      break;

    case 'type':
      if (!action.selector) throw new Error('No selector for type');
      if (!action.value) throw new Error('No value for type');
      await page.fill(action.selector, action.value, { timeout: 10000 });
      await page.waitForTimeout(500);
      break;

    case 'verify':
      if (!action.selector) throw new Error('No selector for verify');
      const element = await page.waitForSelector(action.selector, { timeout: 10000 });
      if (!element) throw new Error(`Element not found: ${action.selector}`);

      if (action.assertion) {
        const text = await element.textContent();
        if (!text.includes(action.assertion)) {
          throw new Error(`Assertion failed: "${action.assertion}" not in text`);
        }
      }
      break;

    case 'wait':
      const waitTime = parseInt(action.value) || 2000;
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: 30000 });
      } else {
        await page.waitForTimeout(waitTime);
      }
      break;

    case 'complete':
      break;

    default:
      console.warn(`Unknown action: ${action.type}`);
  }
}

function getAllFlowPaths(flows, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(flows)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value.steps) {
      paths.push(path);
    } else if (typeof value === 'object') {
      paths.push(...getAllFlowPaths(value, path));
    }
  }
  return paths;
}

function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1000000) * 3.00;
  const outputCost = (usage.output_tokens / 1000000) * 15.00;
  return inputCost + outputCost;
}

async function generateReport() {
  const report = {
    prompt: config.prompt,
    url: config.url,
    flows: config.flows,
    anchorPoints: config.anchorPoints,
    model: config.model,
    timestamp: new Date().toISOString(),
    duration: Date.now() - execution.startTime,
    totalSteps: execution.steps.length,
    totalCost: execution.totalCost,
    steps: execution.steps,
  };

  fs.writeFileSync(
    path.join(config.outputDir, 'report.json'),
    JSON.stringify(report, null, 2)
  );

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>QA Test Report - Unified Mode</title>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; }
    h1 { color: #1a202c; }
    .meta { color: #718096; margin-bottom: 32px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
    .stat h3 { margin: 0 0 8px 0; font-size: 13px; opacity: 0.9; }
    .stat .value { font-size: 32px; font-weight: 700; }
    .step { background: #f8f9fa; padding: 20px; margin-bottom: 16px; border-radius: 8px; border-left: 4px solid #667eea; }
    .step-header { display: flex; justify-content: space-between; margin-bottom: 12px; }
    .step-action { background: #e0e7ff; color: #3730a3; padding: 4px 12px; border-radius: 6px; font-weight: 600; }
    .reasoning { color: #4a5568; margin-bottom: 8px; }
    .details { font-size: 14px; color: #718096; }
    .screenshot img { max-width: 400px; margin-top: 12px; border-radius: 8px; border: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 QA Test Report - Unified Mode</h1>
    <div class="meta">
      <div><strong>Prompt:</strong> ${report.prompt || '(using flows)'}</div>
      <div><strong>URL:</strong> ${report.url}</div>
      ${report.flows ? `<div><strong>Flows:</strong> ${report.flows}</div>` : ''}
      ${report.anchorPoints ? `<div><strong>Anchor Points:</strong> ${report.anchorPoints}</div>` : ''}
      <div><strong>Model:</strong> ${report.model}</div>
      <div><strong>Timestamp:</strong> ${report.timestamp}</div>
    </div>

    <div class="stats">
      <div class="stat">
        <h3>Total Steps</h3>
        <div class="value">${report.totalSteps}</div>
      </div>
      <div class="stat">
        <h3>Duration</h3>
        <div class="value">${(report.duration / 1000).toFixed(1)}s</div>
      </div>
      <div class="stat">
        <h3>Total Cost</h3>
        <div class="value">$${report.totalCost.toFixed(3)}</div>
      </div>
    </div>

    <h2>Test Steps</h2>
    ${report.steps.map(step => `
      <div class="step">
        <div class="step-header">
          <span><strong>Step ${step.number}</strong></span>
          <span class="step-action">${step.action}</span>
        </div>
        <div class="reasoning"><strong>Reasoning:</strong> ${step.reasoning}</div>
        <div class="details">
          ${step.selector ? `<div><strong>Target:</strong> <code>${step.selector}</code></div>` : ''}
          ${step.value ? `<div><strong>Value:</strong> ${step.value}</div>` : ''}
          <div><strong>Duration:</strong> ${(step.duration / 1000).toFixed(2)}s | <strong>Cost:</strong> $${step.cost.toFixed(4)}</div>
        </div>
        <div class="screenshot">
          <a href="${path.relative(config.outputDir, step.screenshot)}" target="_blank">
            <img src="${path.relative(config.outputDir, step.screenshot)}" alt="Step ${step.number}">
          </a>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(config.outputDir, 'report.html'), html);

  console.log(`\n📄 Reports generated:`);
  console.log(`  - ${path.join(config.outputDir, 'report.html')}`);
  console.log(`  - ${path.join(config.outputDir, 'report.json')}`);
}

function printSummary() {
  console.log('\n' + '═'.repeat(70));
  console.log('📊 TEST SUMMARY - UNIFIED MODE');
  console.log('═'.repeat(70));
  console.log(`Test: ${config.prompt || 'Flow-based'}`);
  console.log(`Steps: ${execution.steps.length}`);
  console.log(`Duration: ${((Date.now() - execution.startTime) / 1000).toFixed(2)}s`);
  console.log(`Cost: $${execution.totalCost.toFixed(4)}`);
  console.log(`Context: ${config.flows ? 'Flows ✓' : ''} ${config.anchorPoints ? 'Anchors ✓' : ''}`);
  console.log('═'.repeat(70));
  console.log('✅ TEST COMPLETED');
  console.log('═'.repeat(70));
}

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
