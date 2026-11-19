import "server-only";
import { parseNum, type ChapterRow } from "@/lib/books";
import { mapSources, sourceLanguage } from "@/lib/manga-sources";
import { rememberSource, sourceState } from "../source-state";
import { guarded } from "../../sources";
import { providerConfig } from "../provider-config";
import { searchQueries, type Hit, type Provider } from "./types";

// Мост к расширениям Tachiyomi/Mihon через Suwayomi-Server (TASKS 5.9, контейнер профиля suwayomi): сотни сайтов
// манги — русские, которых нет в Lib, английские агрегаторы, японские сканы. Календарь ходит в его GraphQL; расширения
// ставятся из репозитория, который задаёт пользователь. Книга у провайдера — id манги в Suwayomi, глава — id главы;
// страницы отдаёт сам Suwayomi (внутри сети, через прокси календаря). Искать — только в выбранных источниках.

const base = () => providerConfig().suwayomi.url.replace(/\/+$/, "");

export async function suwa<T>(query: string, variables?: Record<string, unknown>, timeoutMs = 60_000, signal?: AbortSignal, isolated = false): Promise<T> {
  const run = async () => {
    const r = await fetch(`${base()}/api/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Suwayomi: ${r.status}`);
    const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(`Suwayomi: ${j.errors[0].message.split("\n")[0].slice(0, 300)}`);
    return j.data as T;
  };
  return isolated ? run() : guarded("suwayomi", run);
}

export type SuwaSource = { id: string; name: string; lang: string; displayName: string; isNsfw: boolean };
const caps = new Map<string, Promise<{ modern: boolean }>>();
export function suwaCapabilities() {
  const url = base();
  if (!caps.has(url)) {
    const promise = suwa<{ __type: { fields: { name: string }[] } }>(`{ __type(name: "Mutation") { fields { name } } }`)
      .then((d) => ({ modern: d.__type.fields.some((f) => f.name === "addExtensionStore") }));
    caps.set(url, promise);
    void promise.catch(() => caps.delete(url));
  }
  return caps.get(url)!;
}
export const suwaSources = async () => {
  const { modern } = await suwaCapabilities();
  const d = await suwa<{ sources: { nodes: SuwaSource[] } }>(`{ sources { nodes { id name lang displayName ${modern ? "" : "isNsfw"} } } }`);
  return d.sources.nodes.filter((s) => s.id !== "0");
};

const abs = (u: string | null | undefined) => (u ? (/^https?:/.test(u) ? u : `${base()}${u.startsWith("/") ? "" : "/"}${u}`) : null);
/** Язык источника → наш код («all», «multi» — как английский) */
const langOf = sourceLanguage;

type SMangaHit = { id: number; title: string; thumbnailUrl: string | null; realUrl: string | null };
type SChapter = { id: number; name: string; chapterNumber: number; scanlator: string | null; uploadDate: string; sourceOrder: number };

export const suwayomi: Provider = {
  id: "suwayomi",
  name: "Suwayomi",
  kinds: ["manga"],
  langs: ["ru", "en", "ja", "ko", "zh"],
  source: "suwayomi",
  bookUrl: (ref) => `${base()}/manga/${ref}`,
  imageHost: (host, protocol) => {
    try { const u = new URL(base()); return host === u.hostname && protocol === u.protocol; } catch { return false; }
  },
  ping: async () => { await suwa(`{ aboutServer { version } }`, undefined, 5000); },

  async search(book, query, options) {
    const cfg = providerConfig().suwayomi;
    const ids = options?.sourceId ? cfg.sources.filter((id) => id === options.sourceId) : cfg.sources;
    if (!ids.length) throw new Error("Источники манги не выбраны. Настройки → Расширения → Suwayomi: установите расширения и включите источники.");
    const names = new Map((await suwaSources()).map((s) => [s.id, s]));
    const hits: Hit[] = [];
    const results = await mapSources(ids, async (id) => {
      const src = names.get(id);
      if (!src) { sourceState(book.id, { provider: "suwayomi", sourceId: id, name: id, lang: null, status: "error", message: "Расширение не установлено или источник удалён", count: 0 }); throw new Error("Источник не установлен"); }
      const state = { provider: "suwayomi", sourceId: id, name: src.displayName, lang: sourceLanguage(src.lang), count: 0 };
      sourceState(book.id, { ...state, status: "searching", message: null });
      const deadline = AbortSignal.any([AbortSignal.timeout(90_000), ...(options?.signal ? [options.signal] : [])]);
      const seen = new Set<number>();
      let error: string | null = null;
      for (const q of searchQueries(book, query)) {
        try {
          const d = await suwa<{ fetchSourceManga: { mangas: SMangaHit[] } }>(
              `mutation ($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id title thumbnailUrl realUrl } } }`,
              { input: { source: id, type: "SEARCH", page: options?.page ?? 1, query: q } }, 30_000, deadline, true);
          for (const m of d.fetchSourceManga.mangas.slice(0, 40)) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            rememberSource("suwayomi", String(m.id), id);
            hits.push({
              provider: "suwayomi", ref: String(m.id), title: m.title, titles: [m.title], year: null, cover: abs(m.thumbnailUrl),
              sourceId: id, lang: sourceLanguage(src.lang),
              url: m.realUrl ?? `${base()}/manga/${m.id}`, edition: "main", note: `${src.displayName} · ${src.lang}`,
            });
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          break;
        }
      }
      sourceState(book.id, { ...state, count: seen.size, status: error ? "error" : seen.size ? "found" : "empty", message: error });
      if (error) throw new Error(error);
    });
    if (!hits.length && results.some((r) => r.status === "rejected")) throw new Error("Часть источников недоступна. Смотрите состояние источников и повторите поиск.");
    return hits;
  },

  async chapters(ref) {
    const { modern } = await suwaCapabilities();
    const sourceFields = `id name lang displayName ${modern ? "" : "isNsfw"}`;
    if (modern) {
      const d = await suwa<{ fetchMangaAndChapters: { chapters: SChapter[]; manga: { source: SuwaSource | null } } }>(
        `mutation ($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchChapters: true, fetchManga: false }) { chapters { id name chapterNumber scanlator uploadDate sourceOrder } manga { source { ${sourceFields} } } } }`, { id: Number(ref) }, 180_000, undefined, true);
      const src = d.fetchMangaAndChapters.manga.source;
      if (src) rememberSource("suwayomi", ref, src.id);
      return chapterRows(ref, d.fetchMangaAndChapters.chapters, src);
    }
    const d = await suwa<{ fetchChapters: { chapters: SChapter[] }; manga: { source: SuwaSource | null } }>(
      `mutation ($id: Int!) { fetchChapters(input: { mangaId: $id }) { chapters { id name chapterNumber scanlator uploadDate sourceOrder } } }`,
      { id: Number(ref) }, 180_000).then(async (c) => ({
      ...c, ...(await suwa<{ manga: { source: SuwaSource | null } }>(`query ($id: Int!) { manga(id: $id) { source { id name lang displayName isNsfw } } }`, { id: Number(ref) })),
    }));
    const src = d.manga.source;
    if (src) rememberSource("suwayomi", ref, src.id);
    return chapterRows(ref, d.fetchChapters.chapters, src);
  },

  async content(_ref, cref) {
    const d = await suwa<{ fetchChapterPages: { pages: string[] } }>(
      `mutation ($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }`, { id: Number(cref) }, 180_000, undefined, true);
    return { kind: "pages", pages: d.fetchChapterPages.pages.map((u) => ({ url: abs(u)! })) };
  },
};

function chapterRows(ref: string, chapters: SChapter[], src: SuwaSource | null): ChapterRow[] {
  return chapters.map((c) => {
    const numbered = /(?:chapter|ch\.?|глава|#)\s*(-?\d+(?:[.,]\d+)?)/i.exec(c.name);
    const num = numbered ? Number(numbered[1].replace(",", ".")) : c.chapterNumber !== -1 && Number.isFinite(c.chapterNumber) ? c.chapterNumber : null;
    return { provider: "suwayomi", ref, cref: String(c.id), edition: "main", lang: src ? langOf(src.lang) : "multi",
      team: [src?.displayName, c.scanlator].filter(Boolean).join(" · ") || null,
      vol: parseNum(/(?:vol\.?|volume|том)\s*(\d+)/i.exec(c.name)?.[1]), num, numText: num === null ? c.name : String(num), title: c.name,
      date: Math.floor(Number(c.uploadDate) / 1000) || null };
  });
}
