# QA Agent

Automated testing agent with blueprint-based testing for web applications.

## Installation

### Via npm (GitHub Packages)

```bash
npm install @rondah-ai/qa-agent --save-dev
```

### Via Direct Copy

Copy the entire `qa-agent/` directory to your repository:

```bash
cp -r qa-agent /path/to/your-repo/.qa-agent
cd /path/to/your-repo/.qa-agent
npm install
```

## Usage

### Command Line

```bash
# Run smoke tests
npx qa-agent test --url https://preview.example.com --suite smoke

# Run with custom configuration
npx qa-agent test \
  --url https://preview.example.com \
  --anchor-points ./QA_ANCHOR_POINTS.json \
  --flows ./QA_FLOWS.json \
  --suite regression
```

### GitHub Actions

```yaml
name: QA Tests

on:
  pull_request:
    types: [opened, synchronize]

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
        run: npm install @rondah-ai/qa-agent --save-dev

      - name: Install Playwright
        run: npx playwright install --with-deps chromium

      - name: Run Tests
        env:
          PREVIEW_URL: ${{ env.PREVIEW_URL }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
        run: |
          npx qa-agent test \
            --url "$PREVIEW_URL" \
            --anchor-points ./QA_ANCHOR_POINTS.json \
            --flows ./QA_FLOWS.json \
            --suite smoke
```

## Test Suites

- **smoke**: Fast validation (4-5 critical flows, ~15-20s)
- **regression**: Comprehensive testing (all flows, ~2-3min)
- **critical**: Essential flows only (critical priority, ~20-30s)

## Configuration Files

### QA_ANCHOR_POINTS.json

Defines UI element selectors and patterns:

```json
{
  "routes": {
    "login": "/login",
    "dashboard": "/dashboard"
  },
  "commonPatterns": {
    "button": {
      "primary": "button.btn-primary",
      "submit": "button[type='submit']"
    }
  }
}
```

### QA_FLOWS.json

Defines test flows:

```json
{
  "flows": {
    "authentication": {
      "login": {
        "name": "User Login",
        "priority": "critical",
        "steps": [...]
      }
    }
  }
}
```

## Environment Variables

- `QA_PREVIEW_URL`: Target URL to test
- `TEST_EMAIL`: Test account email
- `TEST_PASSWORD`: Test account password
- `QA_ANCHOR_POINTS`: Path to anchor points file
- `QA_FLOWS`: Path to flows file

## Output

Results are saved to:
- `qa-results/summary.json`: Test results summary
- `qa-results/report.html`: HTML report
- `.opencode/screenshots/`: Test screenshots

## Documentation

- QA_ANCHOR_POINTS.json: UI blueprint with selectors
- QA_FLOWS.json: Predefined test flows
- Full docs: https://github.com/rondah-ai/opencode

## License

MIT
