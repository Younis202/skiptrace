import { Router } from "express";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db, proxiesTable } from "@workspace/db";
import { chromium } from "playwright";
import { refreshProxies, getRefreshStatus } from "../lib/proxyRefresher";

const router = Router();

function formatProxy(p: typeof proxiesTable.$inferSelect) {
  return {
    id: p.id,
    url: maskProxyPassword(p.url),
    label: p.label,
    isActive: p.isActive,
    successCount: p.successCount,
    failCount: p.failCount,
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    lastError: p.lastError ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

function maskProxyPassword(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url;
  }
}

router.get("/proxies/refresh-status", (_req, res) => {
  res.json(getRefreshStatus());
});

router.post("/proxies/refresh", async (req, res) => {
  try {
    const result = await refreshProxies();
    res.json({ ...result, lastRefreshedAt: getRefreshStatus().lastRefreshedAt });
  } catch (err) {
    req.log.error({ err }, "Failed to refresh proxies");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/proxies", async (req, res) => {
  try {
    const proxies = await db.select().from(proxiesTable).orderBy(proxiesTable.createdAt);
    res.json({ proxies: proxies.map(formatProxy) });
  } catch (err) {
    req.log.error({ err }, "Failed to list proxies");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/proxies", async (req, res) => {
  try {
    const { url, label } = req.body as { url?: string; label?: string };
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    try { new URL(url); } catch {
      res.status(400).json({ error: "Invalid proxy URL. Use format: http://user:pass@host:port" });
      return;
    }

    const proxy = await db.insert(proxiesTable).values({
      id: uuidv4(),
      url,
      label: label || "",
    }).returning();

    res.json(formatProxy(proxy[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to add proxy");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/proxies/bulk", async (req, res) => {
  try {
    const { lines } = req.body as { lines?: string };
    if (!lines) {
      res.status(400).json({ error: "lines is required" });
      return;
    }

    const urls = lines.split("\n").map(l => l.trim()).filter(Boolean);
    let added = 0;
    let skipped = 0;

    for (const url of urls) {
      try {
        new URL(url);
        await db.insert(proxiesTable).values({ id: uuidv4(), url, label: "" });
        added++;
      } catch {
        skipped++;
      }
    }

    res.json({ added, skipped });
  } catch (err) {
    req.log.error({ err }, "Failed to bulk add proxies");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/proxies/:proxyId", async (req, res) => {
  try {
    const { proxyId } = req.params;
    const deleted = await db.delete(proxiesTable).where(eq(proxiesTable.id, proxyId)).returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Proxy not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete proxy");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/proxies/:proxyId/toggle", async (req, res) => {
  try {
    const { proxyId } = req.params;
    const [proxy] = await db.select().from(proxiesTable).where(eq(proxiesTable.id, proxyId));
    if (!proxy) {
      res.status(404).json({ error: "Proxy not found" });
      return;
    }

    const updated = await db.update(proxiesTable)
      .set({ isActive: !proxy.isActive, failCount: !proxy.isActive ? 0 : proxy.failCount })
      .where(eq(proxiesTable.id, proxyId))
      .returning();

    res.json(formatProxy(updated[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to toggle proxy");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/proxies/:proxyId/test", async (req, res) => {
  try {
    const { proxyId } = req.params;
    const [proxy] = await db.select().from(proxiesTable).where(eq(proxiesTable.id, proxyId));
    if (!proxy) {
      res.status(404).json({ error: "Proxy not found" });
      return;
    }

    const start = Date.now();
    let browser: import("playwright").Browser | null = null;

    try {
      let proxyConfig: import("playwright").BrowserContextOptions["proxy"] | undefined;
      try {
        const u = new URL(proxy.url);
        proxyConfig = {
          server: `${u.protocol}//${u.hostname}:${u.port}`,
          ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
          ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        };
      } catch {
        res.json({ ok: false, error: "Invalid proxy URL format" });
        return;
      }

      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
        proxy: proxyConfig,
      });

      const page = await browser.newPage();
      await page.goto("https://api.ipify.org?format=json", { timeout: 15000 });
      const latencyMs = Date.now() - start;

      await db.update(proxiesTable)
        .set({ successCount: proxy.successCount + 1, lastError: null })
        .where(eq(proxiesTable.id, proxyId));

      res.json({ ok: true, latencyMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.update(proxiesTable)
        .set({ failCount: proxy.failCount + 1, lastError: error.slice(0, 500) })
        .where(eq(proxiesTable.id, proxyId));
      res.json({ ok: false, error: error.slice(0, 200) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, "Failed to test proxy");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
