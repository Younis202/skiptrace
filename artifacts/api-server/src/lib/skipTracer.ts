import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { eq, and, inArray } from "drizzle-orm";
import { db, skipTraceJobsTable, skipTraceResultsTable } from "@workspace/db";
import { logger } from "./logger";
import { getNextProxy, markProxySuccess, markProxyFail } from "./proxyManager";

chromium.use(StealthPlugin());

const CYBER_BASE = "https://www.cyberbackgroundchecks.com";
const MAX_RETRIES = 3;
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1920,1080",
  "--disable-blink-features=AutomationControlled",
];
const STEALTH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const cancelledJobs = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomDelay(min = 1500, max = 3500) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

/** Slugify an address part for the /address/ URL path */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
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

async function extractPhones(page: import("playwright").Page): Promise<string[]> {
  // Try structured phone elements first
  const structured = await page.$$eval(
    "a[href^='tel:'], .phone-number, .phone, [data-phone], .contact-phone, li.phone, span.phone, .phones li, .contact-info a[href^='tel']",
    (els) =>
      els
        .map((el) => {
          const href = el.getAttribute("href");
          if (href?.startsWith("tel:")) return href.replace("tel:", "").trim();
          return el.textContent?.trim() || "";
        })
        .filter(Boolean)
  );
  if (structured.length > 0) return [...new Set(structured)].slice(0, 5);

  // Fallback: regex on page HTML
  const html = await page.content();
  const phoneRegex = /(?:\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/g;
  const matches = html.match(phoneRegex) || [];
  const cleaned = [...new Set(
    matches
      .map((p) => p.replace(/[^\d]/g, ""))
      .filter((p) => p.length === 10)
      .map((p) => `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`)
  )];
  return cleaned.slice(0, 5);
}

/**
 * Primary search: cyberbackgroundchecks.com/address/{street}/{city}/{state}/
 * Returns phones found on the residents listed for that address.
 */
async function searchByAddressUrl(
  page: import("playwright").Page,
  address: string,
  city: string,
  state: string,
  firstName: string,
  lastName: string
): Promise<string[]> {
  const streetSlug = slugify(address);
  const citySlug = slugify(city);
  const stateSlug = slugify(state);

  const addressUrl = `${CYBER_BASE}/address/${streetSlug}/${citySlug}/${stateSlug}/`;
  logger.debug({ addressUrl }, "Navigating to address page");

  await page.goto(addressUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1200, 2500);

  // Check for Cloudflare challenge or block
  const title = await page.title();
  if (title.toLowerCase().includes("just a moment") || title.toLowerCase().includes("cloudflare")) {
    throw new Error("Cloudflare challenge detected");
  }

  // Look for resident cards / person listings on the address page
  const residentLinks = await page.$$eval(
    ".residents a, .person-card a, .result-item a, article a, .address-residents a, [class*='resident'] a, [class*='person'] a",
    (els) => els.map((el) => ({ href: el.getAttribute("href") || "", text: el.textContent?.trim() || "" }))
  );

  // If we have a name, try to match the resident by name first
  const fullNameLower = `${firstName} ${lastName}`.toLowerCase().trim();
  let targetHref: string | null = null;

  if (fullNameLower.length > 1 && residentLinks.length > 0) {
    const match = residentLinks.find((r) => {
      const t = r.text.toLowerCase();
      return (firstName && t.includes(firstName.toLowerCase())) ||
             (lastName && t.includes(lastName.toLowerCase())) ||
             (fullNameLower && t.includes(fullNameLower));
    });
    targetHref = match?.href || residentLinks[0]?.href || null;
  } else if (residentLinks.length > 0) {
    targetHref = residentLinks[0].href;
  }

  if (!targetHref) {
    // Try extracting phones directly from the address page (some layouts show them inline)
    const directPhones = await extractPhones(page);
    if (directPhones.length > 0) return directPhones;
    return [];
  }

  const profileUrl = targetHref.startsWith("http") ? targetHref : `${CYBER_BASE}${targetHref}`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(900, 1800);

  return extractPhones(page);
}

/**
 * Fallback: people search by name
 */
async function searchByName(
  page: import("playwright").Page,
  firstName: string,
  lastName: string,
  city: string,
  state: string
): Promise<string[]> {
  const searchUrl = `${CYBER_BASE}/people/search/?fname=${encodeURIComponent(firstName)}&lname=${encodeURIComponent(lastName)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&address=`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1000, 2000);

  const title = await page.title();
  if (title.toLowerCase().includes("just a moment") || title.toLowerCase().includes("cloudflare")) {
    throw new Error("Cloudflare challenge detected");
  }

  const firstLink = await page.$(
    "div.people-search-result a, .result-item a, article.result a, .card a, .search-result a, .person-card a"
  );
  if (!firstLink) return [];

  const href = await firstLink.getAttribute("href");
  if (!href) return [];

  const profileUrl = href.startsWith("http") ? href : `${CYBER_BASE}${href}`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(900, 1800);

  return extractPhones(page);
}

/** Build a browser with optional proxy */
async function launchBrowser(proxyServer?: string, proxyUser?: string, proxyPass?: string) {
  const proxyConfig = proxyServer
    ? {
        proxy: {
          server: proxyServer,
          ...(proxyUser ? { username: proxyUser } : {}),
          ...(proxyPass ? { password: proxyPass } : {}),
        },
      }
    : {};

  const browser = await chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
    ...proxyConfig,
  });

  const context = await browser.newContext({
    userAgent: STEALTH_UA,
    viewport: { width: 1920, height: 1080 },
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
  // Warm up — visit the homepage so cookies are set before scraping
  await page.goto(CYBER_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1500, 3000);

  return { browser, page };
}

/** Process a batch of rows with the given page. Returns updated foundCount delta. */
async function processBatch(
  page: import("playwright").Page,
  rows: (typeof skipTraceResultsTable.$inferSelect)[],
  jobId: string,
  currentProxy: { id: string; server: string; username?: string; password?: string } | null,
  onFoundCountIncrease: () => void,
  onProcessedIncrease: () => void,
  onRotateBrowser: () => Promise<import("playwright").Page>,
): Promise<void> {
  let consecutiveErrors = 0;
  let activePage = page;

  for (const row of rows) {
    if (await isJobCancelled(jobId)) break;

    await db.update(skipTraceResultsTable).set({ status: "processing" }).where(eq(skipTraceResultsTable.id, row.id));

    let phones: string[] = [];
    let status = "not_found";
    let error: string | undefined;

    try {
      // PRIMARY: address page URL
      if (row.address) {
        phones = await searchByAddressUrl(activePage, row.address, row.city, row.state, row.firstName, row.lastName);
      }

      // FALLBACK: name search
      if (phones.length === 0 && row.firstName && row.lastName) {
        phones = await searchByName(activePage, row.firstName, row.lastName, row.city, row.state);
      }

      if (phones.length > 0) {
        status = "found";
        onFoundCountIncrease();
      }

      consecutiveErrors = 0;
      if (currentProxy) await markProxySuccess(currentProxy.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, jobId, rowIndex: row.rowIndex }, "Error processing row");
      status = "error";
      error = errMsg.slice(0, 300);
      consecutiveErrors++;

      if (currentProxy) await markProxyFail(currentProxy.id, errMsg);

      // Try to navigate back to base after error
      try {
        await activePage.goto(CYBER_BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
        await randomDelay(3000, 6000);
      } catch { /* ignore */ }

      // Rotate browser after 3 consecutive errors
      if (consecutiveErrors >= 3) {
        logger.info({ jobId }, "Rotating browser due to consecutive errors");
        try {
          activePage = await onRotateBrowser();
          consecutiveErrors = 0;
        } catch (rotateErr) {
          logger.error({ rotateErr }, "Failed to rotate browser");
        }
      }
    }

    await db.update(skipTraceResultsTable)
      .set({ phones, status, error: error ?? null, retryCount: row.retryCount })
      .where(eq(skipTraceResultsTable.id, row.id));

    onProcessedIncrease();
    await randomDelay(2000, 5000);
  }
}

export async function runSkipTrace(jobId: string) {
  let browser: import("playwright").Browser | null = null;

  try {
    await db.update(skipTraceJobsTable)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    const allResults = await db.select().from(skipTraceResultsTable)
      .where(eq(skipTraceResultsTable.jobId, jobId))
      .orderBy(skipTraceResultsTable.rowIndex);

    if (allResults.length === 0) {
      await db.update(skipTraceJobsTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
      return;
    }

    let processedRows = 0;
    let foundCount = 0;

    const syncCounts = async () => {
      await db.update(skipTraceJobsTable)
        .set({ processedRows, foundCount, updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
    };

    // ── PASS 1: Process all rows ──────────────────────────────────────────
    let proxy = await getNextProxy();
    logger.info({ jobId, usingProxy: !!proxy, server: proxy?.server ?? "none" }, "Starting skip trace – pass 1");

    const { browser: b1, page: p1 } = await launchBrowser(proxy?.server, proxy?.username, proxy?.password);
    browser = b1;
    let activePage = p1;

    await processBatch(
      activePage,
      allResults,
      jobId,
      proxy,
      () => { foundCount++; },
      () => { processedRows++; syncCounts(); },
      async () => {
        await browser?.close().catch(() => {});
        const newProxy = await getNextProxy();
        proxy = newProxy;
        const { browser: nb, page: np } = await launchBrowser(newProxy?.server, newProxy?.username, newProxy?.password);
        browser = nb;
        activePage = np;
        return np;
      }
    );

    if (await isJobCancelled(jobId)) {
      await db.update(skipTraceJobsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
      return;
    }

    // ── SMART RETRY PASSES (up to MAX_RETRIES) ────────────────────────────
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const failedRows = await db.select().from(skipTraceResultsTable)
        .where(
          and(
            eq(skipTraceResultsTable.jobId, jobId),
            eq(skipTraceResultsTable.status, "error"),
          )
        )
        .orderBy(skipTraceResultsTable.rowIndex);

      const toRetry = failedRows.filter((r) => r.retryCount < MAX_RETRIES);
      if (toRetry.length === 0) break;

      logger.info({ jobId, attempt, count: toRetry.length }, `Smart retry – attempt ${attempt}`);

      // Mark them as pending-retry and increment retryCount
      for (const row of toRetry) {
        await db.update(skipTraceResultsTable)
          .set({ retryCount: row.retryCount + 1, status: "pending" })
          .where(eq(skipTraceResultsTable.id, row.id));
      }

      // Rotate to a fresh browser + new proxy for the retry
      await browser?.close().catch(() => {});
      const retryProxy = await getNextProxy();
      logger.info({ jobId, attempt, server: retryProxy?.server ?? "none" }, "Retry browser launched");

      const { browser: rb, page: rp } = await launchBrowser(retryProxy?.server, retryProxy?.username, retryProxy?.password);
      browser = rb;
      activePage = rp;

      // Re-fetch with updated retryCount
      const retryRows = await db.select().from(skipTraceResultsTable)
        .where(inArray(skipTraceResultsTable.id, toRetry.map((r) => r.id)))
        .orderBy(skipTraceResultsTable.rowIndex);

      await processBatch(
        activePage,
        retryRows,
        jobId,
        retryProxy,
        () => { foundCount++; },
        () => { syncCounts(); },
        async () => {
          await browser?.close().catch(() => {});
          const np2 = await getNextProxy();
          const { browser: nb2, page: pg2 } = await launchBrowser(np2?.server, np2?.username, np2?.password);
          browser = nb2;
          activePage = pg2;
          return pg2;
        }
      );

      if (await isJobCancelled(jobId)) {
        await db.update(skipTraceJobsTable)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(skipTraceJobsTable.jobId, jobId));
        return;
      }

      await randomDelay(3000, 7000);
    }

    await syncCounts();
    await db.update(skipTraceJobsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    logger.info({ jobId, processedRows, foundCount }, "Skip trace job fully completed");
  } catch (err) {
    logger.error({ err, jobId }, "Skip trace job crashed");
    await db.update(skipTraceJobsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId))
      .catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    cancelledJobs.delete(jobId);
  }
}
