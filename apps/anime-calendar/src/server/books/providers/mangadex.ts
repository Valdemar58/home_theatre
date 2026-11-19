import "server-only";
import { parseNum, type ChapterRow } from "@/lib/books";
import { cached } from "../../cache";
import { expectOk, fetchWithRetry, RateLimiter } from "../../http";
import { guarded } from "../../sources";
import { searchQueries, type Content, type Hit, type Provider } from "./types";

// MangaDex — официальный API (5 запросов/с, без ключа). Переводы на ~40 языков с группами; лицензионное часто снято,
// официальные главы — только ссылкой. У книги записаны id AniList, MAL и MangaUpdates — связующее звено трекеров.

const API = "https://api.mangadex.org";
const limiter = new RateLimiter(250);
/** Какие переводы берём в оглавление (остальные языки не нужны и раздувают таблицу) */
const LANGS = ["ru", "en", "uk", "ja", "ko", "zh", "zh-hk"];

async function md<T>(path: string): Promise<T> {
  return guarded("mangadex", async () => {
    const res = await fetchWithRetry(`${API}${path}`, { headers: { "User-Agent": "anime-calendar/1.0", Accept: "application/json" } }, limiter, { timeoutMs: 25_000 });
    return (await (await expectOk(res, "MangaDex")).json()) as T;
  });
}

type MdManga = {
  id: string;
  attributes: {
    title: Record<string, string>; altTitles: Record<string, string>[]; year: number | null; status: string | null;
    lastChapter: string | null; lastVolume: string | null; originalLanguage: string; links: Record<string, string> | null;
    availableTranslatedLanguages: string[];
  };
  relationships: { type: string; attributes?: { fileName?: string } }[];
};

const titlesOf = (m: MdManga) => [...Object.values(m.attributes.title), ...m.attributes.altTitles.flatMap((t) => Object.values(t))];
const coverOf = (m: MdManga) => {
  const f = m.relationships.find((r) => r.type === "cover_art")?.attributes?.fileName;
  return f ? `https://uploads.mangadex.org/covers/${m.id}/${f}.256.jpg` : null;
};

const RATINGS = "contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica";

/** Поиск книги на MangaDex (кэш сутки). */
function mdSearch(q: string): Promise<MdManga[]> {
  return cached(`md-search:${q.toLowerCase()}`, { fresh: 86400, source: "mangadex" }, async () =>
    (await md<{ data: MdManga[] }>(`/manga?title=${encodeURIComponent(q)}&limit=10&${RATINGS}&includes[]=cover_art`)).data);
}

/** Метаданные книги MangaDex: ссылки на трекеры, статус, последняя глава (кэш — неделя). */
export type MdMeta = { id: string; links: Record<string, string>; status: string | null; lastChapter: number | null; lastVolume: number | null; originalLanguage: string; langs: string[] };
export function mdMeta(id: string): Promise<MdMeta> {
  return cached(`md-meta:${id}`, { fresh: 7 * 86400, source: "mangadex" }, async () => {
    const { data: m } = await md<{ data: MdManga }>(`/manga/${id}`);
    return {
      id, links: m.attributes.links ?? {}, status: m.attributes.status, lastChapter: parseNum(m.attributes.lastChapter),
      lastVolume: parseNum(m.attributes.lastVolume), originalLanguage: m.attributes.originalLanguage, langs: m.attributes.availableTranslatedLanguages,
    };
  });
}

type MdChapter = {
  id: string;
  attributes: { chapter: string | null; volume: string | null; title: string | null; translatedLanguage: string; publishAt: string; externalUrl: string | null; pages: number };
  relationships: { type: string; attributes?: { name?: string } }[];
};

export const mangadex: Provider = {
  id: "mangadex",
  name: "MangaDex",
  kinds: ["manga"],
  langs: LANGS,
  bookUrl: (ref) => `https://mangadex.org/title/${ref}`,
  source: "mangadex",
  ping: async () => { await md("/manga?limit=1"); },

  async search(book, query) {
    const hits = new Map<string, Hit>();
    for (const q of searchQueries(book, query)) {
      for (const m of await mdSearch(q)) {
        if (hits.has(m.id)) continue;
        const al = Number(m.attributes.links?.al) || null;
        hits.set(m.id, {
          provider: "mangadex", ref: m.id, title: m.attributes.title.en ?? Object.values(m.attributes.title)[0] ?? m.id,
          titles: titlesOf(m), year: m.attributes.year, cover: coverOf(m), url: `https://mangadex.org/title/${m.id}`, edition: "main",
          anilistId: al, note: [m.attributes.status, m.attributes.availableTranslatedLanguages.filter((l) => l === "ru" || l === "en").join(", ")].filter(Boolean).join(" · ") || null,
        });
      }
      // Нашлась сама книга (MangaDex знает id AniList) — остальные запросы не нужны
      if ([...hits.values()].some((h) => h.anilistId === book.id)) break;
    }
    return [...hits.values()];
  },

  async chapters(ref) {
    const rows: ChapterRow[] = [];
    const langs = LANGS.map((l) => `translatedLanguage[]=${l}`).join("&");
    for (let offset = 0; offset < 10_000; offset += 500) {
      const d = await md<{ data: MdChapter[]; total: number }>(
        `/manga/${ref}/feed?limit=500&offset=${offset}&${langs}&${RATINGS}&includeExternalUrl=1&order[volume]=asc&order[chapter]=asc&includes[]=scanlation_group`);
      for (const c of d.data) {
        const a = c.attributes;
        rows.push({
          provider: "mangadex", ref, edition: "main", lang: a.translatedLanguage,
          team: c.relationships.filter((r) => r.type === "scanlation_group").map((r) => r.attributes?.name).filter(Boolean).join(", ") || null,
          vol: parseNum(a.volume), num: parseNum(a.chapter), numText: a.chapter ?? "Ваншот", title: a.title?.trim() || null,
          date: Math.floor(Date.parse(a.publishAt) / 1000) || null, cref: c.id,
        });
      }
      if (offset + 500 >= d.total) break;
    }
    return rows;
  },

  async content(_ref, cref): Promise<Content> {
    const { data } = await md<{ data: MdChapter }>(`/chapter/${cref}`);
    if (data.attributes.externalUrl) return { kind: "external", url: data.attributes.externalUrl };
    const s = await md<{ baseUrl: string; chapter: { hash: string; data: string[] } }>(`/at-home/server/${cref}`);
    return { kind: "pages", pages: s.chapter.data.map((f) => ({ url: `${s.baseUrl}/data/${s.chapter.hash}/${f}` })) };
  },
};
