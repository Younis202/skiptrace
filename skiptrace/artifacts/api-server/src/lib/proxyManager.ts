import { eq, and } from "drizzle-orm";
import { db, proxiesTable } from "@workspace/db";
import { logger } from "./logger";

export type ProxyConfig = {
  id: string;
  server: string;
  username?: string;
  password?: string;
};

let roundRobinIndex = 0;

function parseProxyUrl(rawUrl: string): ProxyConfig | null {
  try {
    const url = new URL(rawUrl);
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return { id: rawUrl, server, username, password };
  } catch {
    return null;
  }
}

export async function getNextProxy(): Promise<ProxyConfig | null> {
  try {
    const proxies = await db
      .select()
      .from(proxiesTable)
      .where(and(eq(proxiesTable.isActive, true)));

    if (proxies.length === 0) return null;

    const proxy = proxies[roundRobinIndex % proxies.length];
    roundRobinIndex = (roundRobinIndex + 1) % proxies.length;

    await db
      .update(proxiesTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(proxiesTable.id, proxy.id));

    const parsed = parseProxyUrl(proxy.url);
    if (!parsed) return null;

    return { ...parsed, id: proxy.id };
  } catch (err) {
    logger.warn({ err }, "Failed to get next proxy, running without proxy");
    return null;
  }
}

export async function markProxySuccess(proxyId: string) {
  try {
    const [proxy] = await db.select({ successCount: proxiesTable.successCount })
      .from(proxiesTable).where(eq(proxiesTable.id, proxyId));
    if (proxy) {
      await db.update(proxiesTable)
        .set({ successCount: proxy.successCount + 1 })
        .where(eq(proxiesTable.id, proxyId));
    }
  } catch { /* ignore */ }
}

export async function markProxyFail(proxyId: string, error: string) {
  try {
    const [proxy] = await db.select({ failCount: proxiesTable.failCount })
      .from(proxiesTable).where(eq(proxiesTable.id, proxyId));
    if (proxy) {
      const newFailCount = proxy.failCount + 1;
      await db.update(proxiesTable)
        .set({
          failCount: newFailCount,
          lastError: error.slice(0, 500),
          isActive: newFailCount < 5,
        })
        .where(eq(proxiesTable.id, proxyId));
    }
  } catch { /* ignore */ }
}

export function parseProxyUrlPublic(rawUrl: string) {
  return parseProxyUrl(rawUrl);
}
