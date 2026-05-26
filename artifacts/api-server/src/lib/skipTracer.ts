import { chromium } from "playwright";
import { eq } from "drizzle-orm";
import { db, skipTraceJobsTable, skipTraceResultsTable } from "@workspace/db";
import { logger } from "./logger";

const CYBER_BASE = "https://www.cyberbackgroundchecks.com";

const cancelledJobs = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 1500, max = 3500) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  if (cancelledJobs.has(jobId)) return true;
  const [job] = await db.select({ status: skipTraceJobsTable.status })
    .from(skipTraceJobsTable)
    .where(eq(skipTraceJobsTable.jobId, jobId));
  if (job?.status === "cancelled") {
    cancelledJobs.add(jobId);
    return true;
  }
  return false;
}

async function searchAddress(page: import("playwright").Page, address: string, city: string, state: string): Promise<string[]> {
  const searchQuery = [address, city, state].filter(Boolean).join(" ");
  const searchUrl = `${CYBER_BASE}/people/search/?fname=&lname=&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&address=${encodeURIComponent(address)}`;

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1000, 2000);

  const results = await page.$$eval("div.people-search-result, .result-item, article.result", (els) =>
    els.map((el) => el.textContent?.trim() || "")
  );

  if (results.length === 0) {
    return [];
  }

  const firstResultLink = await page.$("div.people-search-result a, .result-item a, article.result a");
  if (!firstResultLink) return [];

  const href = await firstResultLink.getAttribute("href");
  if (!href) return [];

  const profileUrl = href.startsWith("http") ? href : `${CYBER_BASE}${href}`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(800, 1800);

  return extractPhones(page);
}

async function searchByName(page: import("playwright").Page, firstName: string, lastName: string, city: string, state: string): Promise<string[]> {
  const searchUrl = `${CYBER_BASE}/people/search/?fname=${encodeURIComponent(firstName)}&lname=${encodeURIComponent(lastName)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&address=`;

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1000, 2000);

  const firstResultLink = await page.$("div.people-search-result a, .result-item a, article.result a, .card a, .search-result a");
  if (!firstResultLink) return [];

  const href = await firstResultLink.getAttribute("href");
  if (!href) return [];

  const profileUrl = href.startsWith("http") ? href : `${CYBER_BASE}${href}`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(800, 1800);

  return extractPhones(page);
}

async function extractPhones(page: import("playwright").Page): Promise<string[]> {
  const phones = await page.$$eval(
    "a[href^='tel:'], .phone-number, .phone, [data-phone], .contact-phone, li.phone, span.phone",
    (els) => els.map((el) => {
      const href = el.getAttribute("href");
      if (href?.startsWith("tel:")) return href.replace("tel:", "").trim();
      return el.textContent?.trim() || "";
    }).filter(Boolean)
  );

  if (phones.length > 0) return [...new Set(phones)];

  const pageText = await page.content();
  const phoneRegex = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g;
  const matches = pageText.match(phoneRegex) || [];
  const cleaned = matches.map((p) => p.replace(/[^\d]/g, "")).filter((p) => p.length === 10);
  const formatted = cleaned.map((p) => `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`);
  return [...new Set(formatted)].slice(0, 5);
}

export async function runSkipTrace(jobId: string) {
  let browser: import("playwright").Browser | null = null;

  try {
    await db.update(skipTraceJobsTable)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    const results = await db.select().from(skipTraceResultsTable)
      .where(eq(skipTraceResultsTable.jobId, jobId))
      .orderBy(skipTraceResultsTable.rowIndex);

    if (results.length === 0) {
      await db.update(skipTraceJobsTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
      return;
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--window-size=1920,1080",
      ],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      (globalThis as unknown as Record<string, unknown>)["chrome"] = { runtime: {} };
    });

    const page = await context.newPage();

    await page.goto(CYBER_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 4000);

    let processedRows = 0;
    let foundCount = 0;

    for (const row of results) {
      if (await isJobCancelled(jobId)) {
        logger.info({ jobId }, "Job cancelled, stopping");
        break;
      }

      await db.update(skipTraceResultsTable)
        .set({ status: "processing" })
        .where(eq(skipTraceResultsTable.id, row.id));

      let phones: string[] = [];
      let status = "not_found";
      let error: string | undefined;

      try {
        if (row.address) {
          phones = await searchAddress(page, row.address, row.city, row.state);
        }

        if (phones.length === 0 && row.firstName && row.lastName) {
          phones = await searchByName(page, row.firstName, row.lastName, row.city, row.state);
        }

        if (phones.length > 0) {
          status = "found";
          foundCount++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: errMsg, jobId, rowIndex: row.rowIndex }, "Error processing row");
        status = "error";
        error = errMsg.slice(0, 200);

        try {
          await page.goto(CYBER_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
          await randomDelay(3000, 6000);
        } catch {
          // ignore navigation error
        }
      }

      await db.update(skipTraceResultsTable)
        .set({ phones, status, error: error ?? null })
        .where(eq(skipTraceResultsTable.id, row.id));

      processedRows++;
      await db.update(skipTraceJobsTable)
        .set({ processedRows, foundCount, updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));

      await randomDelay(2000, 5000);
    }

    const cancelled = await isJobCancelled(jobId);
    if (!cancelled) {
      await db.update(skipTraceJobsTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(skipTraceJobsTable.jobId, jobId));
    }

    logger.info({ jobId, processedRows, foundCount }, "Skip trace job completed");
  } catch (err) {
    logger.error({ err, jobId }, "Skip trace job crashed");
    await db.update(skipTraceJobsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId)).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    cancelledJobs.delete(jobId);
  }
}
