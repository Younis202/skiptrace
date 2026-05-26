---
name: Playwright esbuild externals
description: playwright-extra and stealth plugin must be externalized in esbuild or runtime crashes
---

Add these to the `external` array in `artifacts/api-server/build.mjs`:
- `"playwright-extra"`
- `"puppeteer-extra"`
- `"puppeteer-extra-plugin-stealth"`

**Why:** These packages have legacy CJS transitive deps (kind-of, is-plain-object, clone-deep) that esbuild can't bundle correctly into ESM. The runtime crashes with MODULE_NOT_FOUND for those deps.

**How to apply:** Any time a new playwright-extra plugin or puppeteer-extra plugin is installed, add it to the external list before building.
