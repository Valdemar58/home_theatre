import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "./http";

// Предохранители внешних источников. Источник, который не отвечает (сеть, таймаут, 5xx, 429), «лежит» с нарастающей
// паузой: в это время сеть не трогаем — страницы сразу берут сохранённое, а не ждут таймаут на каждом запросе.
// Первый удачный ответ закрывает предохранитель. SOURCES_OFFLINE=anilist,shikimori — принудительно «лежат»
// (проверка деградации без отключения сети). Тут же — что из сохранённого отдали в текущем запросе (для плашки).

export type Source = "anilist" | "shikimori" | "tmdb" | "kitsu" | "jellyfin" | "seerr" | "fandom" | "wikipedia" | "mal";
export const SOURCE_NAMES: Record<Source, string> = {
  anilist: "AniList", shikimori: "Shikimori", tmdb: "TMDB", kitsu: "Kitsu", jellyfin: "Jellyfin", seerr: "Seerr",
  fandom: "Fandom", wikipedia: "Википедия", mal: "MyAnimeList",
};

type State = { failures: number; downUntil: number; lastError: string | null; lastOk: number | null; calls: number; errors: number; served: number };
const PAUSES = [60, 120, 300, 900, 1800].map((s) => s * 1000);

const g = globalThis as unknown as { __sources?: Map<Source, State> };
const states = (g.__sources ??= new Map());
const state = (s: Source): State => {
  let st = states.get(s);
  if (!st) states.set(s, (st = { failures: 0, downUntil: 0, lastError: null, lastOk: null, calls: 0, errors: 0, served: 0 }));
  return st;
};
const forced = () => new Set((process.env.SOURCES_OFFLINE ?? "").split(",").map((x) => x.trim()).filter(Boolean));

export class SourceDown extends Error {
  constructor(public source: Source) {
    super(`${SOURCE_NAMES[source]} недоступен`);
  }
}

/** Источник сейчас считается недоступным (сеть не трогаем). */
export function sourceDown(s: Source): boolean {
  return forced().has(s) || state(s).downUntil > Date.now();
}

/** Ошибка — признак того, что источник лежит (а не что запрос неправильный или данных нет). */
export function isOutage(e: unknown): boolean {
  if (e instanceof SourceDown) return true;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  const name = (e as { name?: string })?.name;
  const msg = String((e as { message?: string })?.message ?? e);
  return name === "TimeoutError" || name === "AbortError" || e instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(msg);
}

export function markOk(s: Source) {
  const st = state(s);
  st.calls++;
  st.failures = 0;
  st.downUntil = 0;
  st.lastOk = Date.now();
}

export function markFail(s: Source, e: unknown) {
  const st = state(s);
  st.calls++;
  if (e instanceof SourceDown || !isOutage(e)) return;
  st.errors++;
  st.lastError = String((e as { message?: string })?.message ?? e).slice(0, 200);
  st.downUntil = Date.now() + PAUSES[Math.min(st.failures, PAUSES.length - 1)];
  st.failures++;
  console.warn(`[sources] ${SOURCE_NAMES[s]} не отвечает (${st.lastError}), пауза ${Math.round((st.downUntil - Date.now()) / 1000)} с`);
}

/** Вызов источника через предохранитель: лежит — сразу SourceDown; исход вызова отмечается. */
export async function guarded<T>(s: Source, fn: () => Promise<T>): Promise<T> {
  if (sourceDown(s)) throw new SourceDown(s);
  try {
    const v = await fn();
    markOk(s);
    return v;
  } catch (e) {
    markFail(s, e);
    throw e;
  }
}

export type SourceHealth = { id: Source; name: string; down: boolean; forced: boolean; downUntil: number | null; lastError: string | null; lastOk: number | null; calls: number; errors: number; served: number };

export function sourcesHealth(): SourceHealth[] {
  const f = forced();
  return (Object.keys(SOURCE_NAMES) as Source[]).map((id) => {
    const st = state(id);
    return {
      id, name: SOURCE_NAMES[id], down: sourceDown(id), forced: f.has(id), downUntil: st.downUntil > Date.now() ? st.downUntil : null,
      lastError: st.lastError, lastOk: st.lastOk, calls: st.calls, errors: st.errors, served: st.served,
    };
  });
}

// ---------------------------------------------------------------- что отдали из сохранённого в этом запросе

type Served = Map<Source | "cache", number>;
const als = new AsyncLocalStorage<Served>();

/** Обёртка запроса API: собирает, какие данные отданы из сохранённого (источник → дата сохранения, самая старая). */
export function withServedLog<T>(fn: () => Promise<T>): Promise<{ value: T; served: Served }> {
  const served: Served = new Map();
  return als.run(served, async () => ({ value: await fn(), served }));
}

/** Отметить: данные отданы из сохранённого, потому что источник недоступен (fetchedAt — секунды). */
export function noteServed(source: Source | undefined, fetchedAt: number) {
  const m = als.getStore();
  if (source) state(source).served++;
  if (!m) return;
  const k = source ?? "cache";
  const prev = m.get(k);
  if (prev === undefined || fetchedAt < prev) m.set(k, fetchedAt);
}
