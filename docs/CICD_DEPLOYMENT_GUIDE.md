# 🚀 CI/CD Deployment Guide - QA Agent Hybrid Mode

## Overview

This guide shows how to export and deploy the QA Agent with **Hybrid Mode** (Prompt-based + AI Fallback) to CI/CD pipelines.

**Hybrid Mode Features:**
- ✅ Prompt-based testing - Describe tests in plain English
- 🧠 Learned solutions - Knowledge base grows over time
- 🤖 AI fallback - Claude Haiku finds selectors when needed
- 💰 Cost-optimized - Average $0.01-0.03 per test run
- 📊 Detailed reporting - Execution strategy breakdown

---

## 🎯 Quick Start (3 Steps)

### 1. Build the Package

```bash
# In this repo (opencode-dev)
npm run build:qa-agent
```

This creates:
- `build/qa-agent/` - Complete standalone package
- `build/qa-agent-*.tar.gz` - Compressed archive

### 2. Copy to Your Project

```bash
# Option A: Copy built package
cp -r build/qa-agent /path/to/your-project/.qa-agent

# Option B: Extract from archive
cd /path/to/your-project
tar -xzf /path/to/opencode-dev/build/qa-agent-*.tar.gz
mv qa-agent-dist .qa-agent
```

### 3. Run Tests

```bash
cd /path/to/your-project/.qa-agent

# Install dependencies
npm install

# Playwright (browser automation)
npx playwright install chromium

# Run with prompt (AI generates test steps)
export ANTHROPIC_API_KEY="your-key-here"
node scripts/run-qa-ci-hybrid.cjs \
  --url https://your-app.com \
  --prompt "Login with test@example.com, navigate to dashboard, verify charts are visible" \
  --email test@example.com \
  --password TestPassword123!

# Or run with flows
node scripts/run-qa-ci-hybrid.cjs \
  --url https://your-app.com \
  --flows ./QA_FLOWS.json \
  --anchor-points ./QA_ANCHOR_POINTS.json \
  --suite smoke
```

---

## 📦 Package Contents

```
.qa-agent/
├── scripts/
│   ├── run-qa-ci-hybrid.cjs       # Hybrid mode CI runner ⭐
│   ├── run-qa-ci.js                # Basic CI runner
│   └── run-qa-hybrid.cjs           # Full-featured runner
├── package.json                     # Dependencies
├── QA_ANCHOR_POINTS.json           # Common patterns (optional)
├── QA_FLOWS.json                   # Test flows (optional)
├── README.md                        # Documentation
└── Dockerfile                       # Docker support
```

---

## 🔧 CI/CD Integration

### GitHub Actions

Create `.github/workflows/qa-hybrid.yml`:

```yaml
name: QA Tests (Hybrid Mode)

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      url:
        description: 'URL to test'
        required: true
      prompt:
        description: 'Test prompt (optional)'
        required: false

jobs:
  qa-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install QA Agent
        working-directory: .qa-agent
        run: |
          npm ci
          npx playwright install --with-deps chromium

      # Option 1: Prompt-based testing
      - name: Run Prompt Test
        if: github.event.inputs.prompt != ''
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url "${{ github.event.inputs.url }}" \
            --prompt "${{ github.event.inputs.prompt }}" \
            --email "${{ secrets.TEST_EMAIL }}" \
            --password "${{ secrets.TEST_PASSWORD }}"

      # Option 2: Flow-based testing
      - name: Run Flow Tests
        if: github.event.inputs.prompt == ''
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url "${{ github.event.inputs.url || 'https://your-app.com' }}" \
            --flows .qa-agent/QA_FLOWS.json \
            --suite smoke

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-results
          path: qa-results/
```

### GitLab CI

Create `.gitlab-ci.yml`:

```yaml
qa-hybrid:
  stage: test
  image: mcr.microsoft.com/playwright:v1.57.0
  variables:
    QA_URL: "https://your-app.com"
    QA_SUITE: "smoke"
  script:
    - cd .qa-agent
    - npm ci
    - npx playwright install chromium
    - |
      node scripts/run-qa-ci-hybrid.cjs \
        --url "$QA_URL" \
        --flows ./QA_FLOWS.json \
        --suite "$QA_SUITE" \
        --email "$TEST_EMAIL" \
        --password "$TEST_PASSWORD"
  artifacts:
    when: always
    paths:
      - qa-results/
    expire_in: 30 days
```

### Jenkins

```groovy
pipeline {
  agent any

  environment {
    ANTHROPIC_API_KEY = credentials('anthropic-api-key')
    TEST_EMAIL = credentials('test-email')
    TEST_PASSWORD = credentials('test-password')
  }

  stages {
    stage('Setup') {
      steps {
        sh 'cd .qa-agent && npm ci'
        sh 'npx playwright install chromium'
      }
    }

    stage('QA Tests') {
      steps {
        sh '''
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url https://your-app.com \
            --flows .qa-agent/QA_FLOWS.json \
            --suite smoke
        '''
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'qa-results/**/*', allowEmptyArchive: true
      publishHTML([
        reportDir: 'qa-results',
        reportFiles: 'report.html',
        reportName: 'QA Test Report'
      ])
    }
  }
}
```

### CircleCI

Create `.circleci/config.yml`:

```yaml
version: 2.1

orbs:
  node: circleci/node@5.0

jobs:
  qa-tests:
    docker:
      - image: mcr.microsoft.com/playwright:v1.57.0
    steps:
      - checkout
      - node/install-packages:
          pkg-manager: npm
          app-dir: .qa-agent
      - run:
          name: Install Playwright
          command: npx playwright install chromium
      - run:
          name: Run QA Tests
          command: |
            node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
              --url https://your-app.com \
              --flows .qa-agent/QA_FLOWS.json \
              --suite smoke
      - store_artifacts:
          path: qa-results

workflows:
  test:
    jobs:
      - qa-tests
```

---

## 🐳 Docker Deployment

### Dockerfile

Create `Dockerfile` in your project:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.57.0-focal

WORKDIR /app

# Copy QA Agent
COPY .qa-agent/ ./

# Install dependencies
RUN npm ci && \
    npx playwright install chromium

# Default command
CMD ["node", "scripts/run-qa-ci-hybrid.cjs", "--help"]
```

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  qa-agent:
    build: .
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - QA_PREVIEW_URL=${QA_PREVIEW_URL:-https://your-app.com}
      - TEST_EMAIL=${TEST_EMAIL}
      - TEST_PASSWORD=${TEST_PASSWORD}
    command: >
      node scripts/run-qa-ci-hybrid.cjs
      --url $QA_PREVIEW_URL
      --prompt "Login, navigate to dashboard, verify all widgets load"
    volumes:
      - ./qa-results:/app/qa-results
      - ./qa-knowledge:/app/.opencode/qa-knowledge
```

### Usage

```bash
# Build image
docker build -t qa-agent .

# Run with prompt
docker run --rm \
  -e ANTHROPIC_API_KEY="your-key" \
  -e TEST_EMAIL="test@example.com" \
  -e TEST_PASSWORD="password" \
  -v $(pwd)/qa-results:/app/qa-results \
  qa-agent \
  node scripts/run-qa-ci-hybrid.cjs \
    --url https://your-app.com \
    --prompt "Login and verify dashboard"

# Run with flows
docker run --rm \
  -e ANTHROPIC_API_KEY="your-key" \
  -v $(pwd)/qa-results:/app/qa-results \
  qa-agent \
  node scripts/run-qa-ci-hybrid.cjs \
    --url https://your-app.com \
    --flows ./QA_FLOWS.json \
    --suite smoke
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key for AI fallback | - |
| `QA_PREVIEW_URL` | Yes | URL to test | - |
| `TEST_EMAIL` | No | Test user email | - |
| `TEST_PASSWORD` | No | Test user password | - |
| `QA_MODE` | No | Execution mode (`hybrid`, `deterministic`) | `hybrid` |
| `QA_SUITE` | No | Test suite (`smoke`, `regression`, etc.) | `smoke` |
| `QA_FLOWS` | No | Path to flows JSON | - |
| `QA_ANCHOR_POINTS` | No | Path to anchor points JSON | - |
| `QA_PROMPT` | No | Test prompt (overrides flows) | - |
| `AI_MODEL` | No | Claude model to use | `claude-3-haiku-20240307` |

\* Only required for `hybrid` mode

### Command Line Options

```bash
node scripts/run-qa-ci-hybrid.cjs [options]

Options:
  --url <url>                   Target URL to test (required)
  --prompt <text>               Test prompt for AI generation
  --flows <path>                Path to flows JSON file
  --anchor-points <path>        Path to anchor points JSON file
  --suite <name>                Test suite name (smoke, regression, etc.)
  --email <email>               Test user email
  --password <password>         Test user password
  --mode <mode>                 Execution mode (hybrid, deterministic)
  --output-dir <path>           Results output directory
  --knowledge-dir <path>        Knowledge base directory
  --headless <true|false>       Run browser in headless mode
```

---

## 📊 Understanding Results

### Output Files

```
qa-results/
├── summary.json          # Test execution summary
├── report.html           # Beautiful HTML report
└── screenshots/          # Screenshot artifacts
    ├── step1.png
    ├── step2.png
    └── error_step5.png
```

### Summary JSON

```json
{
  "url": "https://your-app.com",
  "mode": "hybrid",
  "suite": "smoke",
  "timestamp": "2026-01-28T14:30:00.000Z",
  "stats": {
    "totalSteps": 20,
    "deterministicSuccess": 18,
    "learnedSuccess": 1,
    "aiSuccess": 1,
    "failures": 0,
    "aiCost": 0.024,
    "duration": 35420,
    "deterministicRate": "90.0",
    "learnedRate": "5.0",
    "aiRate": "5.0",
    "successRate": "100.0"
  }
}
```

### Execution Strategy Breakdown

- **Deterministic (90%)**: Hardcoded selectors worked immediately
- **Learned (5%)**: Used solutions from previous AI discoveries
- **AI (5%)**: Required Claude Haiku to find selectors
- **Cost**: $0.024 for AI usage (5% of steps)

### Knowledge Base Growth

After each AI success, the solution is saved:

```json
{
  "version": "1.0",
  "lastUpdated": "2026-01-28T14:30:00.000Z",
  "solutions": [
    {
      "id": "click-1738073400000",
      "stepAction": "click",
      "originalSelector": "button",
      "learnedSelector": "button:has-text('Continue')",
      "confidence": 0.85,
      "successCount": 5,
      "failureCount": 0,
      "learnedAt": "2026-01-28T14:20:00.000Z",
      "lastUsed": "2026-01-28T14:30:00.000Z"
    }
  ]
}
```

**Over time:**
- Run 1: 80% deterministic, 20% AI → $0.06
- Run 5: 95% deterministic, 5% learned → $0.01
- Run 10: 98% deterministic, 2% learned → $0.00

---

## 🎯 Usage Patterns

### Pattern 1: PR Preview Testing

```yaml
# Test every PR preview deployment
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Wait for Preview
        uses: nev7n/wait_for_response@v1
        with:
          url: https://preview-pr-${{ github.event.pull_request.number }}.app.com
      - name: Run QA Tests
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url https://preview-pr-${{ github.event.pull_request.number }}.app.com \
            --flows .qa-agent/QA_FLOWS.json \
            --suite smoke
```

### Pattern 2: Scheduled Regression Tests

```yaml
# Run full regression suite nightly
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Regression Suite
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url https://staging.your-app.com \
            --flows .qa-agent/QA_FLOWS.json \
            --suite regression
```

### Pattern 3: On-Demand Prompt Testing

```yaml
# Manual workflow with custom prompt
on:
  workflow_dispatch:
    inputs:
      url:
        description: 'URL to test'
        required: true
      prompt:
        description: 'What to test'
        required: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Custom Test
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url "${{ github.event.inputs.url }}" \
            --prompt "${{ github.event.inputs.prompt }}"
```

### Pattern 4: Post-Deployment Verification

```yaml
# Verify production after deployment
on:
  deployment_status:

jobs:
  verify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Smoke Test Production
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url https://your-app.com \
            --flows .qa-agent/QA_FLOWS.json \
            --suite critical
```

---

## 💡 Best Practices

### 1. Start with Prompts, Graduate to Flows

**Week 1:** Use prompts to explore
```bash
--prompt "Login as admin and verify all dashboard widgets"
```

**Week 2:** Extract learned selectors into flows
```json
{
  "steps": [
    {"action": "click", "target": "button:has-text('Admin Login')"},
    {"action": "verify", "target": "[data-widget='dashboard']"}
  ]
}
```

**Week 3+:** 95%+ deterministic, minimal AI cost

### 2. Commit Knowledge Base

```yaml
# Save learned solutions to repo
- name: Commit Knowledge
  run: |
    git add .opencode/qa-knowledge/solutions.json
    git commit -m "chore: update QA knowledge [skip ci]"
    git push
```

### 3. Use Suites Strategically

```json
{
  "suites": {
    "smoke": ["login", "navigation"],        // Fast, every PR
    "regression": ["e2e-*"],                  // Full, nightly
    "critical": ["checkout", "payment"]       // Essential, deploy
  }
}
```

### 4. Monitor AI Cost

```bash
# View cost trends
jq '.stats.aiCost' qa-results/summary.json

# Alert if cost spikes (indicates UI changed)
if [ $(jq '.stats.aiCost' qa-results/summary.json | cut -d. -f1) -gt 1 ]; then
  echo "⚠️ High AI cost - selectors may need updating"
fi
```

### 5. Cache Knowledge Base

```yaml
- name: Cache Knowledge
  uses: actions/cache@v4
  with:
    path: .opencode/qa-knowledge
    key: qa-knowledge-${{ hashFiles('.opencode/qa-knowledge/*.json') }}
    restore-keys: qa-knowledge-
```

---

## 🔒 Security

### Secrets Management

**GitHub Actions:**
```bash
gh secret set ANTHROPIC_API_KEY --body "sk-ant-api03-..."
gh secret set TEST_EMAIL --body "test@example.com"
gh secret set TEST_PASSWORD --body "password123"
```

**GitLab CI:**
```bash
# Settings → CI/CD → Variables
ANTHROPIC_API_KEY = sk-ant-api03-...
TEST_EMAIL = test@example.com
TEST_PASSWORD = password123
```

**Jenkins:**
```groovy
credentials('anthropic-api-key')
credentials('test-email')
credentials('test-password')
```

### Best Practices

1. ✅ Use CI/CD secrets (never commit)
2. ✅ Rotate credentials regularly
3. ✅ Use test accounts (not real users)
4. ✅ Limit API key permissions
5. ✅ Monitor API usage

---

## 📈 Scaling

### Parallel Execution

```yaml
jobs:
  qa:
    strategy:
      matrix:
        suite: [smoke, regression, critical]
    runs-on: ubuntu-latest
    steps:
      - name: Run ${{ matrix.suite }}
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url https://your-app.com \
            --flows .qa-agent/QA_FLOWS.json \
            --suite ${{ matrix.suite }}
```

### Multiple Environments

```yaml
jobs:
  qa:
    strategy:
      matrix:
        env:
          - { name: staging, url: https://staging.app.com }
          - { name: production, url: https://app.com }
    runs-on: ubuntu-latest
    steps:
      - name: Test ${{ matrix.env.name }}
        run: |
          node .qa-agent/scripts/run-qa-ci-hybrid.cjs \
            --url ${{ matrix.env.url }} \
            --suite smoke
```

---

## 🆘 Troubleshooting

### Issue: "ANTHROPIC_API_KEY not set"

**Solution:**
```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
# Or add to CI/CD secrets
```

### Issue: "Playwright not installed"

**Solution:**
```bash
npx playwright install chromium
# Or in Docker: use mcr.microsoft.com/playwright image
```

### Issue: "High AI costs"

**Cause:** UI changed, deterministic selectors failing

**Solution:**
```bash
# Review failed selectors
jq '.solutions[] | select(.failureCount > 0)' .opencode/qa-knowledge/solutions.json

# Update flows with learned selectors
jq '.solutions[] | {action: .stepAction, target: .learnedSelector}' .opencode/qa-knowledge/solutions.json
```

### Issue: "Tests timing out"

**Solution:**
```bash
# Increase timeouts in flows
{"action": "wait", "duration": 5000}

# Or use custom wait conditions
{"action": "wait", "target": "button", "condition": "visible"}
```

---

## 📚 Resources

- **Examples:** [`/examples`](./examples/)
- **API Docs:** [`/docs/api.md`](./docs/api.md)
- **Flow Syntax:** [`QA_FLOWS.json`](./QA_FLOWS.json)
- **Anchor Patterns:** [`QA_ANCHOR_POINTS.json`](./QA_ANCHOR_POINTS.json)

---

## 🎉 Success!

You now have:
- ✅ Standalone QA Agent package
- ✅ Hybrid mode (Prompt + AI fallback)
- ✅ CI/CD integration
- ✅ Docker support
- ✅ Knowledge base that learns

**Next Steps:**
1. Deploy to your CI/CD pipeline
2. Run first test with prompt
3. Monitor knowledge base growth
4. Watch AI costs decrease

Questions? Open an issue or check the examples!
