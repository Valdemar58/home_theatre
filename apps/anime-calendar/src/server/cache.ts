import "server-only";
import { cacheClassOf, keepAfterExpiry, type CacheClass } from "@/lib/freshness";
import { db, now, stmt } from "./db";
import { noteServed, sourceDown, SourceDown, type Source } from "./sources";

// Хранилище ответов внешних API. Срок записи — «когда проверить снова», а не «когда удалить»: данные о тайтлах
// (класс entity) не удаляются никогда, выдачи каталога (listing) — через 30 дней после срока, состояние сервисов
// (volatile) — через сутки. Устаревшее отдаётся сразу, обновление — в фоне (страница не ждёт внешний API).

const getStmt = stmt<[string], { value: string; expires_at: number; fetched_at: number | null }>(
  "SELECT value, expires_at, fetched_at FROM cache WHERE key = ?");
const setStmt = stmt(
  "INSERT INTO cache (key, value, expires_at, class, fetched_at) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, class = excluded.class, fetched_at = excluded.fetched_at");

export function getCached<T>(key: string, allowStale = false): T | undefined {
  const row = getStmt().get(key);
  if (!row) return undefined;
  if (!allowStale && row.expires_at < now()) return undefined;
  return JSON.parse(row.value) as T;
}

export function setCached(key: string, value: unknown, ttlSeconds: number, cls: CacheClass = cacheClassOf(key)): void {
  const t = now();
  setStmt().run(key, JSON.stringify(value), t + ttlSeconds, cls, t);
}

export type CacheOpts<T> = {
  /** Через сколько секунд проверить снова (можно по значению: вышедший тайтл — редко) */
  fresh: number | ((v: T) => number);
  /** Источник: лежит — сеть не трогаем, отдаём сохранённое */
  source?: Source;
  cls?: CacheClass;
  /** Устаревшее — сразу, обновление в фоне (по умолчанию — для entity и listing; volatile ждёт обновления) */
  swr?: boolean;
};

const inflight = new Map<string, Promise<unknown>>();

function refresh<T>(key: string, o: CacheOpts<T>, cls: CacheClass, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await fn();
      setCached(key, value, typeof o.fresh === "function" ? o.fresh(value) : o.fresh, cls);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Кэш с дедупликацией одновременных запросов. Свежее — отдаём; устаревшее — отдаём сразу и обновляем в фоне
 * (swr); источник недоступен — отдаём сохранённое любой давности; записи нет совсем — ждём источник.
 * Вторым аргументом можно передать просто срок в секундах (класс — по ключу).
 */
export async function cached<T>(key: string, opts: number | ((v: T) => number) | CacheOpts<T>, fn: () => Promise<T>): Promise<T> {
  const o: CacheOpts<T> = typeof opts === "object" ? opts : { fresh: opts };
  const cls = o.cls ?? cacheClassOf(key);
  const row = getStmt().get(key);
  if (row && row.expires_at >= now()) return JSON.parse(row.value) as T;
  if (row) {
    const stale = JSON.parse(row.value) as T;
    const fetched = row.fetched_at ?? row.expires_at;
    if (o.source && sourceDown(o.source)) {
      noteServed(o.source, fetched);
      return stale;
    }
    if (o.swr ?? cls !== "volatile") {
      // Страница не ждёт: обновим в фоне (ошибку — только в лог, сохранённое остаётся)
      refresh(key, o, cls, fn).catch((e) => { if (!(e instanceof SourceDown)) console.warn(`[cache] ${key}: ${String(e)}`); });
      return stale;
    }
    try {
      return await refresh(key, o, cls, fn);
    } catch (err) {
      console.warn(`[cache] ${key}: ${String(err)} — отдаю сохранённое`);
      noteServed(o.source, fetched);
      return stale;
    }
  }
  if (o.source && sourceDown(o.source)) throw new SourceDown(o.source);
  return refresh(key, o, cls, fn);
}

/** Забыть запись (данные изменились по нашему же действию: запрос в Seerr и т. п.). */
export function dropCached(key: string): void {
  db.prepare("DELETE FROM cache WHERE key = ?").run(key);
}

/** Когда получено сохранённое значение (секунды) или null. */
export function cachedAt(key: string): number | null {
  return getStmt().get(key)?.fetched_at ?? null;
}

/** Удалить просроченное по классам: данные о тайтлах не удаляются никогда. */
export function purgeExpired(): void {
  for (const cls of ["listing", "volatile"] as const) {
    db.prepare("DELETE FROM cache WHERE class = ? AND expires_at < ?").run(cls, now() - keepAfterExpiry(cls)!);
  }
}
