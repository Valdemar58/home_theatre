import "server-only";
import { db, now, stmt } from "./db";

const getStmt = stmt<[string], { value: string; expires_at: number }>(
  "SELECT value, expires_at FROM cache WHERE key = ?");
const setStmt = stmt(
  "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at");

export function getCached<T>(key: string, allowStale = false): T | undefined {
  const row = getStmt().get(key);
  if (!row) return undefined;
  if (!allowStale && row.expires_at < now()) return undefined;
  return JSON.parse(row.value) as T;
}

export function setCached(key: string, value: unknown, ttlSeconds: number): void {
  setStmt().run(key, JSON.stringify(value), now() + ttlSeconds);
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Кэш с дедупликацией одновременных запросов. Если внешний API недоступен,
 * отдаёт просроченное значение вместо ошибки.
 */
export async function cached<T>(key: string, ttlSeconds: number | ((v: T) => number), fn: () => Promise<T>): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== undefined) return hit;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await fn();
      setCached(key, value, typeof ttlSeconds === "function" ? ttlSeconds(value) : ttlSeconds);
      return value;
    } catch (err) {
      const stale = getCached<T>(key, true);
      if (stale !== undefined) {
        console.warn(`[cache] ${key}: ${String(err)} — отдаю устаревшие данные`);
        return stale;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function purgeExpired(): void {
  // Держим просроченное ещё сутки как запасной вариант при недоступности API
  db.prepare("DELETE FROM cache WHERE expires_at < ?").run(now() - 86400);
}
