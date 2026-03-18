# QA Agent Package Guide

## Overview

The **opencode** repo builds and publishes the `@rondah-ai/qa-agent` npm package to GitHub Packages. Consumer repos install this package and use it to run automated QA tests against their web apps.

```
opencode/                              consumer-repo/
├── bin/qa-agent.js          ──┐       ├── QA_FEATURE_MODEL.json
├── index.js                   │       ├── QA_RECORDED_FLOWS.json
├── scripts/                   │       ├── .env
│   ├── init.js                │       └── package.json
│   ├── learn.js               ├─ npm ─→   @rondah-ai/qa-agent (devDependency)
│   ├── run-test.js            │
│   ├── run-e2e.js             │
│   ├── migrate.js             │
│   └── generate-pr-comment.js │
├── tools/                    ─┘
└── package.json (@rondah-ai/qa-agent)
```

---

## How the Package Works

### Pipeline

```
1. INIT    → Scans your app, discovers routes, builds QA_FEATURE_MODEL.json
2. LEARN   → Opens browser, you use the app, agent records capabilities + E2E flows
3. TEST    → Health checks every page (landmark-based: h1, data-testid, URL)
4. E2E     → Replays recorded flows end-to-end against a live app
5. HEAL    → Auto-fixes broken selectors when UI changes (--heal flag)
```

### Scripts

| Script | Purpose |
|--------|---------|
| `init.js` | Crawl app, discover routes, build `QA_FEATURE_MODEL.json` |
| `learn.js` | Interactive session — record capabilities and E2E flows |
| `run-test.js` | Health check runner — landmark-based page verification |
| `run-e2e.js` | E2E replay runner — replay recorded flows with auto-healing |
| `migrate.js` | Convert legacy `QA_ANCHOR_POINTS.json` + `QA_FLOWS.json` to new format |
| `generate-pr-comment.js` | Generate GitHub PR comments from test results |

### Entry Point

`bin/qa-agent.js` provides a CLI:

```bash
qa-agent test --url <url> --suite <smoke|full>
```

### Data Files

| File | Created by | Used by | Description |
|------|-----------|---------|-------------|
| `QA_FEATURE_MODEL.json` | init, learn | run-test | Feature map with routes, capabilities, health blocks with landmarks |
| `QA_RECORDED_FLOWS.json` | learn | run-e2e | Recorded E2E flows with actions, selectors, fallbacks, and verify checks |

### Health Checks (Landmark-Based)

`run-test.js` verifies every feature page using deterministic checks:

| Check | What it verifies |
|-------|-----------------|
| `no_js_errors` | No uncaught JavaScript errors |
| `no_console_errors` | No console.error output |
| `no_error_alerts` | No visible error banners/alerts |
| `url_is` | URL matches expected route |
| `landmark_visible` | Page identity element present (h1, data-testid, data-page) |

### E2E Replay

`run-e2e.js` replays recorded flows with multi-layer selector resolution:

```
Primary selector → Fallback selectors → Text-based selector → Fuzzy healing
```

**Fuzzy healing strategies:**

| Strategy | How it finds the element |
|----------|------------------------|
| Tag + text | `button:has-text("Save")` — same tag and visible text |
| Role + text | `[role="button"]:has-text("Save")` — ARIA role with text |
| Aria-label | Extracts aria-label from broken selector |
| Field name | For inputs: matches by placeholder, name, or aria-label |
| Href / data-testid | Partial match on href or data-testid prefix |

The `--heal` flag writes working selectors back to `QA_RECORDED_FLOWS.json` so the next run uses them directly.

### Environment Variables

All scripts auto-load a `.env` file from the working directory. No external `dotenv` dependency needed.

| Variable | Required By | Purpose |
|----------|------------|---------|
| `TEST_EMAIL` | All scripts | Test account email |
| `TEST_PASSWORD` | All scripts | Test account password |
| `QA_PREVIEW_URL` | CLI / CI | Target URL (alternative to `--url`) |

Credentials in `.env` are also used for E2E flow parameterization — email and password values are automatically replaced with `$EMAIL` and `$PASSWORD` in recorded flows so they work across environments.

---

## How Consumer Repos Use the Package

### Setup

```bash
# 1. Install the package
npm install @rondah-ai/qa-agent --save-dev

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Create .env
echo 'TEST_EMAIL="test@example.com"' >> .env
echo 'TEST_PASSWORD="secret"' >> .env
echo 'QA_PREVIEW_URL="http://localhost:3000"' >> .env
```

### Daily Workflow

```bash
# Initialize — scan app and build feature model (one-time or after major changes)
node node_modules/@rondah-ai/qa-agent/scripts/init.js

# Learn — record capabilities and E2E flows interactively
node node_modules/@rondah-ai/qa-agent/scripts/learn.js

# Health check — verify every page loads correctly
node node_modules/@rondah-ai/qa-agent/scripts/run-test.js --suite smoke

# E2E replay — replay recorded flows
node node_modules/@rondah-ai/qa-agent/scripts/run-e2e.js

# Auto-heal — fix broken selectors after UI changes
node node_modules/@rondah-ai/qa-agent/scripts/run-e2e.js --heal
```

### CI/CD Integration

```yaml
- name: Run Health Checks
  run: |
    node node_modules/@rondah-ai/qa-agent/scripts/run-test.js \
      --url "$QA_PREVIEW_URL" --suite smoke

- name: Run E2E Flows
  run: |
    node node_modules/@rondah-ai/qa-agent/scripts/run-e2e.js \
      --url "$QA_PREVIEW_URL" --heal
```

---

## Publishing a New Version

### Prerequisites

- Push access to the `rondah-ai/opencode` GitHub repo
- The repo has `.npmrc` configured to point to GitHub Packages:
  ```
  @rondah-ai:registry=https://npm.pkg.github.com
  ```
- The GitHub Actions workflow (`.github/workflows/publish.yml`) handles publishing automatically — you do NOT run `npm publish` yourself

### How Publishing Works

The workflow triggers on every push to `main` that includes a change to `package.json`. It then:

1. Reads the `name` and `version` from `package.json`
2. Skips if the version contains "alpha" or "beta"
3. Checks if that exact version is already published on GitHub Packages
4. If not published yet, runs `npm publish` using the repo's `GITHUB_TOKEN`

So the only thing you need to do is **bump the version in `package.json` and push to `main`**.

### Step-by-Step: Publish a New Version

```bash
# 1. cd into the opencode repo
cd /path/to/Planning/opencode

# 2. Make your changes (edit scripts, etc.)

# 3. Bump version
npm version patch   # bug fix: 1.0.1 → 1.0.2
npm version minor   # new feature: 1.0.2 → 1.1.0
npm version major   # breaking change: 1.1.0 → 2.0.0

# 4. Push to main (npm version already committed + tagged)
git push origin main --tags

# 5. Done. Check https://github.com/rondah-ai/opencode/actions
```

### Step-by-Step: Update Consumer Repo

```bash
# 1. cd into the consumer repo
cd /path/to/your-repo

# 2. Update the dependency
npm install @rondah-ai/qa-agent@latest

# 3. Verify
cat node_modules/@rondah-ai/qa-agent/package.json | grep version

# 4. Commit
git add package.json package-lock.json
git commit -m "chore: bump qa-agent to latest"
git push
```

### Manual Publishing (Fallback)

If GitHub Actions isn't working or you need to publish from your machine:

```bash
cd /path/to/Planning/opencode

# Make sure ~/.npmrc has your GitHub token:
#   @rondah-ai:registry=https://npm.pkg.github.com
#   //npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN_HERE
#   (token needs "write:packages" scope)

npm publish

# Verify
npm view @rondah-ai/qa-agent versions --registry=https://npm.pkg.github.com
```

### What Gets Published

Everything in the opencode repo root is included EXCEPT what's in `.gitignore`:

```
bin/qa-agent.js              ← CLI entry point
index.js                     ← Main module entry
scripts/
├── init.js                  ← Feature model generator
├── learn.js                 ← Interactive learning + E2E recording
├── migrate.js               ← Legacy file migration
├── run-test.js              ← Health check runner
├── run-e2e.js               ← E2E replay runner (with auto-healing)
└── generate-pr-comment.js   ← PR comment generator
tools/                       ← Tool definitions
package.json
README.md
```

### Version Strategy

| Change | Version Bump | Example |
|--------|-------------|---------|
| Bug fix in a script | `patch` | 1.0.1 → 1.0.2 |
| New script or feature added | `minor` | 1.0.2 → 1.1.0 |
| Breaking change to CLI args or data format | `major` | 1.1.0 → 2.0.0 |
| Work in progress | Add "beta" to version | 1.0.2-beta.0 (skipped by workflow) |

### Troubleshooting

**"Version already published"** — Bump the version number. The workflow skips if the version already exists.

**"Authentication failed"** — In CI, `GITHUB_TOKEN` is automatic. For local publishing, `~/.npmrc` needs a valid token with `write:packages` scope.

**"Pre-release skipped"** — Intentional. Versions with "alpha" or "beta" are not published by the workflow.

**"Package not found when installing"** — The consuming repo needs `.npmrc` with `@rondah-ai:registry=https://npm.pkg.github.com` and a valid read token.

---

## Dependencies

### opencode (the package)

```json
{
  "playwright": "^1.57.0",
  "zod": "^4.1.8"
}
```

Note: `@anthropic-ai/sdk` is listed but not used by the current scripts. It may be removed in a future version.
