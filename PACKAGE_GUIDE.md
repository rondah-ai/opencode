# Package Management Guide

How to publish, update, and manage the `@rondah-ai/rondar` npm package.

---

## Overview

- **Package name:** `@rondah-ai/rondar`
- **Registry:** [npmjs.com](https://www.npmjs.com/package/@rondah-ai/rondar) (public)
- **Org:** `rondah-ai` on npm
- **Auto-publish:** GitHub Actions on every push to `main` that changes `package.json`

---

## One-time Setup (already done)

This section documents what was configured. You don't need to redo it.

1. Created `rondah-ai` organization on npmjs.com
2. Generated a **Granular Access Token** with:
   - Scope: `@rondah-ai`
   - Permission: Read and write
   - Bypass 2FA: enabled
3. Added the token as `NPM_TOKEN` secret in GitHub repo settings
4. Configured `package.json` with:
   ```json
   "publishConfig": {
     "registry": "https://registry.npmjs.org",
     "access": "public"
   }
   ```
5. Workflow at `.github/workflows/publish.yml` triggers on push to `main`

---

## Publishing Updates (Recommended Flow)

The standard flow uses GitHub Actions — no local publish needed.

### 1. Make your changes on a feature branch

```bash
git checkout -b feature/my-change
# ... edit code ...
git commit -am "Description of change"
```

### 2. Bump the version

Choose the right bump based on the change:

| Change type | Command | Example |
|-------------|---------|---------|
| Bug fix, no API change | `npm version patch` | 2.9.0 → 2.9.1 |
| New feature, backward compatible | `npm version minor` | 2.9.0 → 2.10.0 |
| Breaking change | `npm version major` | 2.9.0 → 3.0.0 |

This updates `package.json` and creates a git tag automatically.

### 3. Open a PR and merge to `main`

```bash
git push origin feature/my-change
git push --tags
# Open PR on GitHub, get review, merge to main
```

### 4. GitHub Actions auto-publishes

Once merged to `main`, the workflow:
- Detects the `package.json` change
- Checks if the version is already published (skips if yes)
- Skips alpha/beta versions
- Publishes to npm

**Watch the run:** Go to repo → **Actions** tab → look for "Publish to GitHub Packages"

### 5. Verify the publish

```bash
npm view @rondah-ai/rondar version
```

Or check [npmjs.com/package/@rondah-ai/rondar](https://www.npmjs.com/package/@rondah-ai/rondar).

---

## Manual Publish (Emergency Only)

If you need to publish locally — for example, the workflow is broken and you need to ship an urgent fix.

### Prerequisites

- You're logged in as a user who is an **owner** of the `rondah-ai` org
- You have an OTP from your authenticator app, OR a granular token with bypass 2FA

### Steps

```bash
# 1. Move the project .npmrc out of the way
#    (it overrides local credentials with an empty NPM_TOKEN)
mv .npmrc .npmrc.bak

# 2. Log in
npm login

# 3. Verify
npm whoami
npm org ls rondah-ai

# 4. Bump version
npm version patch   # or minor, or major

# 5. Publish
npm publish --access public --otp=123456
#                            ^^^^^^^^^^^ from your authenticator app

# 6. Restore the .npmrc
mv .npmrc.bak .npmrc

# 7. Push the version commit and tag
git push && git push --tags
```

---

## Versioning Rules (Semantic Versioning)

Follow semver to keep installs predictable for users.

- **MAJOR (X.0.0)** — Breaking changes. Renamed CLI commands, removed flags, changed file formats users depend on.
- **MINOR (X.Y.0)** — New features that don't break anything. New CLI subcommands, new optional flags, new fields in output JSON.
- **PATCH (X.Y.Z)** — Bug fixes only. No new features, no breaking changes.

**Pre-release versions** — append `-alpha.N` or `-beta.N`. The workflow skips publishing these automatically.

```bash
npm version 3.0.0-beta.1
```

---

## Common Tasks

### Check who can publish

```bash
npm org ls rondah-ai
```

### Rotate the npm token

1. Go to [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens)
2. Revoke the old token
3. Generate a new granular token (same settings as initial setup)
4. Update `NPM_TOKEN` secret in GitHub: repo → Settings → Secrets → Actions

### Add a new maintainer

1. They create an npm account
2. Go to [npmjs.com/settings/rondah-ai/members](https://www.npmjs.com/settings/rondah-ai/members)
3. Invite them with **owner** role (members can't publish new packages)

### Unpublish a version

npm allows unpublishing only within 72 hours of publish.

```bash
npm unpublish @rondah-ai/rondar@2.9.0
```

After 72 hours, deprecate instead:

```bash
npm deprecate @rondah-ai/rondar@2.9.0 "Use 2.9.1 — fixes critical bug"
```

### See what files get published

Before publishing, dry-run to see the tarball contents:

```bash
npm publish --dry-run
```

To exclude files from the published package, add patterns to `.npmignore` or use the `files` field in `package.json`.

---

## Troubleshooting

### `E401 Unauthorized`

You're not logged in, or the token is invalid.

- Check `npm whoami`
- If running locally, the project `.npmrc` may be overriding your credentials with an empty `NPM_TOKEN`. Move it aside temporarily.

### `E403 Forbidden — 2FA required`

Your token doesn't have "bypass 2FA" enabled, or you're not providing an OTP.

- Add `--otp=123456` to the publish command, OR
- Regenerate the token with bypass 2FA enabled

### `E404 Not Found` on publish

Usually one of:

- You're not authenticated (check `npm whoami`)
- You're not an **owner** of the `rondah-ai` org (members can't publish new packages)
- The package name is wrong

### Workflow runs but doesn't publish

- Check the workflow logs in the Actions tab
- The workflow only triggers when `package.json` is in the changed files
- It skips versions that are already published — bump the version

### `npm view` returns 404 right after publish

Registry CDN propagation can take 1–5 minutes. Check the package page in the browser:
[npmjs.com/package/@rondah-ai/rondar](https://www.npmjs.com/package/@rondah-ai/rondar)

---

## Files Reference

| File | Purpose |
|------|---------|
| `package.json` | Package metadata, version, dependencies |
| `.npmrc` | CI auth config (uses `${NPM_TOKEN}` env var) |
| `.npmignore` | Files to exclude from published tarball |
| `.github/workflows/publish.yml` | Auto-publish workflow |

---

## Quick Reference

```bash
# Bump and ship a patch (most common)
npm version patch
git push && git push --tags
# → merge PR to main → workflow publishes automatically

# Check published version
npm view @rondah-ai/rondar version

# List all published versions
npm view @rondah-ai/rondar versions

# Install latest
npm install @rondah-ai/rondar

# Install specific version
npm install @rondah-ai/rondar@2.9.0
```
