#!/usr/bin/env node

/**
 * QA Agent CI Runner - Hybrid Mode (Option C)
 *
 * Execution strategy:
 * 1. Try deterministic (original selector)
 * 2. Try learned solution (from knowledge base)
 * 3. Fall back to AI (if ANTHROPIC_API_KEY set)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const { AIFlowGenerator } = require('./ai-flow-generator.cjs');

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
  mode: getArg('--mode') || 'hybrid', // hybrid, standalone, ai
  prompt: getArg('--prompt'), // NEW: Natural language test prompt
  repoRoot: process.cwd(),
};

console.log('🤖 QA Agent CI Runner (Hybrid Mode - Option C)');
console.log('='.repeat(50));
console.log('Configuration:');
console.log(JSON.stringify({ ...config, repoRoot: undefined }, null, 2));
console.log('='.repeat(50));

// Initialize AI client if available
let aiClient = null;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (anthropicApiKey) {
  aiClient = new Anthropic.default({ apiKey: anthropicApiKey });
  console.log('✓ AI fallback enabled (ANTHROPIC_API_KEY found)');
} else {
  console.log('⚠️  AI fallback disabled (no ANTHROPIC_API_KEY)');
}

// Initialize knowledge base
const knowledgeBasePath = path.join(config.repoRoot, '.opencode', 'qa-knowledge');
const knowledgeBase = loadKnowledgeBase(knowledgeBasePath);

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
fs.mkdirSync(screenshotDir, { recursive: true});

// Test suite definitions (can be overridden by flow file)
const testSuites = {
  auth: [
    'authentication.fullLoginFlow',
    'authentication.completeAuthAndNav',
  ],
  smoke: [
    'authentication.login',
    'authentication.completeAuthAndNav',
    'callLogs.viewCallList',
    'appointmentTypes.viewAppointmentTypes',
    'dashboard.viewDashboard',
  ],
  e2e: [
    'authentication.completeAuthAndNav',
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
  console.log(`✓ Knowledge base: ${knowledgeBase.solutions.size} solutions, ${knowledgeBase.patterns.size} patterns`);
} catch (error) {
  console.error('❌ Error loading JSON files:', error.message);
  process.exit(1);
}

async function main() {
  const startTime = Date.now();
  const results = {
    suite: config.suite,
    url: config.url,
    mode: config.mode,
    startTime: new Date().toISOString(),
    flows: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
    },
    hybridStats: {
      deterministicSuccess: 0,
      learnedSuccess: 0,
      aiSuccess: 0,
      totalSteps: 0,
      aiCost: 0,
    },
  };

  let browser, context, page;

  try {
    // Handle direct prompt-based testing
    if (config.prompt) {
      console.log(`\n🤖 Running prompt-based test\n`);
      console.log(`   Prompt: "${config.prompt}"\n`);

      // Generate steps from prompt
      if (!aiClient) {
        throw new Error('ANTHROPIC_API_KEY required for prompt-based testing');
      }

      const generator = new AIFlowGenerator(anthropicApiKey);
      const generatedFlow = await generator.generateFlow(
        'Prompt-Based Test',
        config.prompt,
        {
          url: config.url,
          email: config.email,
          password: config.password,
        }
      );

      // Create a temporary flow to execute
      flowsData = {
        prompt: {
          test: generatedFlow,
        },
      };

      const flowPaths = ['prompt.test'];
      console.log(`   ✓ Generated ${generatedFlow.steps.length} steps\n`);

      // Continue with normal execution
      console.log('🌐 Launching browser...');
      browser = await chromium.launch({ headless: config.headless });
      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
      console.log('✓ Browser ready\n');

      // Execute the generated flow
      for (const flowPath of flowPaths) {
        const flowResult = await executeFlow(flowPath, page, config, results.hybridStats);
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

      // Save successful prompt-based flow
      if (results.summary.passed > 0) {
        const savedFlowPath = path.join(config.outputDir, 'generated-flow.json');
        fs.writeFileSync(savedFlowPath, JSON.stringify(generatedFlow, null, 2));
        console.log(`\n📝 Saved generated flow to: ${savedFlowPath}`);
      }
    } else {
      // Normal suite-based testing
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
        const flowResult = await executeFlow(flowPath, page, config, results.hybridStats);
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

    // Save knowledge base
    saveKnowledgeBase(knowledgeBasePath, knowledgeBase);

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

    // Print hybrid stats
    if (config.mode === 'hybrid') {
      console.log('\n' + '='.repeat(50));
      console.log('🧠 Hybrid Execution Stats');
      console.log('='.repeat(50));
      console.log(`Total Steps: ${results.hybridStats.totalSteps}`);
      console.log(`Deterministic Success: ${results.hybridStats.deterministicSuccess} (${((results.hybridStats.deterministicSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)`);
      console.log(`Learned Success: ${results.hybridStats.learnedSuccess} (${((results.hybridStats.learnedSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)`);
      console.log(`AI Success: ${results.hybridStats.aiSuccess} (${((results.hybridStats.aiSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)`);
      console.log(`AI Cost: $${results.hybridStats.aiCost.toFixed(4)}`);
      console.log(`Knowledge Base: ${knowledgeBase.solutions.size} solutions`);
    }
    console.log('='.repeat(50));

    // Exit with appropriate code
    process.exit(results.summary.failed > 0 ? 1 : 0);
  }
}

async function executeFlow(flowPath, page, config, hybridStats) {
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

    // Check if flow uses prompt-based generation
    if (flow.prompt && !flow.steps) {
      console.log(`   🤖 Generating steps from prompt...`);
      if (!aiClient) {
        throw new Error('AI client required for prompt-based flows. Set ANTHROPIC_API_KEY.');
      }

      const generator = new AIFlowGenerator(anthropicApiKey);
      const generatedSteps = await generator.generateSteps(flow.prompt, {
        url: config.url,
        email: config.email,
        password: config.password,
      });

      flow.steps = generatedSteps;
      console.log(`   ✓ Generated ${generatedSteps.length} steps`);

      // Save generated flow for reuse
      saveGeneratedFlow(flowPath, flow, flowsData, config.flows);
    }

    if (!flow.steps || flow.steps.length === 0) {
      throw new Error('Flow has no steps');
    }

    // Create execution context
    const executionContext = {
      flowPath,
      url: config.url,
      pageType: classifyPage(config.url),
    };

    // Execute flow steps
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      await executeStepHybrid(step, page, i + 1, flowPath, result.screenshots, config, executionContext, hybridStats);
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

async function executeStepHybrid(step, page, stepNumber, flowPath, screenshots, config, context, hybridStats) {
  console.log(`   ${stepNumber}. ${step.action}: ${step.description || ''}`);

  hybridStats.totalSteps++;

  // Replace parameters
  const params = {
    email: config.email,
    password: config.password,
    baseUrl: config.url,
  };

  let selector = replaceParams(step.selector || step.target || '', params);
  selector = convertSelector(selector);
  let value = replaceParams(step.value || '', params);
  let url = step.url || step.target || '';

  // Special handling for navigate action
  if (step.action === 'navigate') {
    let fullUrl = url;
    if (url && url.startsWith('/')) {
      fullUrl = config.url + url;
    } else if (!url) {
      fullUrl = config.url;
    }
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(step.wait || 1000);
    hybridStats.deterministicSuccess++;
    return;
  }

  // Special handling for screenshot action
  if (step.action === 'screenshot') {
    const filename = step.filename || value || `${flowPath.replace(/\./g, '_')}_step${stepNumber}.png`;
    const screenshotPath = path.join(config.outputDir, 'screenshots', filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshots.push(screenshotPath);
    console.log(`      ✓ Screenshot saved: ${filename}`);
    hybridStats.deterministicSuccess++;
    return;
  }

  // Hybrid execution: Deterministic → Learned → AI

  // 1. Try deterministic
  try {
    await executeAction(step.action, page, selector, value, step);
    console.log(`      ✓ Deterministic succeeded`);
    hybridStats.deterministicSuccess++;
    return;
  } catch (deterministicError) {
    console.log(`      ✗ Deterministic failed: ${deterministicError.message.split('\n')[0]}`);
  }

  // 2. Try learned solution
  const learnedSolution = findLearnedSolution(step, context, knowledgeBase);
  if (learnedSolution) {
    console.log(`      → Trying learned solution (confidence: ${learnedSolution.confidence.toFixed(2)})`);
    try {
      await executeAction(step.action, page, learnedSolution.learnedSelector, value, step);
      console.log(`      ✓ Learned solution succeeded`);
      recordSuccess(learnedSolution.id, knowledgeBase);
      hybridStats.learnedSuccess++;
      return;
    } catch (learnedError) {
      console.log(`      ✗ Learned solution failed`);
      recordFailure(learnedSolution.id, knowledgeBase);
    }
  }

  // 3. Fall back to AI
  if (aiClient && config.mode === 'hybrid') {
    console.log(`      → Falling back to AI...`);
    try {
      const aiResult = await executeWithAI(step, page, context, aiClient);
      if (aiResult.success) {
        console.log(`      ✓ AI succeeded: ${aiResult.selector}`);

        // Learn this solution
        recordSolution(step, aiResult.selector, context, knowledgeBase);

        hybridStats.aiSuccess++;
        hybridStats.aiCost += 0.016; // Approximate cost per AI call
        return;
      }
    } catch (aiError) {
      console.log(`      ✗ AI failed: ${aiError.message}`);
      hybridStats.aiCost += 0.016;
    }
  }

  // All methods failed
  throw new Error(`All execution methods failed for step: ${step.action}`);
}

async function executeAction(action, page, selector, value, step = {}) {
  switch (action) {
    case 'click':
      await page.click(selector, { timeout: 10000 });
      await page.waitForTimeout(500);
      break;

    case 'type':
    case 'fill':
      await page.fill(selector, value, { timeout: 10000 });
      await page.waitForTimeout(500);
      break;

    case 'clear':
      await page.fill(selector, '', { timeout: 10000 });
      await page.waitForTimeout(300);
      break;

    case 'verify':
      // Handle different verification types
      if (step.exists === false) {
        // Verify element doesn't exist
        const count = await page.locator(selector).count();
        if (count > 0) {
          throw new Error(`Verification failed: element should not exist: ${selector}`);
        }
      } else if (step.visible === true || step.visible === false) {
        // Verify visibility
        const element = await page.waitForSelector(selector, { timeout: 10000, state: step.visible ? 'visible' : 'hidden' });
        if (!element) {
          throw new Error(`Verification failed: element not ${step.visible ? 'visible' : 'hidden'}: ${selector}`);
        }
      } else if (step.minCount !== undefined) {
        // Verify minimum count
        const count = await page.locator(selector).count();
        if (count < step.minCount) {
          throw new Error(`Verification failed: found ${count} elements, expected at least ${step.minCount}`);
        }
      } else if (step.count !== undefined) {
        // Verify exact count
        const count = await page.locator(selector).count();
        if (count !== step.count) {
          throw new Error(`Verification failed: found ${count} elements, expected ${step.count}`);
        }
      } else if (step.contains) {
        // Verify text content
        const element = await page.waitForSelector(selector, { timeout: 10000 });
        const text = await element.textContent();
        if (!text || !text.includes(step.contains)) {
          throw new Error(`Verification failed: element does not contain "${step.contains}"`);
        }
      } else if (step.textIncludes) {
        // Verify text includes any of the provided strings
        const element = await page.waitForSelector(selector, { timeout: 10000 });
        const text = await element.textContent();
        const found = step.textIncludes.some(str => text && text.includes(str));
        if (!found) {
          throw new Error(`Verification failed: element does not contain any of: ${step.textIncludes.join(', ')}`);
        }
      } else if (step.enabled !== undefined) {
        // Verify enabled/disabled state
        const element = await page.waitForSelector(selector, { timeout: 10000 });
        const isDisabled = await element.isDisabled();
        if (step.enabled && isDisabled) {
          throw new Error(`Verification failed: element should be enabled: ${selector}`);
        } else if (!step.enabled && !isDisabled) {
          throw new Error(`Verification failed: element should be disabled: ${selector}`);
        }
      } else {
        // Default: just check existence
        const element = await page.waitForSelector(selector, { timeout: 10000 });
        if (!element) {
          throw new Error(`Verification failed: element not found: ${selector}`);
        }
      }
      break;

    case 'wait':
      // Support both 'value' and 'duration' properties
      const waitTime = value || step.duration;
      if (waitTime && !isNaN(waitTime)) {
        await page.waitForTimeout(parseInt(waitTime));
      } else if (selector) {
        // Wait for selector with optional condition
        const state = step.condition === 'visible' ? 'visible' : 'attached';
        await page.waitForSelector(selector, { timeout: 30000, state });
      } else {
        await page.waitForTimeout(1000); // Default 1 second
      }
      break;

    case 'navigate':
      await page.goto(selector || value, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1000);
      break;

    case 'screenshot':
      // Screenshot action is handled separately in executeStepHybrid
      // This case exists to prevent "unsupported action" error
      break;

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

async function executeWithAI(step, page, context, client) {
  // Capture page state
  const screenshot = await page.screenshot({ fullPage: false });
  const dom = await getSimplifiedDOM(page);
  const url = page.url();

  const originalSelector = step.selector || step.target || '';
  const description = step.description || '';

  const prompt = `You are a QA automation expert. Find the best selector for this element.

Task: ${step.action}
Description: ${description}
Failed Selector: ${originalSelector}
URL: ${url}

DOM Structure:
${dom}

Return a valid Playwright selector. Prefer data-testid, aria-label, or text-based selectors.

Respond in JSON:
{
  "selector": "best selector here",
  "confidence": 0.9,
  "reasoning": "why this selector"
}`;

  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot.toString('base64'),
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });

  const content = response.content[0];
  if (content.type === 'text') {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const aiResponse = JSON.parse(jsonMatch[0]);

      // Try to execute with AI-suggested selector
      try {
        await executeAction(step.action, page, aiResponse.selector, step.value, step);
        return {
          success: true,
          selector: aiResponse.selector,
          confidence: aiResponse.confidence,
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    }
  }

  return { success: false, error: 'Failed to parse AI response' };
}

async function getSimplifiedDOM(page) {
  try {
    return await page.evaluate(() => {
      const simplify = (el, depth = 0) => {
        if (depth > 3) return '';
        const tag = el.tagName.toLowerCase();
        const attrs = Array.from(el.attributes)
          .filter(a => ['id', 'class', 'data-testid', 'aria-label', 'type', 'name', 'placeholder'].includes(a.name))
          .map(a => `${a.name}="${a.value}"`)
          .join(' ');
        const text = el.textContent?.trim().slice(0, 50) || '';
        let result = `<${tag}${attrs ? ' ' + attrs : ''}>`;
        if (text && !el.children.length) result += text;
        if (el.children.length) {
          result += Array.from(el.children).slice(0, 5).map(c => simplify(c, depth + 1)).join('');
        }
        result += `</${tag}>`;
        return result;
      };
      return simplify(document.body);
    });
  } catch (error) {
    return '<body>Error capturing DOM</body>';
  }
}

// Knowledge Base Functions

function loadKnowledgeBase(basePath) {
  const kb = {
    solutions: new Map(),
    patterns: new Map(),
    basePath,
  };

  // Ensure directory exists
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true });
  }

  // Load solutions
  const solutionsPath = path.join(basePath, 'solutions.json');
  if (fs.existsSync(solutionsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(solutionsPath, 'utf8'));
      kb.solutions = new Map(data.solutions.map(s => [s.id, s]));
    } catch (error) {
      console.warn('Failed to load solutions:', error.message);
    }
  }

  // Load patterns
  const patternsPath = path.join(basePath, 'patterns.json');
  if (fs.existsSync(patternsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
      kb.patterns = new Map(data.patterns.map(p => [p.id, p]));
    } catch (error) {
      console.warn('Failed to load patterns:', error.message);
    }
  }

  return kb;
}

function saveKnowledgeBase(basePath, kb) {
  // Save solutions
  const solutionsPath = path.join(basePath, 'solutions.json');
  const solutionsData = {
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    solutions: Array.from(kb.solutions.values()),
  };
  fs.writeFileSync(solutionsPath, JSON.stringify(solutionsData, null, 2));

  // Save patterns
  const patternsPath = path.join(basePath, 'patterns.json');
  const patternsData = {
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    patterns: Array.from(kb.patterns.values()),
  };
  fs.writeFileSync(patternsPath, JSON.stringify(patternsData, null, 2));
}

function findLearnedSolution(step, context, kb) {
  const key = generateKey(step);
  const exact = kb.solutions.get(key);

  if (exact && exact.confidence > 0.8) {
    return exact;
  }

  // Try to find similar solutions
  for (const solution of kb.solutions.values()) {
    if (solution.stepAction === step.action &&
        solution.pageContext.pageType === context.pageType &&
        solution.confidence > 0.75) {
      return solution;
    }
  }

  return null;
}

function recordSolution(step, learnedSelector, context, kb) {
  const solution = {
    id: generateKey(step),
    flowPath: context.flowPath,
    stepAction: step.action,
    originalSelector: step.selector || step.target || '',
    learnedSelector,
    confidence: 0.7,
    successCount: 1,
    failureCount: 0,
    pageContext: {
      url: context.url,
      pageType: context.pageType,
    },
    learnedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };

  kb.solutions.set(solution.id, solution);
  console.log(`      📚 Learned new solution`);
}

function recordSuccess(solutionId, kb) {
  const solution = kb.solutions.get(solutionId);
  if (solution) {
    solution.successCount++;
    solution.lastUsed = new Date().toISOString();
    solution.confidence = Math.min(0.99, solution.confidence + 0.02);
  }
}

function recordFailure(solutionId, kb) {
  const solution = kb.solutions.get(solutionId);
  if (solution) {
    solution.failureCount++;
    solution.confidence = Math.max(0.3, solution.confidence - 0.1);
    if (solution.confidence < 0.4) {
      kb.solutions.delete(solutionId);
    }
  }
}

function generateKey(step) {
  const crypto = require('crypto');
  const selector = step.selector || step.target || '';
  const hash = crypto.createHash('md5').update(selector).digest('hex').slice(0, 8);
  return `${step.action}-${hash}`;
}

function classifyPage(url) {
  if (url.includes('/login')) return 'authentication';
  if (url.includes('/dashboard')) return 'dashboard';
  if (url.includes('/call')) return 'call-management';
  if (url.includes('/appointment')) return 'appointments';
  return 'general';
}

// Utility functions (same as standalone)

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

function getFlowByPath(flowPath, flowsData) {
  const parts = flowPath.split('.');
  let current = flowsData;

  for (const part of parts) {
    current = current[part];
    if (!current) return null;
  }

  return current;
}

function replaceParams(str, params) {
  if (!str) return str;
  str = str.replace(/\${(\w+)}/g, (match, key) => params[key] || match);
  str = str.replace(/\{(\w+)\}/g, (match, key) => params[key] || match);
  return str;
}

function convertSelector(selector) {
  if (!selector) return selector;
  selector = selector.replace(/:contains\(['"]([^'"]+)['"]\)/g, ':has-text("$1")');
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
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 30px 0; }
    .summary-card { padding: 20px; border-radius: 8px; background: #f5f5f5; }
    .summary-card h3 { margin: 0 0 10px 0; font-size: 14px; color: #666; }
    .summary-card .value { font-size: 32px; font-weight: bold; }
    .passed { color: #10b981; }
    .failed { color: #ef4444; }
    .flow { margin: 20px 0; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; }
    .flow-header { display: flex; justify-content: space-between; align-items: center; }
    .status-badge { padding: 4px 12px; border-radius: 4px; font-size: 14px; font-weight: 500; }
    .status-passed { background: #d1fae5; color: #065f46; }
    .status-failed { background: #fee2e2; color: #991b1b; }
    .hybrid-stats { background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
  </style>
</head>
<body>
  <h1>QA Test Report</h1>
  <p><strong>Suite:</strong> ${results.suite} | <strong>Mode:</strong> ${results.mode || 'standalone'} | <strong>URL:</strong> ${results.url}</p>
  <p><strong>Started:</strong> ${new Date(results.startTime).toLocaleString()}</p>

  <div class="summary">
    <div class="summary-card">
      <h3>Total Tests</h3>
      <div class="value">${results.summary.total}</div>
    </div>
    <div class="summary-card">
      <h3>Passed</h3>
      <div class="value passed">${results.summary.passed}</div>
    </div>
    <div class="summary-card">
      <h3>Failed</h3>
      <div class="value failed">${results.summary.failed}</div>
    </div>
    <div class="summary-card">
      <h3>Duration</h3>
      <div class="value">${(results.summary.duration / 1000).toFixed(2)}s</div>
    </div>
  </div>

  ${results.hybridStats ? `
  <div class="hybrid-stats">
    <h2>Hybrid Execution Stats</h2>
    <p><strong>Total Steps:</strong> ${results.hybridStats.totalSteps}</p>
    <p><strong>Deterministic Success:</strong> ${results.hybridStats.deterministicSuccess} (${((results.hybridStats.deterministicSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)</p>
    <p><strong>Learned Success:</strong> ${results.hybridStats.learnedSuccess} (${((results.hybridStats.learnedSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)</p>
    <p><strong>AI Success:</strong> ${results.hybridStats.aiSuccess} (${((results.hybridStats.aiSuccess / results.hybridStats.totalSteps) * 100).toFixed(1)}%)</p>
    <p><strong>AI Cost:</strong> $${results.hybridStats.aiCost.toFixed(4)}</p>
  </div>
  ` : ''}

  <h2>Test Results</h2>
  ${results.flows.map(flow => `
    <div class="flow">
      <div class="flow-header">
        <h3>${flow.flowPath}</h3>
        <span class="status-badge status-${flow.status}">${flow.status.toUpperCase()}</span>
      </div>
      <p><strong>Duration:</strong> ${(flow.duration / 1000).toFixed(2)}s</p>
      ${flow.error ? `<p><strong>Error:</strong> <code>${flow.error}</code></p>` : ''}
      ${flow.screenshots.length > 0 ? `<p><strong>Screenshots:</strong> ${flow.screenshots.length}</p>` : ''}
    </div>
  `).join('')}
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log(`✓ Report saved: ${reportPath}`);
}

function saveGeneratedFlow(flowPath, flow, flowsData, flowsFilePath) {
  try {
    // Update the flows data with generated steps
    const parts = flowPath.split('.');
    let current = flowsData;

    for (let i = 0; i < parts.length - 1; i++) {
      current = current[parts[i]];
    }

    const lastPart = parts[parts.length - 1];
    current[lastPart] = {
      ...flow,
      generatedAt: new Date().toISOString(),
      originalPrompt: flow.prompt,
    };

    // Save updated flows to file
    const updatedData = { flows: flowsData };
    fs.writeFileSync(flowsFilePath, JSON.stringify(updatedData, null, 2));
    console.log(`   📝 Saved generated flow to ${flowsFilePath}`);
  } catch (error) {
    console.warn(`   ⚠️  Could not save generated flow: ${error.message}`);
  }
}

// Run the tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
