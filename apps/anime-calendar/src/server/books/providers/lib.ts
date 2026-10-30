import "server-only";
import { docToBlocks, htmlToBlocks, parseNum, type ChapterRow, type Edition } from "@/lib/books";
import { cached } from "../../cache";
import { env } from "../../env";
import { expectOk, fetchWithRetry, HttpError, RateLimiter } from "../../http";
import { guarded } from "../../sources";
import { libToken } from "../provider-config";
import { searchQueries, type Content, type Hit, type Provider } from "./types";

// MangaLib и RanobeLib — общий Lib-API (тот же, что у AniLib, Site-Id: 1 — манга, 3 — ранобэ). Русские переводы,
// у каждой главы — ветки переводчиков. Без браузерных Referer/Origin API отвечает 403. Лицензионное часто удалено.

const limiter = new RateLimiter(350);

type LibSite = { id: string; name: string; siteId: 1 | 3; url: string; kind: "manga" | "novel" };

async function libGet<T>(site: LibSite, path: string): Promise<T> {
  return guarded("lib", async () => {
    const res = await fetchWithRetry(`${env.anilibApi}${path}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Site-Id": String(site.siteId), Referer: `${site.url}/`, Origin: site.url, Accept: "application/json",
        // Вход в Lib (токен из браузера) открывает книги 18+
        ...(libToken() ? { Authorization: `Bearer ${libToken()}` } : {}),
      },
    }, limiter, { timeoutMs: 25_000 });
    return (await (await expectOk(res, site.name)).json()) as T;
  });
}

type LibItem = {
  id: number; name: string; rus_name: string | null; eng_name: string | null; slug_url: string;
  cover?: { thumbnail?: string; default?: string }; releaseDateString?: string | null;
  status?: { label: string } | null; edition?: { short_name: string; name: string } | null;
  type?: { label: string } | null; is_licensed?: boolean;
};

type LibChapter = {
  volume: string; number: string; name: string | null;
  branches: { branch_id: number | null; created_at: string; teams: { name: string }[]; user?: { username: string } }[];
};

type LibChapterFull = { content: string | { type: string } | null; attachments?: { name?: string; filename?: string; url?: string }[];
  pages?: { url: string; width?: number; height?: number }[] };

/** Издание книги Lib: веб-новелла / книжная (ранобэ), у манги — одно. */
const editionOf = (site: LibSite, item: LibItem): Edition =>
  site.kind === "manga" ? "main" : item.edition?.short_name === "WN" ? "web" : "book";

/** Сервер картинок страниц (из справочника Lib; меняется редко). */
const imageServer = (site: LibSite) => cached(`lib-book:img-server:${site.siteId}`, { fresh: 7 * 86400, source: "lib" }, async () => {
  const d = await libGet<{ data: { imageServers: { id: string; url: string; site_ids: number[] }[] } }>(site, "/constants?fields[]=imageServers");
  return d.data.imageServers.find((s) => s.id === "main" && s.site_ids.includes(site.siteId))?.url ?? "https://img2.imglib.info";
});

function libProvider(site: LibSite): Provider {
  return {
    id: site.id,
    name: site.name,
    kinds: [site.kind],
    langs: ["ru"],
    imageHeaders: { Referer: `${site.url}/` },
    bookUrl: (ref) => `${site.url}/ru/${site.kind === "novel" ? "book" : "manga"}/${ref}`,
    source: "lib",
    ping: async () => { await libGet(site, "/constants?fields[]=imageServers"); },

    async search(book, query) {
      const hits = new Map<string, Hit>();
      for (const q of searchQueries(book, query)) {
        const d = await cached(`lib-search:${site.siteId}:${q.toLowerCase()}`, { fresh: 86400, source: "lib" },
          () => libGet<{ data: LibItem[] }>(site, `/manga?q=${encodeURIComponent(q)}&site_id[]=${site.siteId}`));
        for (const it of d.data) {
          if (hits.has(it.slug_url)) continue;
          hits.set(it.slug_url, {
            provider: site.id, ref: it.slug_url, title: it.rus_name || it.name,
            titles: [it.name, it.rus_name, it.eng_name].filter((x): x is string => Boolean(x)),
            year: parseNum(it.releaseDateString ?? null), cover: it.cover?.thumbnail ?? it.cover?.default ?? null,
            url: `${site.url}/ru/${site.kind === "novel" ? "book" : "manga"}/${it.slug_url}`, edition: editionOf(site, it),
            note: [it.edition?.name, it.type?.label, it.status?.label, it.is_licensed ? "лицензия" : null].filter(Boolean).join(" · ") || null,
          });
        }
      }
      return [...hits.values()];
    },

    async chapters(ref, edition) {
      const d = await libGet<{ data: LibChapter[] }>(site, `/manga/${ref}/chapters`);
      const rows: ChapterRow[] = [];
      for (const c of d.data) {
        for (const b of c.branches) {
          rows.push({
            provider: site.id, ref, edition, lang: "ru",
            team: b.teams.map((t) => t.name).filter((n) => n && n !== "Неизвестный").join(", ") || b.user?.username || null,
            vol: parseNum(c.volume), num: parseNum(c.number), numText: c.number, title: c.name?.trim() || null,
            date: Math.floor(Date.parse(b.created_at) / 1000) || null,
            cref: `${c.volume}|${c.number}|${b.branch_id ?? ""}`,
          });
        }
      }
      return rows;
    },

    async content(ref, cref): Promise<Content> {
      const [volume, number, branch] = cref.split("|");
      const q = `number=${encodeURIComponent(number)}&volume=${encodeURIComponent(volume)}${branch ? `&branch_id=${branch}` : ""}`;
      const { data } = await libGet<{ data: LibChapterFull }>(site, `/manga/${ref}/chapter?${q}`);
      if (site.kind === "manga") {
        const host = await imageServer(site);
        return { kind: "pages", pages: (data.pages ?? []).map((p) => ({ url: `${host}${p.url.replace(/^\/\//, "/")}`, w: p.width ?? null, h: p.height ?? null })) };
      }
      // Иллюстрации: в тексте — имя вложения или относительный путь
      const att = new Map((data.attachments ?? []).map((a) => [a.name ?? a.filename ?? "", a.url ?? ""]));
      const resolve = (src: string) => {
        const u = att.get(src) || src;
        return /^https?:/.test(u) ? u : `${site.url}${u.startsWith("/") ? "" : "/"}${u}`;
      };
      const c = data.content;
      if (!c) throw new HttpError(404, "Глава пуста");
      return { kind: "text", blocks: typeof c === "string" ? htmlToBlocks(c, resolve) : docToBlocks(c as Parameters<typeof docToBlocks>[0], resolve) };
    },
  };
}

const RANOBELIB: LibSite = { id: "ranobelib", name: "RanobeLib", siteId: 3, url: "https://ranobelib.me", kind: "novel" };
const MANGALIB: LibSite = { id: "mangalib", name: "MangaLib", siteId: 1, url: "https://mangalib.me", kind: "manga" };
export const ranobelib = libProvider(RANOBELIB);
export const mangalib = libProvider(MANGALIB);

/** Закладка Lib: папка, до какой главы дочитано, книга (ref — как у провайдера). */
export type LibBookmark = {
  provider: string; kind: "manga" | "novel"; folder: string; chapter: number | null; updatedAt: string;
  ref: string; title: string; titles: string[]; edition: Edition; url: string;
};

/** Закладки пользователя Lib на mangalib и ranobelib (аккаунт общий с AniLib, закладки публичные). */
export async function libBookmarks(libUserId: number): Promise<LibBookmark[]> {
  const out: LibBookmark[] = [];
  for (const site of [MANGALIB, RANOBELIB]) {
    const folders = new Map((await libGet<{ data: { id: number; name: string }[] }>(site, `/bookmarks/folder/${libUserId}`)).data.map((f) => [f.id, f.name]));
    for (let page = 1; page <= 100; page++) {
      const d = await libGet<{ data: { status: number; updated_at: string; meta: { item_number?: number | null } | null; media: LibItem | null }[]; meta?: { next_page_url?: unknown } }>(
        site, `/bookmarks?user_id=${libUserId}&status=0&page=${page}`);
      for (const b of d.data) {
        if (!b.media) continue;
        const m = b.media;
        out.push({
          provider: site.id, kind: site.kind, folder: folders.get(b.status) ?? `папка ${b.status}`, chapter: b.meta?.item_number || null,
          updatedAt: b.updated_at, ref: m.slug_url, title: m.rus_name || m.name,
          titles: [m.name, m.rus_name, m.eng_name].filter((x): x is string => Boolean(x)), edition: editionOf(site, m),
          url: `${site.url}/ru/${site.kind === "novel" ? "book" : "manga"}/${m.slug_url}`,
        });
      }
      if (!d.meta?.next_page_url || !d.data.length) break;
    }
  }
  return out;
}
