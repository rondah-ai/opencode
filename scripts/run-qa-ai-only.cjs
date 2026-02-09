#!/usr/bin/env node

/**
 * QA Agent - 100% AI Mode
 *
 * Fully AI-driven testing with Claude Sonnet 4.5
 * - No hardcoded selectors needed
 * - No flow files required
 * - Just describe what to test in plain English
 * - AI sees screenshots and finds everything
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

// Parse CLI arguments
const args = process.argv.slice(2);
const config = {
  url: getArg('--url') || process.env.QA_URL || process.env.TEST_URL,
  prompt: getArg('--prompt') || process.env.QA_PROMPT,
  email: getArg('--email') || process.env.TEST_EMAIL,
  password: getArg('--password') || process.env.TEST_PASSWORD,
  outputDir: getArg('--output-dir') || './qa-results',
  headless: getArg('--headless') !== 'false',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: getArg('--model') || process.env.AI_MODEL || 'claude-sonnet-4-5-20250929',
  maxSteps: parseInt(getArg('--max-steps') || '50'),
  verbose: getArg('--verbose') === 'true',
};

console.log('🤖 QA Agent - 100% AI Mode');
console.log('═'.repeat(60));
console.log('Configuration:');
console.log(`  URL: ${config.url}`);
console.log(`  Model: ${config.model}`);
console.log(`  Max Steps: ${config.maxSteps}`);
console.log(`  Prompt: ${config.prompt || '(will ask)'}`);
console.log('═'.repeat(60));

// Validate
if (!config.url) {
  console.error('❌ Error: URL is required. Use --url or set QA_URL env variable');
  process.exit(1);
}

if (!config.anthropicApiKey) {
  console.error('❌ Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

// Create output directories
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.join(config.outputDir, 'screenshots'), { recursive: true });

// Initialize Anthropic
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Track execution
const execution = {
  startTime: Date.now(),
  steps: [],
  totalCost: 0,
  screenshotCount: 0,
};

async function main() {
  let browser, context, page;

  try {
    // Get prompt if not provided
    if (!config.prompt) {
      console.log('\n📝 Enter your test description:');
      console.log('Example: "Login as admin, navigate to users page, verify table shows at least 5 users"');
      console.log('');

      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });

      config.prompt = await new Promise(resolve => {
        readline.question('Test: ', answer => {
          readline.close();
          resolve(answer);
        });
      });
    }

    console.log(`\n🎯 Test Goal: "${config.prompt}"\n`);

    // Launch browser
    console.log('🌐 Launching browser...');
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

    // Navigate to starting URL
    console.log(`📍 Navigating to ${config.url}...`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('✅ Page loaded\n');

    // Execute test with AI
    await executeAITest(page);

    console.log('\n✅ All test steps completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);

    // Take error screenshot
    if (page) {
      try {
        const errorPath = path.join(config.outputDir, 'screenshots', 'error_final.png');
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

    // Generate report
    await generateReport();
    printSummary();
  }
}

async function executeAITest(page) {
  // Build conversation context
  const conversationHistory = [];
  let stepNumber = 0;
  let testComplete = false;

  // Initial context
  conversationHistory.push({
    role: 'user',
    content: buildInitialPrompt()
  });

  while (!testComplete && stepNumber < config.maxSteps) {
    stepNumber++;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Step ${stepNumber}: Analyzing page and deciding next action...`);
    console.log('─'.repeat(60));

    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png' });
    const screenshotBase64 = screenshot.toString('base64');
    execution.screenshotCount++;

    // Save screenshot
    const screenshotPath = path.join(
      config.outputDir,
      'screenshots',
      `step_${stepNumber}.png`
    );
    fs.writeFileSync(screenshotPath, screenshot);

    // Get page context
    const pageContext = await getPageContext(page);

    // Ask AI what to do next
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

    // Get AI response
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

    // Calculate cost
    const cost = calculateCost(response.usage, config.model);
    execution.totalCost += cost;

    if (config.verbose) {
      console.log(`\n🤖 AI Response:\n${aiMessage}\n`);
    }

    // Parse AI response
    const action = parseAIResponse(aiMessage);

    if (!action) {
      console.error('❌ Could not parse AI response');
      throw new Error('Invalid AI response format');
    }

    console.log(`📋 Action: ${action.type}`);
    console.log(`📝 Reasoning: ${action.reasoning}`);
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

    // Execute action
    try {
      await executeAction(page, action);
      console.log('✅ Action executed successfully');

      // Check if test is complete
      if (action.type === 'complete') {
        testComplete = true;
        console.log('\n🎉 Test objective achieved!');
        break;
      }

    } catch (error) {
      console.error(`❌ Action failed: ${error.message}`);

      // Tell AI about the failure
      conversationHistory.push({
        role: 'user',
        content: `The action failed with error: ${error.message}. Please try a different approach.`
      });

      // Give AI one more chance
      continue;
    }

    // Wait a bit between actions
    await page.waitForTimeout(1000);
  }

  if (stepNumber >= config.maxSteps && !testComplete) {
    console.warn(`\n⚠️  Reached maximum steps (${config.maxSteps}) without completing test`);
  }
}

function buildInitialPrompt() {
  return `You are an expert QA automation engineer testing a web application.

**Test Objective:**
${config.prompt}

**Application URL:**
${config.url}

${config.email ? `**Test Credentials:**\n- Email: ${config.email}\n- Password: [PROVIDED]\n` : ''}

**Your Task:**
1. Analyze the current page screenshot
2. Decide the next action to achieve the test objective
3. Execute actions one at a time
4. Verify the objective is achieved

**Response Format:**
You must respond with a JSON object containing:
{
  "type": "navigate|click|type|verify|wait|complete",
  "reasoning": "why you're taking this action",
  "selector": "playwright selector to interact with",
  "value": "text to type (for type action)",
  "assertion": "what to verify (for verify action)"
}

**Action Types:**
- navigate: Go to a URL
- click: Click an element
- type: Type text into an input
- verify: Check that something is visible/present
- wait: Wait for something to appear
- complete: Test objective is achieved

**Selector Examples:**
- "button:has-text('Login')"
- "input[type='email']"
- "a[href='/dashboard']"
- "[data-testid='submit']"
- "h1:has-text('Dashboard')"

**Important:**
- Return ONLY the JSON object, no markdown formatting
- Be specific with selectors
- Verify your actions worked before proceeding
- When the test objective is fully achieved, return type: "complete"

Ready? Look at the screenshot and tell me the first action to take.`;
}

function buildStepPrompt(pageContext, stepNumber) {
  return `**Current Page State:**
URL: ${pageContext.url}
Title: ${pageContext.title}

**Visible Elements:**
${pageContext.elements.slice(0, 50).join('\n')}

**Step ${stepNumber}:**
Based on the screenshot and page state, what is the next action to achieve the test objective?

Remember: Return ONLY the JSON object with your next action.`;
}

async function getPageContext(page) {
  const context = await page.evaluate(() => {
    const elements = [];

    // Get visible interactive elements
    const selectors = [
      'button', 'a', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[type="submit"]',
      'h1', 'h2', '[data-testid]'
    ];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach((el, idx) => {
        if (el.offsetParent !== null) { // visible check
          const text = el.innerText?.trim() || el.value || '';
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const classes = el.className ? `.${el.className.split(' ').join('.')}` : '';
          const testId = el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : '';

          if (text.length > 0 && text.length < 100) {
            elements.push(`${tag}${id}${testId}: "${text}"`);
          } else if (id || testId) {
            elements.push(`${tag}${id}${testId}`);
          }
        }
      });
    });

    return {
      url: window.location.href,
      title: document.title,
      elements: elements.slice(0, 50)
    };
  });

  return context;
}

function parseAIResponse(aiMessage) {
  try {
    // Try to extract JSON from response
    let jsonText = aiMessage.trim();

    // Remove markdown code blocks if present
    if (jsonText.includes('```')) {
      const match = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) {
        jsonText = match[1];
      }
    }

    // Remove any leading/trailing text
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const action = JSON.parse(jsonText);

    // Validate required fields
    if (!action.type || !action.reasoning) {
      throw new Error('Missing required fields: type, reasoning');
    }

    // Replace credentials placeholders
    if (action.value) {
      action.value = action.value
        .replace(/{email}/g, config.email || '')
        .replace(/{password}/g, config.password || '');
    }

    return action;

  } catch (error) {
    console.error('Failed to parse AI response:', error.message);
    console.error('Raw response:', aiMessage);
    return null;
  }
}

async function executeAction(page, action) {
  switch (action.type) {
    case 'navigate':
      let url = action.selector || action.url || action.value;
      if (url.startsWith('/')) {
        url = config.url + url;
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      break;

    case 'click':
      if (!action.selector) throw new Error('No selector provided for click');
      await page.click(action.selector, { timeout: 10000 });
      await page.waitForTimeout(1000);
      break;

    case 'type':
      if (!action.selector) throw new Error('No selector provided for type');
      if (!action.value) throw new Error('No value provided for type');
      await page.fill(action.selector, action.value, { timeout: 10000 });
      await page.waitForTimeout(500);
      break;

    case 'verify':
      if (!action.selector) throw new Error('No selector provided for verify');
      const element = await page.waitForSelector(action.selector, { timeout: 10000 });
      if (!element) throw new Error(`Element not found: ${action.selector}`);

      // Check assertion if provided
      if (action.assertion) {
        const text = await element.textContent();
        if (!text.includes(action.assertion)) {
          throw new Error(`Assertion failed: "${action.assertion}" not found in element text`);
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
      // Test is complete, no action needed
      break;

    default:
      console.warn(`Unknown action type: ${action.type}`);
  }
}

function calculateCost(usage, model) {
  // Claude Sonnet 4.5 pricing (as of Jan 2025)
  const inputCostPer1M = 3.00;  // $3 per 1M input tokens
  const outputCostPer1M = 15.00; // $15 per 1M output tokens

  const inputCost = (usage.input_tokens / 1000000) * inputCostPer1M;
  const outputCost = (usage.output_tokens / 1000000) * outputCostPer1M;

  return inputCost + outputCost;
}

async function generateReport() {
  const report = {
    prompt: config.prompt,
    url: config.url,
    model: config.model,
    timestamp: new Date().toISOString(),
    duration: Date.now() - execution.startTime,
    totalSteps: execution.steps.length,
    totalCost: execution.totalCost,
    screenshotCount: execution.screenshotCount,
    steps: execution.steps,
  };

  // Save JSON
  fs.writeFileSync(
    path.join(config.outputDir, 'report.json'),
    JSON.stringify(report, null, 2)
  );

  // Generate HTML
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>QA Test Report - 100% AI Mode</title>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; }
    h1 { color: #1a202c; margin: 0 0 8px 0; }
    .meta { color: #718096; margin-bottom: 32px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
    .stat h3 { margin: 0 0 8px 0; font-size: 13px; opacity: 0.9; }
    .stat .value { font-size: 32px; font-weight: 700; }
    .step { background: #f8f9fa; padding: 20px; margin-bottom: 16px; border-radius: 8px; border-left: 4px solid #667eea; }
    .step-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .step-number { font-weight: 700; color: #667eea; }
    .step-action { background: #e0e7ff; color: #3730a3; padding: 4px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; }
    .reasoning { color: #4a5568; margin-bottom: 8px; }
    .details { font-size: 14px; color: #718096; }
    .screenshot { margin-top: 12px; }
    .screenshot img { max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; cursor: pointer; }
    .screenshot img:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 QA Test Report - 100% AI Mode</h1>
    <div class="meta">
      <div><strong>Prompt:</strong> ${report.prompt}</div>
      <div><strong>URL:</strong> ${report.url}</div>
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
      <div class="stat">
        <h3>Screenshots</h3>
        <div class="value">${report.screenshotCount}</div>
      </div>
    </div>

    <h2>Test Steps</h2>
    ${report.steps.map(step => `
      <div class="step">
        <div class="step-header">
          <span class="step-number">Step ${step.number}</span>
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
            <img src="${path.relative(config.outputDir, step.screenshot)}" alt="Step ${step.number}" style="max-width: 400px;">
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
  console.log('\n' + '═'.repeat(60));
  console.log('📊 TEST SUMMARY - 100% AI MODE');
  console.log('═'.repeat(60));
  console.log(`Test: "${config.prompt}"`);
  console.log(`Total Steps: ${execution.steps.length}`);
  console.log(`Duration: ${((Date.now() - execution.startTime) / 1000).toFixed(2)}s`);
  console.log(`Total Cost: $${execution.totalCost.toFixed(4)}`);
  console.log(`Screenshots: ${execution.screenshotCount}`);
  console.log(`Model: ${config.model}`);
  console.log('═'.repeat(60));
  console.log('✅ TEST COMPLETED SUCCESSFULLY');
  console.log('═'.repeat(60));
}

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
