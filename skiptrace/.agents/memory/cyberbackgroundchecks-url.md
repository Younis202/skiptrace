---
name: CyberBackgroundChecks URL format
description: Correct URL structure for address-based skip tracing on cyberbackgroundchecks.com
---

**Primary URL (address page):**
`https://www.cyberbackgroundchecks.com/address/{street-slug}/{city-slug}/{state-slug}/`

Example: `206 Ferrell Ave, Union City, CA` → `/address/206-ferrell-ave/union-city/ca/`

Slugify rule: lowercase, strip non-alphanumeric except spaces/hyphens, spaces → hyphens.

**Why:** The /address/ endpoint shows all residents at that address. Match by name among residents, then click through to the profile to extract phones.

**Fallback:** `/people/search/?fname=...&lname=...&city=...&state=...` — use when address lookup returns no resident links.

**Cloudflare detection:** Check `page.title()` for "just a moment" or "cloudflare" after navigation. If detected, throw an error so the retry system rotates to a fresh proxy+browser.
