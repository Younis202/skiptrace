import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { eq, and, inArray } from "drizzle-orm";
import { db, skipTraceJobsTable, skipTraceResultsTable } from "@workspace/db";
import { logger } from "./logger";
import { getNextProxy, markProxySuccess, markProxyFail } from "./proxyManager";

chromium.use(StealthPlugin());

const CYBER_BASE = "https://www.cyberbackgroundchecks.com";
const ADDRESS_PAGE = `${CYBER_BASE}/address`;
const MAX_RETRIES = 3;
const MAX_PAGES = 5; // max pagination pages to check per search

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1366,768",
  "--disable-blink-features=AutomationControlled",
];

const STEALTH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const cancelledJobs = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 1200, max = 3000) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

function randomTypingDelay() {
  return sleep(Math.floor(Math.random() * 80) + 40);
}

/** Type into a field character by character to look human */
async function humanType(page: import("playwright").Page, selector: string, text: string) {
  await page.click(selector);
  await page.fill(selector, "");
  for (const char of text) {
    await page.type(selector, char, { delay: Math.floor(Math.random() * 80) + 30 });
    await randomTypingDelay();
  }
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  if (cancelledJobs.has(jobId)) return true;
  const [job] = await db
    .select({ status: skipTraceJobsTable.status })
    .from(skipTraceJobsTable)
    .where(eq(skipTraceJobsTable.jobId, jobId));
  if (job?.status === "cancelled") {
    cancelledJobs.add(jobId);
    return true;
  }
  return false;
}

/** Check page for Cloudflare challenge */
async function isCloudflareBlocked(page: import("playwright").Page): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  const url = page.url().toLowerCase();
  return (
    title.includes("just a moment") ||
    title.includes("cloudflare") ||
    url.includes("challenge") ||
    url.includes("captcha")
  );
}

/**
 * Wait for Cloudflare to auto-clear (stealth plugin often passes it silently).
 * Returns true if cleared, false if still blocked after timeout.
 */
async function waitForCloudflare(page: import("playwright").Page, timeoutMs = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const blocked = await isCloudflareBlocked(page);
    if (!blocked) return true;
    await sleep(1500);
  }
  return !(await isCloudflareBlocked(page));
}

/** Convert an address component to a URL slug (lowercase, spaces → hyphens, drop special chars) */
function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Normalize name for comparison.
 * Handles "Christopher R Mcmanus" vs "Christopher McManus"
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, "").trim();
}

function nameMatches(resultTitle: string, firstName: string, lastName: string): boolean {
  const title = normalizeName(resultTitle);

  // Use ONLY the first word of firstName — handles "John C. Smith" vs "John Smith"
  // and also handles cases where firstName contains the full name e.g. "John Smith"
  const firstWord = normalizeName(firstName).split(/\s+/)[0] || "";
  const lastWord = normalizeName(lastName).split(/\s+/)[0] || "";

  // Primary: match by first name only (even a single char is useful for rare names)
  if (firstWord.length >= 2 && title.includes(firstWord)) return true;

  // Fallback: no first name supplied → use last name only
  if (!firstWord && lastWord.length >= 3 && title.includes(lastWord)) return true;

  return false;
}

/**
 * Extract phone numbers from the profile detail page.
 * Targets `a.phone` elements which are the canonical phone links on cyberbackgroundchecks.com
 */
async function extractPhonesFromDetailPage(page: import("playwright").Page): Promise<string[]> {
  // Primary: a.phone elements (exact match from the site's HTML)
  const phones = await page.$$eval("a.phone", (els) =>
    els.map((el) => el.textContent?.trim() || "").filter(Boolean)
  );

  if (phones.length > 0) return [...new Set(phones)];

  // Fallback: tel: links
  const telLinks = await page.$$eval("a[href^='tel:']", (els) =>
    els.map((el) => el.getAttribute("href")?.replace("tel:", "").trim() || "").filter(Boolean)
  );

  if (telLinks.length > 0) return [...new Set(telLinks)];

  // Last resort: regex in page content
  const html = await page.content();
  const regex = /\(\d{3}\)\s?\d{3}[-\s]\d{4}/g;
  const matches = html.match(regex) || [];
  return [...new Set(matches)].slice(0, 8);
}

/**
 * Search cyberbackgroundchecks.com/address using the actual search form.
 * Fills in street + "City, State", clicks search, then matches name across paginated results.
 * Returns phone numbers found.
 */
async function searchViaForm(
  page: import("playwright").Page,
  address: string,
  city: string,
  state: string,
  firstName: string,
  lastName: string
): Promise<string[]> {
  // ── Step 1: Try direct URL first, then fallback to form ──────────────────
  // Build slug URL: /address/206-ferrell-ave/union-city/ca/
  const streetSlug = toSlug(address.replace(/\s*#.*$/, "").replace(/\s*apt.*$/i, "").trim());
  const citySlug = toSlug(city);
  const stateSlug = toSlug(state);
  const directUrl = `${CYBER_BASE}/address/${streetSlug}/${citySlug}/${stateSlug}/`;

  logger.debug({ directUrl, address, city, state }, "Navigating via direct URL");
  await page.goto(directUrl, { waitUntil: "networkidle", timeout: 35000 });
  await randomDelay(800, 1500);

  // Wait up to 25s for Cloudflare to auto-clear (stealth plugin handles it)
  if (await isCloudflareBlocked(page)) {
    logger.debug({ directUrl }, "Cloudflare detected — waiting for auto-clear...");
    const cleared = await waitForCloudflare(page, 25000);
    if (!cleared) {
      // Fallback: try the form-based search page instead
      logger.debug({ address }, "Cloudflare persists — trying form search page");
      await page.goto(ADDRESS_PAGE, { waitUntil: "networkidle", timeout: 35000 });
      await randomDelay(800, 1800);
      const formCleared = await waitForCloudflare(page, 20000);
      if (!formCleared) {
        throw new Error("Cloudflare challenge on address page");
      }
      // ── Form search path ────────────────────────────────────────────────
      const streetSelector = "#SearchCriteriaViewModel_AddressLine1";
      await page.waitForSelector(streetSelector, { timeout: 10000 });
      await humanType(page, streetSelector, address);
      await randomDelay(300, 700);
      const cityStateSelector = "#SearchByAddress_AddressLine2";
      await page.waitForSelector(cityStateSelector, { timeout: 10000 });
      const cityState = state ? `${city}, ${state}` : city;
      await humanType(page, cityStateSelector, cityState);
      await randomDelay(400, 800);
      const searchBtn = "#button-search-by-address";
      await page.waitForSelector(searchBtn, { timeout: 10000 });
      await page.click(searchBtn);
      await randomDelay(2000, 4000);
      if (await isCloudflareBlocked(page)) {
        throw new Error("Cloudflare challenge after form search");
      }
    }
  }

  // Check if direct URL gave us results or a no-results page
  // If we're NOT on an address result page, fall through to form-based search
  const onResultsPage = !!(await page.$("a.btn-primary.btn-block, a.btn.btn-primary.btn-block, .no-record-found"));
  if (!onResultsPage) {
    // Direct URL didn't work — try form
    logger.debug({ address }, "Direct URL gave no results — trying form search");
    await page.goto(ADDRESS_PAGE, { waitUntil: "networkidle", timeout: 35000 });
    await randomDelay(800, 1800);
    await waitForCloudflare(page, 20000);
    if (await isCloudflareBlocked(page)) throw new Error("Cloudflare challenge on form page");

    const streetSelector = "#SearchCriteriaViewModel_AddressLine1";
    await page.waitForSelector(streetSelector, { timeout: 10000 });
    await humanType(page, streetSelector, address);
    await randomDelay(300, 700);
    const cityStateSelector = "#SearchByAddress_AddressLine2";
    await page.waitForSelector(cityStateSelector, { timeout: 10000 });
    const cityState = state ? `${city}, ${state}` : city;
    await humanType(page, cityStateSelector, cityState);
    await randomDelay(400, 800);
    const searchBtn = "#button-search-by-address";
    await page.waitForSelector(searchBtn, { timeout: 10000 });
    await page.click(searchBtn);
    await randomDelay(2000, 4000);
    if (await isCloudflareBlocked(page)) throw new Error("Cloudflare challenge after form search");
  }
  // -- Below this point, we are on the results page --

  // ── Step 2: Paginate through results looking for name match ───────────────
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    logger.debug({ address, pageNum, firstName, lastName }, "Scanning results page");

    // Check if we even have results
    const hasResults = await page.$("a.btn-primary.btn-block, a.btn.btn-primary.btn-block");
    if (!hasResults) {
      logger.debug({ address }, "No results found on page");
      return [];
    }

    // Get all VIEW DETAILS links with their title attributes for name matching
    const resultCards = await page.$$eval(
      "a.btn-primary.btn-block, a.btn.btn-primary.btn-block",
      (els) =>
        els.map((el) => ({
          href: el.getAttribute("href") || "",
          title: el.getAttribute("title") || "",
          text: el.textContent?.trim() || "",
        }))
    );

    // Find the best match
    let matchedHref: string | null = null;

    if (firstName || lastName) {
      // Try exact name match first
      const exactMatch = resultCards.find((c) =>
        nameMatches(c.title, firstName, lastName)
      );
      if (exactMatch) {
        matchedHref = exactMatch.href;
        logger.debug({ matchedTitle: exactMatch.title, firstName, lastName }, "Name match found");
      }
    }

    // If no name given, or no name match found on this page, check next page first
    if (!matchedHref) {
      // Check if there's a next page
      const nextLink = await page.$("a[aria-label='Next Page'], a[aria-label='Next page']");

      if (nextLink && pageNum < MAX_PAGES) {
        const nextHref = await nextLink.getAttribute("href");
        if (nextHref) {
          const nextUrl = nextHref.startsWith("http") ? nextHref : `${CYBER_BASE}${nextHref}`;
          await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await randomDelay(1500, 3000);

          if (await isCloudflareBlocked(page)) {
            const cleared = await waitForCloudflare(page, 20000);
            if (!cleared) throw new Error("Cloudflare challenge on pagination");
          }
          continue; // try next page
        }
      }

      // No more pages — if we still haven't found a match, take the first result
      if (resultCards.length > 0 && (!firstName && !lastName)) {
        matchedHref = resultCards[0].href;
        logger.debug({ href: matchedHref }, "No name to match — using first result");
      } else {
        logger.debug({ address, firstName, lastName }, "Name not found in any results page");
        return [];
      }
    }

    if (!matchedHref) return [];

    // ── Step 6: Navigate to the profile detail page ────────────────────────
    const detailUrl = matchedHref.startsWith("http")
      ? matchedHref
      : `${CYBER_BASE}${matchedHref}`;

    logger.debug({ detailUrl }, "Navigating to profile detail page");
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(1000, 2500);

    if (await isCloudflareBlocked(page)) {
      const cleared = await waitForCloudflare(page, 20000);
      if (!cleared) throw new Error("Cloudflare challenge on detail page");
    }

    // ── Step 7: Extract phones ─────────────────────────────────────────────
    const phones = await extractPhonesFromDetailPage(page);
    logger.debug({ detailUrl, phonesFound: phones.length }, "Phones extracted");
    return phones;
  }

  return [];
}

/** Detect if an error is caused by a dead/unreachable proxy */
function isProxyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
    msg.includes("ERR_PROXY_CONNECTION_FAILED") ||
    msg.includes("ERR_SOCKS_CONNECTION_FAILED") ||
    msg.includes("ERR_CONNECTION_REFUSED") ||
    msg.includes("ERR_CONNECTION_RESET") ||
    msg.includes("ERR_TIMED_OUT") ||
    msg.includes("ERR_NAME_NOT_RESOLVED") ||
    msg.includes("ERR_ADDRESS_UNREACHABLE") ||
    msg.includes("net::ERR_") ||
    msg.includes("socket hang up") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT")
  );
}

/** Build a fresh browser + page. Tries up to MAX_PROXY_ATTEMPTS proxies before falling back to direct. */
const MAX_PROXY_ATTEMPTS = 8;

async function launchBrowserWithFallback(): Promise<{
  browser: import("playwright").Browser;
  page: import("playwright").Page;
  usedProxy: ProxyConfig | null;
}> {
  // Try multiple proxies, then fall back to direct connection
  const triedProxies = new Set<string>();

  for (let attempt = 0; attempt <= MAX_PROXY_ATTEMPTS; attempt++) {
    const isDirect = attempt === MAX_PROXY_ATTEMPTS;
    let proxy: ProxyConfig | null = null;

    if (!isDirect) {
      proxy = await getNextProxy();
      // Skip proxies we already tried in this launch sequence
      if (proxy && triedProxies.has(proxy.id)) {
        continue;
      }
      if (proxy) triedProxies.add(proxy.id);
    }

    const proxyConfig = proxy
      ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } }
      : {};

    logger.debug(
      { server: proxy?.server ?? "direct", attempt },
      "launchBrowser attempt"
    );

    let browser: import("playwright").Browser | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        args: BROWSER_ARGS,
        ...proxyConfig,
      });

      const context = await browser.newContext({
        userAgent: STEALTH_UA,
        viewport: { width: 1366, height: 768 },
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
      });

      const page = await context.newPage();

      // Warm-up visit so cookies/session are established
      // Use networkidle so Cloudflare JS challenge can execute and auto-clear
      await page.goto(CYBER_BASE, { waitUntil: "networkidle", timeout: 35000 });

      // Wait for Cloudflare challenge to auto-clear on homepage (stealth plugin handles it)
      await waitForCloudflare(page, 20000);

      // Simulate human browsing: scroll down then up
      await page.evaluate(() => {
        window.scrollTo({ top: 400, behavior: "smooth" });
      });
      await randomDelay(1000, 2000);
      await page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      await randomDelay(2000, 4000);

      logger.info(
        { server: proxy?.server ?? "direct", attempt },
        "Browser launched successfully"
      );
      return { browser, page, usedProxy: proxy };
    } catch (err) {
      // Close browser if it was opened
      if (browser) await browser.close().catch(() => {});

      const isProxy = isProxyError(err);
      const errMsg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      if (proxy && isProxy) {
        // Mark this proxy as failed and move on
        await markProxyFail(proxy.id, errMsg);
        logger.warn({ server: proxy.server, attempt, err: errMsg }, "Proxy failed — trying next");
        continue;
      }

      // Non-proxy error (Cloudflare, site issue) or we're on direct and it failed
      if (isDirect) {
        logger.error({ err: errMsg, attempt }, "Direct connection also failed — giving up");
        throw err;
      }

      // Unknown error on a proxy attempt — still try next
      if (proxy) await markProxyFail(proxy.id, errMsg);
      logger.warn({ server: proxy?.server ?? "direct", attempt, err: errMsg }, "Launch error — trying next proxy");
    }
  }

  throw new Error("Could not launch browser after all proxy attempts");
}

/** Process a list of rows, updating DB as we go. Returns updated foundCount. */
async function processRows(
  page: import("playwright").Page,
  rows: (typeof skipTraceResultsTable.$inferSelect)[],
  jobId: string,
  proxy: { id: string; server: string; username?: string; password?: string } | null,
  counters: { processed: number; found: number },
  getBrowser: () => import("playwright").Browser | null,
  setBrowserAndPage: (b: import("playwright").Browser, p: import("playwright").Page) => void
): Promise<void> {
  let activePage = page;
  let consecutiveErrors = 0;

  const syncDB = async () => {
    await db
      .update(skipTraceJobsTable)
      .set({ processedRows: counters.processed, foundCount: counters.found, updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));
  };

  for (const row of rows) {
    if (await isJobCancelled(jobId)) break;

    // Mark as processing
    await db.update(skipTraceResultsTable)
      .set({ status: "processing" })
      .where(eq(skipTraceResultsTable.id, row.id));

    let phones: string[] = [];
    let status = "not_found";
    let error: string | undefined;

    try {
      phones = await searchViaForm(
        activePage,
        row.address,
        row.city,
        row.state,
        row.firstName,
        row.lastName
      );

      if (phones.length > 0) {
        status = "found";
        counters.found++;
      } else {
        status = "not_found";
      }

      consecutiveErrors = 0;
      if (proxy) await markProxySuccess(proxy.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, jobId, rowIndex: row.rowIndex }, "Row error");
      status = "error";
      error = errMsg.slice(0, 300);
      consecutiveErrors++;

      if (proxy) await markProxyFail(proxy.id, errMsg);

      // Cool-down after error
      try {
        await activePage.goto(CYBER_BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
        await randomDelay(4000, 8000);
      } catch { /* ignore */ }

      // Rotate browser after 3 consecutive errors
      if (consecutiveErrors >= 3) {
        logger.info({ jobId }, "3 consecutive errors — rotating browser + proxy");
        getBrowser()?.close().catch(() => {});

        try {
          const { browser: nb, page: np, usedProxy: newProxy } = await launchBrowserWithFallback();
          setBrowserAndPage(nb, np);
          activePage = np;
          proxy = newProxy;
          consecutiveErrors = 0;
          logger.info({ jobId, server: newProxy?.server ?? "direct" }, "Browser rotated");
        } catch (launchErr) {
          logger.error({ launchErr }, "Browser rotation failed");
        }
      }
    }

    await db.update(skipTraceResultsTable)
      .set({ phones, status, error: error ?? null, retryCount: row.retryCount })
      .where(eq(skipTraceResultsTable.id, row.id));

    counters.processed++;
    await syncDB();

    // Random inter-request delay — looks human, avoids rate limiting
    await randomDelay(2500, 6000);
  }
}

export async function runSkipTrace(jobId: string) {
  let browser: import("playwright").Browser | null = null;

  const getBrowser = () => browser;
  const setBrowserAndPage = (b: import("playwright").Browser, p: import("playwright").Page) => {
    browser = b;
  };

  try {
    await db.update(skipTraceJobsTable)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    const allRows = await db.select().from(skipTraceResultsTable)
      .where(eq(skipTraceResultsTable.jobId, jobId))
      .orderBy(skipTraceResultsTable.rowIndex);

    if (allRows.length === 0) {
      await db.update(skipTraceJobsTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
      return;
    }

    const counters = { processed: 0, found: 0 };

    // ── PASS 1: All rows ───────────────────────────────────────────────────
    logger.info({ jobId, rows: allRows.length }, "Skip trace pass 1 starting");

    const { browser: b1, page: p1, usedProxy: proxy1 } = await launchBrowserWithFallback();
    let proxy = proxy1;
    browser = b1;

    await processRows(p1, allRows, jobId, proxy, counters, getBrowser, (nb, np) => {
      browser = nb;
    });

    if (await isJobCancelled(jobId)) {
      await db.update(skipTraceJobsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
      return;
    }

    // ── SMART RETRY PASSES ─────────────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const failedRows = await db.select().from(skipTraceResultsTable)
        .where(and(
          eq(skipTraceResultsTable.jobId, jobId),
          eq(skipTraceResultsTable.status, "error")
        ))
        .orderBy(skipTraceResultsTable.rowIndex);

      const toRetry = failedRows.filter((r) => r.retryCount < MAX_RETRIES);
      if (toRetry.length === 0) break;

      logger.info({ jobId, attempt, count: toRetry.length }, "Smart retry pass");

      // Bump retryCount, reset to pending
      for (const row of toRetry) {
        await db.update(skipTraceResultsTable)
          .set({ retryCount: row.retryCount + 1, status: "pending" })
          .where(eq(skipTraceResultsTable.id, row.id));
      }

      // Fresh browser + new proxy for retry
      await browser?.close().catch(() => {});
      const { browser: rb, page: rp, usedProxy: retryProxy } = await launchBrowserWithFallback();
      browser = rb;

      const retryRows = await db.select().from(skipTraceResultsTable)
        .where(inArray(skipTraceResultsTable.id, toRetry.map((r) => r.id)))
        .orderBy(skipTraceResultsTable.rowIndex);

      await processRows(rp, retryRows, jobId, retryProxy, counters, getBrowser, (nb) => {
        browser = nb;
      });

      if (await isJobCancelled(jobId)) {
        await db.update(skipTraceJobsTable)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(skipTraceJobsTable.jobId, jobId));
        return;
      }

      await randomDelay(5000, 10000);
    }

    await db.update(skipTraceJobsTable)
      .set({ status: "completed", processedRows: counters.processed, foundCount: counters.found, updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    logger.info({ jobId, processed: counters.processed, found: counters.found }, "Skip trace completed");
  } catch (err) {
    logger.error({ err, jobId }, "Skip trace crashed");
    await db.update(skipTraceJobsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId))
      .catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    cancelledJobs.delete(jobId);
  }
}
