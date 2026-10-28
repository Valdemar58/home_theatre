import "server-only";
import type { Filters } from "@/lib/filters";
import type { MediaLite } from "@/lib/types";
import { browse, type BrowseParams } from "./anilist";
import { db, now } from "./db";
import { withShikimori } from "./lists";
import { isOutage, noteServed, SourceDown } from "./sources";
import { shikiSearch } from "./shikimori";

// Каталог и поиск. По-русски ищет Shikimori (AniList знает только латиницу и японский),
// найденные MAL id догружаются из AniList одним запросом — уже с фильтрами каталога.

const CYRILLIC = /\p{Script=Cyrillic}/u;
const PAGE = 40; // = perPage каталога AniList

export async function searchCatalog(p: BrowseParams): Promise<{ media: MediaLite[]; hasNextPage: boolean }> {
  try {
    return await searchOnline(p);
  } catch (e) {
    // AniList или Shikimori лежат — ищем по сохранённым тайтлам (карточки и страницы архива)
    if (!isOutage(e)) throw e;
    noteServed(e instanceof SourceDown ? e.source : "anilist", now());
    return localSearch(p);
  }
}

// ---------------------------------------------------------------- без сети: по архиву

let index: { at: number; items: { m: MediaLite; text: string }[] } | null = null;

/** Все сохранённые тайтлы (карточки и страницы) с русскими названиями — раз в 5 минут. */
function localIndex() {
  if (index && Date.now() - index.at < 300_000) return index.items;
  const byId = new Map<number, MediaLite>();
  for (const r of db.prepare<[], { value: string }>("SELECT value FROM cache WHERE key LIKE 'lite:%' OR key LIKE 'media:v2:%'").all()) {
    const m = JSON.parse(r.value) as MediaLite;
    if (m?.id && !m.isAdult) byId.set(m.id, m);
  }
  const ru = new Map(db.prepare<[], { mal_id: number; russian: string | null; score: number | null }>("SELECT mal_id, russian, score FROM titles_ru").all().map((r) => [r.mal_id, r]));
  const items = [...byId.values()].map((m) => {
    const r = m.idMal ? ru.get(m.idMal) : undefined;
    const lite: MediaLite = { ...m, title: { ...m.title, ru: r?.russian ?? m.title.ru }, malScore: r?.score || m.malScore };
    return { m: lite, text: norm([lite.title.ru, lite.title.romaji, lite.title.english, lite.title.native].filter(Boolean).join(" ")) };
  });
  index = { at: Date.now(), items };
  return items;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function localSearch(p: BrowseParams): { media: MediaLite[]; hasNextPage: boolean } {
  const words = norm(p.filters.q).split(" ").filter(Boolean);
  const found = localIndex()
    .filter(({ m, text }) => words.every((w) => text.includes(w)) && (!p.season || m.season === p.season) && (!p.year || m.seasonYear === p.year))
    .map(({ m }) => m)
    .sort((a, b) => b.popularity - a.popularity);
  const start = (p.page - 1) * PAGE;
  return { media: structuredClone(found.slice(start, start + PAGE)), hasNextPage: found.length > start + PAGE };
}

async function searchOnline(p: BrowseParams): Promise<{ media: MediaLite[]; hasNextPage: boolean }> {
  const q = p.filters.q.trim();
  let result: { media: MediaLite[]; hasNextPage: boolean };
  if (q && CYRILLIC.test(q)) {
    const malIds = await shikiSearch(q, PAGE, p.page);
    result = malIds.length
      ? { media: (await browse({ ...p, page: 1, malIds })).media, hasNextPage: malIds.length === PAGE }
      : { media: [], hasNextPage: false };
  } else {
    result = await browse(p);
  }
  const media = structuredClone(result.media);
  await withShikimori(media);
  return { media, hasNextPage: result.hasNextPage };
}

/** Подсказки в строке поиска: первые 8 из того же поиска (кэш общий с каталогом). */
export async function suggest(q: string, filters: Filters): Promise<MediaLite[]> {
  if (q.trim().length < 2) return [];
  return (await searchCatalog({ page: 1, filters: { ...filters, q } })).media.slice(0, 8);
}
