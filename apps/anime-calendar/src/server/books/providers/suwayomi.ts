import "server-only";
import { parseNum, type ChapterRow } from "@/lib/books";
import { cached } from "../../cache";
import { guarded } from "../../sources";
import { providerConfig } from "../provider-config";
import { searchQueries, type Hit, type Provider } from "./types";

// Мост к расширениям Tachiyomi/Mihon через Suwayomi-Server (TASKS 5.9, контейнер профиля suwayomi): сотни сайтов
// манги — русские, которых нет в Lib, английские агрегаторы, японские сканы. Календарь ходит в его GraphQL; расширения
// ставятся из репозитория, который задаёт пользователь. Книга у провайдера — id манги в Suwayomi, глава — id главы;
// страницы отдаёт сам Suwayomi (внутри сети, через прокси календаря). Искать — только в выбранных источниках.

const base = () => providerConfig().suwayomi.url.replace(/\/+$/, "");

export async function suwa<T>(query: string, variables?: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  return guarded("suwayomi", async () => {
    const r = await fetch(`${base()}/api/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Suwayomi: ${r.status}`);
    const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(`Suwayomi: ${j.errors[0].message}`);
    return j.data as T;
  });
}

export type SuwaSource = { id: string; name: string; lang: string; displayName: string; isNsfw: boolean };
export const suwaSources = () => suwa<{ sources: { nodes: SuwaSource[] } }>(`{ sources { nodes { id name lang displayName isNsfw } } }`)
  .then((d) => d.sources.nodes.filter((s) => s.id !== "0"));

const abs = (u: string | null | undefined) => (u ? (/^https?:/.test(u) ? u : `${base()}${u.startsWith("/") ? "" : "/"}${u}`) : null);
/** Язык источника → наш код («all», «multi» — как английский) */
const langOf = (l: string) => {
  const x = l.toLowerCase();
  return x === "all" || x === "multi" ? "en" : x === "pt-br" ? "pt-br" : x.split("-")[0];
};

type SMangaHit = { id: number; title: string; thumbnailUrl: string | null; realUrl: string | null };
type SChapter = { id: number; name: string; chapterNumber: number; scanlator: string | null; uploadDate: string; sourceOrder: number };

export const suwayomi: Provider = {
  id: "suwayomi",
  name: "Suwayomi",
  kinds: ["manga"],
  langs: ["ru", "en", "ja", "ko", "zh"],
  source: "suwayomi",
  bookUrl: (ref) => `${base()}/manga/${ref}`,
  imageHost: (host) => {
    try { return host === new URL(base()).hostname; } catch { return false; }
  },
  ping: async () => { await suwa(`{ aboutServer { version } }`, undefined, 5000); },

  async search(book, query) {
    const ids = providerConfig().suwayomi.sources;
    if (!ids.length) return [];
    const names = new Map((await suwaSources()).map((s) => [s.id, s]));
    const hits: Hit[] = [];
    await Promise.all(ids.filter((id) => names.has(id)).map(async (id) => {
      const src = names.get(id)!;
      const seen = new Set<number>();
      for (const q of searchQueries(book, query, 2)) {
        try {
          const d = await cached(`suwa-search:${id}:${q.toLowerCase()}`, { fresh: 86400, source: "suwayomi" }, () =>
            suwa<{ fetchSourceManga: { mangas: SMangaHit[] } }>(
              `mutation ($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id title thumbnailUrl realUrl } } }`,
              { input: { source: id, type: "SEARCH", page: 1, query: q } }, 90_000));
          for (const m of d.fetchSourceManga.mangas.slice(0, 8)) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            hits.push({
              provider: "suwayomi", ref: String(m.id), title: m.title, titles: [m.title], year: null, cover: abs(m.thumbnailUrl),
              url: m.realUrl ?? `${base()}/manga/${m.id}`, edition: "main", note: `${src.displayName}`,
            });
          }
        } catch (e) {
          console.warn(`[suwayomi] ${src.displayName}: ${String(e).slice(0, 200)}`);
        }
      }
    }));
    return hits;
  },

  async chapters(ref) {
    const d = await suwa<{ fetchChapters: { chapters: SChapter[] }; manga: { source: SuwaSource | null } }>(
      `mutation ($id: Int!) { fetchChapters(input: { mangaId: $id }) { chapters { id name chapterNumber scanlator uploadDate sourceOrder } } }`,
      { id: Number(ref) }, 180_000).then(async (c) => ({
      ...c, ...(await suwa<{ manga: { source: SuwaSource | null } }>(`query ($id: Int!) { manga(id: $id) { source { id name lang displayName isNsfw } } }`, { id: Number(ref) })),
    }));
    const src = d.manga.source;
    const lang = src ? langOf(src.lang) : "en";
    return d.fetchChapters.chapters.map((c): ChapterRow => {
      const num = c.chapterNumber >= 0 ? c.chapterNumber : parseNum(c.name) ?? c.sourceOrder;
      return {
        provider: "suwayomi", ref, cref: String(c.id), edition: "main", lang,
        team: [src?.displayName, c.scanlator].filter(Boolean).join(" · ") || null,
        vol: null, num, numText: String(num), title: c.name, date: Math.floor(Number(c.uploadDate) / 1000) || null,
      };
    });
  },

  async content(_ref, cref) {
    const d = await suwa<{ fetchChapterPages: { pages: string[] } }>(
      `mutation ($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }`, { id: Number(cref) }, 180_000);
    return { kind: "pages", pages: d.fetchChapterPages.pages.map((u) => ({ url: abs(u)! })) };
  },
};
