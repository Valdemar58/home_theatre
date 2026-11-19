import "server-only";
import { bookTitles, titleMatch, type BookDetails } from "@/lib/books";
import { muStatusRu } from "@/lib/book-origin";
import { cached } from "../cache";
import { expectOk, fetchWithRetry, RateLimiter } from "../http";
import { guarded } from "../sources";

// MangaUpdates — трекер выхода: статус в стране оригинала («32 Volumes (Ongoing)»), последняя английская глава.
// Id — из MangaDex (ссылка «mu» — тот же id в base36) или поиском по названию с проверкой года и вида.

const API = "https://api.mangaupdates.com/v1";
const limiter = new RateLimiter(500);

async function mu<T>(path: string, body?: unknown): Promise<T> {
  return guarded("mangaupdates", async () => {
    const res = await fetchWithRetry(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "User-Agent": "anime-calendar/1.0", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, limiter, { timeoutMs: 25_000 });
    return (await (await expectOk(res, "MangaUpdates")).json()) as T;
  });
}

export type MuSeries = { id: number; url: string; status: string | null; statusRu: string | null; latest: number | null; completed: boolean | null; type: string | null; year: number | null };

type RawSeries = { series_id: number; url: string; status: string | null; latest_chapter: number | null; completed: boolean | null; type: string | null; year: string | null };

const toSeries = (s: RawSeries): MuSeries => ({
  id: s.series_id, url: s.url, status: s.status, statusRu: muStatusRu(s.status), latest: s.latest_chapter || null,
  completed: s.completed, type: s.type, year: Number(s.year) || null,
});

/** Серия по id (из MangaDex — base36 «04gtb06»). Статус меняется редко — раз в сутки. */
export function muSeries(id: number | string): Promise<MuSeries> {
  const num = typeof id === "number" ? id : /^\d+$/.test(id) ? Number(id) : parseInt(id, 36);
  return cached(`mu-series:${num}`, { fresh: 86400, source: "mangaupdates" }, async () => toSeries(await mu<RawSeries>(`/series/${num}`)));
}

/** Найти серию по названиям книги (тип — новелла или манга, год ±1). */
export async function muFind(book: BookDetails): Promise<MuSeries | null> {
  const q = book.title.romaji ?? book.title.english;
  if (!q) return null;
  const found = await cached(`mu-search:${q.toLowerCase()}`, { fresh: 7 * 86400, source: "mangaupdates" }, async () => {
    const d = await mu<{ results: { record: RawSeries & { title: string; associated?: { title: string }[] } }[] }>("/series/search", { search: q, perpage: 10 });
    // У новеллы, когда есть одноимённая манга, MangaUpdates дописывает «(Novel)» — для сравнения убираем
    const clean = (t: string) => t.replace(/\s*\((?:light |web )?novel\)\s*$/i, "");
    return d.results.map((r) => ({ ...toSeries(r.record), titles: [r.record.title, ...(r.record.associated ?? []).map((a) => a.title)].map(clean) }));
  });
  const novel = book.format === "NOVEL";
  const best = found.find((s) => (s.type === "Novel") === novel && titleMatch(bookTitles(book), s.titles, { ours: book.year, theirs: s.year }) === 1);
  return best ? await muSeries(best.id).catch(() => best) : null;
}
