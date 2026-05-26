import { db, proxiesTable } from "@workspace/db";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";

const PROXY_SOURCES = [
  {
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    scheme: "http",
    label: "TheSpeedX-HTTP",
  },
  {
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    scheme: "socks5",
    label: "TheSpeedX-SOCKS5",
  },
  {
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    scheme: "http",
    label: "monosans-HTTP",
  },
  {
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    scheme: "socks5",
    label: "monosans-SOCKS5",
  },
];

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;
const IP_PORT_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/;

export interface RefreshStatus {
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastAddedCount: number;
  isRefreshing: boolean;
}

const _status = {
  lastRefreshedAt: null as Date | null,
  nextRefreshAt: null as Date | null,
  lastAddedCount: 0,
  isRefreshing: false,
};

export function getRefreshStatus(): RefreshStatus {
  return {
    lastRefreshedAt: _status.lastRefreshedAt?.toISOString() ?? null,
    nextRefreshAt: _status.nextRefreshAt?.toISOString() ?? null,
    lastAddedCount: _status.lastAddedCount,
    isRefreshing: _status.isRefreshing,
  };
}

export async function refreshProxies(): Promise<{ added: number; skipped: number; total: number }> {
  if (_status.isRefreshing) {
    logger.warn("Proxy refresh already in progress — skipping");
    return { added: 0, skipped: 0, total: 0 };
  }

  _status.isRefreshing = true;
  logger.info("Proxy auto-refresh starting");

  let added = 0;
  let skipped = 0;

  try {
    const existing = await db.select({ url: proxiesTable.url }).from(proxiesTable);
    const existingUrls = new Set(existing.map((p) => p.url));

    const toInsert: { id: string; url: string; label: string }[] = [];

    for (const source of PROXY_SOURCES) {
      try {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          logger.warn({ url: source.url, status: res.status }, "Proxy source returned non-OK");
          continue;
        }

        const text = await res.text();
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => IP_PORT_RE.test(l));

        logger.debug({ source: source.label, lines: lines.length }, "Fetched proxy source");

        for (const line of lines) {
          const proxyUrl = `${source.scheme}://${line}`;
          if (existingUrls.has(proxyUrl)) {
            skipped++;
            continue;
          }
          existingUrls.add(proxyUrl);
          toInsert.push({ id: uuidv4(), url: proxyUrl, label: "auto" });
        }
      } catch (err) {
        logger.warn({ err, url: source.url }, "Failed to fetch proxy source");
      }
    }

    if (toInsert.length > 0) {
      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        await db.insert(proxiesTable).values(toInsert.slice(i, i + BATCH_SIZE));
      }
      added = toInsert.length;
    }

    const now = new Date();
    _status.lastRefreshedAt = now;
    _status.nextRefreshAt = new Date(now.getTime() + REFRESH_INTERVAL_MS);
    _status.lastAddedCount = added;

    logger.info({ added, skipped, total: toInsert.length + skipped }, "Proxy auto-refresh complete");
    return { added, skipped, total: toInsert.length + skipped };
  } finally {
    _status.isRefreshing = false;
  }
}

export function startProxyAutoRefresh() {
  const firstAt = new Date(Date.now() + INITIAL_DELAY_MS);
  _status.nextRefreshAt = firstAt;

  logger.info({ nextRefreshAt: firstAt.toISOString() }, "Proxy auto-refresh scheduled (first run in 5 min)");

  setTimeout(async () => {
    try {
      await refreshProxies();
    } catch (err) {
      logger.error({ err }, "Initial scheduled proxy refresh failed");
    }

    setInterval(async () => {
      try {
        await refreshProxies();
      } catch (err) {
        logger.error({ err }, "Periodic proxy refresh failed");
      }
    }, REFRESH_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
