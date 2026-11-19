"use client";
// Что из показанного пришло из сохранённого (источник недоступен): ответы API несут заголовок X-Data-Stale
// «anilist=<секунды>,…» — копим самую старую дату по источнику, плашка в шапке показывает это.

type Stale = Record<string, number>;
let seen: Stale = {};
let at = 0;
const listeners = new Set<() => void>();

/** Из заголовка ответа: отметить источники, данные которых показаны из сохранённого. */
export function reportStale(header: string | null) {
  if (!header) return;
  const next = { ...seen };
  for (const part of header.split(",")) {
    const [src, ts] = part.split("=");
    const t = Number(ts);
    if (src && t && (!next[src] || t < next[src])) next[src] = t;
  }
  seen = next;
  at = Date.now();
  listeners.forEach((l) => l());
}

export function clearStale() {
  seen = {};
  listeners.forEach((l) => l());
}

export const staleSnapshot = () => seen;
export const staleReportedAt = () => at;
export function subscribeStale(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
