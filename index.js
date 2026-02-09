#!/usr/bin/env node

/**
 * QA Agent - Automated Testing Tool
 *
 * Usage:
 *   qa-agent test --url <url> --suite <smoke|regression|critical>
 *   qa-agent --help
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

// Show help if no command or --help flag
if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

// Show version
if (command === '--version' || command === '-v') {
  const pkg = require('./package.json');
  console.log('qa-agent version ' + pkg.version);
  process.exit(0);
}

// Handle commands
switch (command) {
  case 'test':
    runTests(args.slice(1));
    break;
  default:
    console.error('Unknown command: ' + command);
    console.log('Run "qa-agent --help" for usage information');
    process.exit(1);
}

function showHelp() {
  console.log(`
QA Agent - Automated Testing Tool

USAGE:
  qa-agent test [options]

OPTIONS:
  --url <url>              URL to test (required)
  --suite <suite>          Test suite: smoke, regression, critical (default: smoke)
  --mode <mode>            Execution mode: standalone, hybrid (default: standalone)
  --anchor-points <path>   Path to QA_ANCHOR_POINTS.json
  --flows <path>           Path to QA_FLOWS.json
  --output-dir <path>      Output directory for results (default: ./qa-results)

EXAMPLES:
  # Run smoke tests (standalone mode)
  qa-agent test --url https://preview.example.com --suite smoke

  # Run with hybrid mode (AI-enhanced with learning)
  qa-agent test --url https://preview.example.com --suite smoke --mode hybrid

  # Run with custom anchor points
  qa-agent test --url https://preview.example.com \
    --anchor-points ./QA_ANCHOR_POINTS.json \
    --flows ./QA_FLOWS.json

  # Run regression suite
  qa-agent test --url https://preview.example.com --suite regression

OTHER COMMANDS:
  qa-agent --version       Show version
  qa-agent --help          Show this help

ENVIRONMENT VARIABLES:
  QA_PREVIEW_URL          Target URL (alternative to --url)
  QA_ANCHOR_POINTS        Path to anchor points file
  QA_FLOWS                Path to flows file
  TEST_EMAIL              Test account email
  TEST_PASSWORD           Test account password
  ANTHROPIC_API_KEY       API key for hybrid mode AI fallback
`);
}

function runTests(args) {
  // Check if hybrid mode is requested
  const isHybrid = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'hybrid';
  const scriptName = isHybrid ? 'run-qa-hybrid.cjs' : 'run-qa-ci.js';
  const script = path.join(__dirname, 'scripts', scriptName);

  if (!fs.existsSync(script)) {
    console.error('Error: Test runner script not found');
    process.exit(1);
  }

  const child = spawn('node', [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  child.on('exit', code => process.exit(code || 0));
}
