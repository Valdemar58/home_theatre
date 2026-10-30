import "server-only";
import { parseAdaptation, seasonRange, sourceForm, type AdaptForm, type AdaptRange, type AdaptUnit } from "@/lib/adapt";
import type { BookLite } from "@/lib/books";
import type { MediaLite } from "@/lib/types";
import { cached, getCached } from "./cache";
import { db, now } from "./db";
import { fetchWithRetry, HttpError, RateLimiter } from "./http";
import { guarded } from "./sources";

// Что из книги адаптирует сезон (TASKS 5.10): ручная правка (adapt_manual) важнее Fandom, Fandom — сопоставления
// по сюжету (plot_align, TASKS 5.11). С Fandom — по страницам
// серий, которые уже нашёл корпус сюжета (episode_text, source = fandom): поле adaptation / chapters / volume
// в инфобоксе. Нет корпуса — только ручная правка.

const UA = "home-theater/1.0 (personal media server)";
const limiter = new RateLimiter(700);

export type AlignRow = {
  ep: number; book_id: number; edition: string; from_key: string; to_key: string;
  from_num: number | null; to_num: number | null; from_vol: number | null; to_vol: number | null; score: number | null;
};

/** Серии сезона ↔ главы книги, сопоставленные по сюжету (TASKS 5.11). */
export const alignRows = (animeId: number) =>
  db.prepare<[number], AlignRow>("SELECT * FROM plot_align WHERE anime_id = ? ORDER BY ep").all(animeId);

type Manual = { anime_id: number; form: AdaptForm; unit: AdaptUnit; from_n: number; to_n: number };

/** Страницы серий тайтла на Fandom: вики и названия (из ссылок корпуса). */
function fandomPages(animeId: number): { wiki: string; titles: string[] } | null {
  const rows = db.prepare<[number], { url: string }>(
    "SELECT DISTINCT url FROM episode_text WHERE anilist_id = ? AND source = 'fandom' AND retracted_at IS NULL AND url IS NOT NULL").all(animeId);
  const parsed = rows.map((r) => r.url.match(/^https:\/\/([a-z0-9-]+)\.fandom\.com\/wiki\/(.+)$/i)).filter((m): m is RegExpMatchArray => Boolean(m));
  if (!parsed.length) return null;
  return { wiki: parsed[0][1], titles: parsed.filter((m) => m[1] === parsed[0][1]).map((m) => decodeURIComponent(m[2]).replace(/_/g, " ")) };
}

const fandomKey = (id: number) => `fandom-adapt:${id}`;

/** Диапазон сезона по Fandom (в хранилище навсегда; null — данных нет). */
function fandomRange(anime: Pick<MediaLite, "id" | "source">): Promise<Omit<AdaptRange, "source"> | null> {
  return cached(fandomKey(anime.id), { fresh: 180 * 86400, source: "fandom" }, () => guarded("fandom", async () => {
    const pages = fandomPages(anime.id);
    if (!pages) return null;
    const eps: ReturnType<typeof parseAdaptation>[] = [];
    for (let i = 0; i < pages.titles.length; i += 50) {
      const url = `https://${pages.wiki}.fandom.com/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(pages.titles.slice(i, i + 50).join("|"))}`;
      const res = await fetchWithRetry(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, limiter, { timeoutMs: 30_000 });
      if (!res.ok) throw new HttpError(res.status, `Fandom: ${res.status}`);
      const j = (await res.json()) as { query?: { pages?: { revisions?: { slots: { main: { content: string } } }[] }[] } };
      for (const p of j.query?.pages ?? []) eps.push(parseAdaptation(p.revisions?.[0]?.slots.main.content ?? ""));
    }
    return seasonRange(eps, sourceForm(anime.source));
  }));
}

// Сбор с Fandom — в фоне, по одному тайтлу
const g = globalThis as unknown as { __adaptFill?: { queue: Pick<MediaLite, "id" | "source">[]; running: boolean } };
const fill = (g.__adaptFill ??= { queue: [], running: false });
function fetchLater(m: Pick<MediaLite, "id" | "source">) {
  if (fill.queue.some((x) => x.id === m.id)) return;
  fill.queue.push(m);
  if (fill.running) return;
  fill.running = true;
  void (async () => {
    while (fill.queue.length) await fandomRange(fill.queue.shift()!).catch((e) => console.warn(`[adapt] ${String(e).slice(0, 200)}`));
    fill.running = false;
  })();
}

/** Диапазоны сезонов: ручная правка, иначе Fandom из хранилища (нет — догрузка в фоне, если есть корпус). */
export function adaptRanges(anime: Pick<MediaLite, "id" | "source">[]): Map<number, AdaptRange> {
  const out = new Map<number, AdaptRange>();
  if (!anime.length) return out;
  const manual = new Map(db.prepare<number[], Manual>(`SELECT * FROM adapt_manual WHERE anime_id IN (${anime.map(() => "?").join(",")})`)
    .all(...anime.map((a) => a.id)).map((m) => [m.anime_id, m]));
  for (const a of anime) {
    const m = manual.get(a.id);
    if (m) { out.set(a.id, { form: m.form, unit: m.unit, from: m.from_n, to: m.to_n, source: "manual" }); continue; }
    const f = getCached<Omit<AdaptRange, "source"> | null>(fandomKey(a.id), true);
    if (f) { out.set(a.id, { ...f, source: "fandom" }); continue; }
    if (f === undefined && fandomPages(a.id)) fetchLater(a);
    const p = plotRange(a.id);
    if (p) out.set(a.id, p);
  }
  return out;
}

/** Диапазон сезона по сопоставлению с сюжетом: тома, если у глав есть тома, иначе главы. */
function plotRange(animeId: number): AdaptRange | null {
  const rows = alignRows(animeId);
  if (!rows.length) return null;
  const book = getCached<BookLite>(`book:lite:${rows[0].book_id}`, true);
  const form: AdaptForm = book?.kind === "novel" ? "novel" : "manga";
  const first = rows[0], last = rows.at(-1)!;
  if (first.from_vol && last.to_vol) return { form, unit: "vol", from: first.from_vol, to: last.to_vol, source: "plot" };
  if (first.from_num === null || last.to_num === null) return null;
  return { form, unit: "ch", from: first.from_num, to: last.to_num, source: "plot" };
}

/** Ручная правка: диапазон или null — убрать (вернётся Fandom, если есть). */
export function setAdapt(userId: number, animeId: number, r: { form: AdaptForm; unit: AdaptUnit; from: number; to: number } | null) {
  if (!r) return void db.prepare("DELETE FROM adapt_manual WHERE anime_id = ?").run(animeId);
  db.prepare(`INSERT INTO adapt_manual (anime_id, form, unit, from_n, to_n, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (anime_id) DO UPDATE SET form = excluded.form, unit = excluded.unit, from_n = excluded.from_n, to_n = excluded.to_n,
      user_id = excluded.user_id, updated_at = excluded.updated_at`).run(animeId, r.form, r.unit, Math.min(r.from, r.to), Math.max(r.from, r.to), userId, now());
}
