// Подготовленные серии (TASKS 9.8): серия «Стрима», скачанная целиком через qBittorrent. Правила места:
// что удалять и можно ли скачивать ещё. Чистые функции — сервер (server/prep.ts) подставляет данные.

export const GB = 1024 ** 3;
const DAY = 86400;

export type PrepPolicy = {
  /** Сколько места всего под подготовленные серии */
  limitBytes: number;
  /** Сколько свободного места на диске оставлять всегда */
  minFreeBytes: number;
  /** Сколько держать серию после просмотра (все, кто готовил, досмотрели), с */
  keepAfterWatchSec: number;
  /** Сколько держать непросмотренную, с последнего запуска или окончания скачивания, с */
  ttlSec: number;
};

export const DEFAULT_POLICY: PrepPolicy = { limitBytes: 20 * GB, minFreeBytes: 15 * GB, keepAfterWatchSec: 3 * DAY, ttlSec: 14 * DAY };

export type PrepItem = {
  key: string;
  size: number;
  /** Скачана (null — ещё качается) */
  doneAt: number | null;
  /** Досмотрели все, кто готовил (null — нет) */
  watchedAt: number | null;
  /** Последний запуск серии */
  usedAt: number | null;
  createdAt: number;
};

/**
 * Что удалить сейчас: досмотренные дольше срока, забытые дольше TTL, а если места больше лимита — сначала досмотренные,
 * потом давно не запускавшиеся (качающиеся не трогаем — для них место уже выделено).
 */
export function toEvict(items: PrepItem[], now: number, p: PrepPolicy): string[] {
  const out = new Set<string>();
  for (const i of items) {
    if (i.doneAt === null) continue;
    if (i.watchedAt !== null && now - i.watchedAt > p.keepAfterWatchSec) out.add(i.key);
    else if (now - Math.max(i.usedAt ?? 0, i.doneAt) > p.ttlSec) out.add(i.key);
  }
  let total = items.filter((i) => !out.has(i.key)).reduce((s, i) => s + i.size, 0);
  const order = items
    .filter((i) => i.doneAt !== null && !out.has(i.key))
    .sort((a, b) => Number(b.watchedAt !== null) - Number(a.watchedAt !== null) || Math.max(a.usedAt ?? 0, a.doneAt!) - Math.max(b.usedAt ?? 0, b.doneAt!));
  for (const i of order) {
    if (total <= p.limitBytes) break;
    out.add(i.key);
    total -= i.size;
  }
  return [...out];
}

/** Можно ли скачать ещё size байт: в лимите и на диске останется запас. Нет — почему (для уведомления). */
export function canPrepare(size: number, used: number, freeBytes: number, p: PrepPolicy): { ok: true } | { ok: false; reason: string } {
  const gb = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0).replace(".", ",")} ГБ`;
  if (used + size > p.limitBytes) return { ok: false, reason: `подготовленные серии уже занимают ${gb(used)} из ${gb(p.limitBytes)}` };
  if (freeBytes - size < p.minFreeBytes) return { ok: false, reason: `на диске свободно ${gb(freeBytes)}, а оставлять нужно ${gb(p.minFreeBytes)}` };
  return { ok: true };
}
