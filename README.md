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

## Publishing

This repo is published as the `@rondah-ai/qa-agent` npm package to GitHub Packages.

### How It Gets Published

Three things make this work:

1. **`.npmrc`** tells npm that `@rondah-ai` packages live on GitHub Packages:
   ```
   @rondah-ai:registry=https://npm.pkg.github.com
   ```

2. **`package.json`** declares where to publish:
   ```json
   {
     "name": "@rondah-ai/qa-agent",
     "version": "1.0.1",
     "publishConfig": {
       "registry": "https://npm.pkg.github.com"
     },
     "repository": {
       "url": "https://github.com/rondah-ai/opencode"
     }
   }
   ```

3. **`.github/workflows/publish.yml`** automates the publish on every push to `main`:
   - Triggers only when `package.json` is changed
   - Reads the version from `package.json`
   - Checks GitHub Packages to see if that version already exists
   - Skips alpha/beta versions (so you can merge WIP without publishing)
   - Runs `npm publish` using the built-in `GITHUB_TOKEN`

So the full chain is:

```
You push to main (with version bump in package.json)
  → GitHub Actions triggers
    → Checks version isn't already published
      → Runs npm publish
        → Package lands on https://npm.pkg.github.com/@rondah-ai/qa-agent
```

### How to Publish a New Version

**Step 1: Make your changes**

Edit whatever you need in this repo — scripts, tools, browser manager, etc.

**Step 2: Bump the version in `package.json`**

Open `package.json` and change the `"version"` field:

```
"version": "1.0.1"  →  "version": "1.0.2"
```

Pick the right bump:
- **Patch** (1.0.1 → 1.0.2): Bug fix, small tweak to existing behavior
- **Minor** (1.0.1 → 1.1.0): New tool, new runner script, new feature
- **Major** (1.0.1 → 2.0.0): Breaking change — renamed scripts, changed CLI args, removed tools

Or use the npm command to bump it automatically:

```bash
npm version patch   # 1.0.1 → 1.0.2
npm version minor   # 1.0.1 → 1.1.0
npm version major   # 1.0.1 → 2.0.0
```

> `npm version` edits `package.json`, creates a git commit, and tags it — all in one step.

**Step 3: Push to main**

```bash
# If you used npm version (already committed):
git push origin main --tags

# If you bumped manually:
git add -A
git commit -m "release: v1.0.2"
git push origin main
```

**Step 4: Verify the publish**

Go to https://github.com/rondah-ai/opencode/actions and check that the "Publish to GitHub Packages" workflow ran successfully.

You can also verify from the command line:

```bash
npm view @rondah-ai/qa-agent version --registry=https://npm.pkg.github.com
```

**Step 5: Update qa-agent to use the new version**

```bash
cd /path/to/qa-agent
npm install @rondah-ai/qa-agent@1.0.2
# or
npm install @rondah-ai/qa-agent@latest

# Verify
node -p "require('@rondah-ai/qa-agent/package.json').version"

# Test it
./run-flows.sh local smoke

# Commit the lockfile update
git add package.json pnpm-lock.yaml
git commit -m "chore: bump qa-agent to v1.0.2"
git push
```

### Publishing Manually (Fallback)

If GitHub Actions isn't working:

```bash
# 1. Add your GitHub token to ~/.npmrc (needs write:packages scope)
#    Generate at: https://github.com/settings/tokens
echo "//npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN" >> ~/.npmrc

# 2. Bump version in package.json if not already done

# 3. Publish
npm publish

# 4. Verify
npm view @rondah-ai/qa-agent version --registry=https://npm.pkg.github.com
```

### What Gets Published

All files in this repo are included in the package except those in `.gitignore`. Consumers get:

```
node_modules/@rondah-ai/qa-agent/
├── bin/qa-agent.js              ← CLI entry point
├── index.js                     ← Main module entry
├── scripts/                     ← Runner scripts (run-qa-ai-only.cjs, etc.)
├── tools/                       ← 10 tool definitions (.ts + .txt)
├── browser/manager.ts           ← Persistent browser singleton
├── package.json
└── README.md
```

New files you add to the repo are automatically included in the next publish.

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Workflow ran but skipped publish | Version in `package.json` already exists on GitHub Packages | Bump the version number |
| Workflow skipped (pre-release) | Version contains "alpha" or "beta" | Remove the pre-release tag when ready |
| `npm publish` auth failed locally | Missing or expired token in `~/.npmrc` | Generate a new token with `write:packages` scope |
| `npm install @rondah-ai/qa-agent` fails in qa-agent | Consumer repo missing `.npmrc` with registry config | Add `@rondah-ai:registry=https://npm.pkg.github.com` to `.npmrc` and ensure a read token is set |

## Documentation

- QA_ANCHOR_POINTS.json: UI blueprint with selectors
- QA_FLOWS.json: Predefined test flows
- Full docs: https://github.com/rondah-ai/opencode

## License

MIT
