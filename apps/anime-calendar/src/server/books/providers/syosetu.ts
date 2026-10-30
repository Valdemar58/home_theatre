import "server-only";
import { decodeEntities, htmlToBlocks, type Block, type ChapterRow } from "@/lib/books";
import { cached } from "../../cache";
import { expectOk, fetchWithRetry, RateLimiter } from "../../http";
import { guarded } from "../../sources";
import type { Content, Hit, Provider } from "./types";

// Syosetu (Shōsetsuka ni Narō) — японский оригинал веб-новелл. Официальный API отдаёт карточку (сколько глав,
// закончена ли), оглавление и текст глав — со страниц сайта (по 100 глав на странице оглавления).

const limiter = new RateLimiter(1000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36";

async function get(url: string, what: string): Promise<Response> {
  return guarded("syosetu", async () => expectOk(await fetchWithRetry(url, { headers: { "User-Agent": UA } }, limiter, { timeoutMs: 25_000 }), what));
}

export type NarouNovel = { ncode: string; title: string; writer: string; chapters: number; ended: boolean; updatedAt: string; story: string };
type RawNovel = { ncode: string; title: string; writer: string; general_all_no: number; end: number; novelupdated_at: string; story: string };
const toNovel = (n: RawNovel): NarouNovel => ({
  ncode: n.ncode.toLowerCase(), title: n.title, writer: n.writer, chapters: n.general_all_no,
  // end: 0 — закончена (API так и называет), 1 — продолжается
  ended: n.end === 0, updatedAt: n.novelupdated_at, story: n.story,
});

const API = "https://api.syosetu.com/novelapi/api/?out=json&of=n-t-w-ga-e-nu-s";

/** Поиск по названию (только в заголовках): по общим очкам (order=hyper) — старые знаменитые романы тоже первыми. */
function narouSearch(word: string): Promise<NarouNovel[]> {
  return cached(`narou-search:v2:${word}`, { fresh: 86400, source: "syosetu" }, async () => {
    const res = await get(`${API}&lim=20&title=1&order=hyper&word=${encodeURIComponent(word)}`, "Syosetu");
    const [, ...rows] = (await res.json()) as [{ allcount: number }, ...RawNovel[]];
    return rows.map(toNovel);
  });
}

/** Карточка веб-новеллы: сколько глав и закончена ли (раз в сутки). */
export function narouNovel(ncode: string): Promise<NarouNovel | null> {
  return cached(`narou-novel:${ncode}`, { fresh: 86400, source: "syosetu" }, async () => {
    const res = await get(`${API}&ncode=${ncode}`, "Syosetu");
    const [, row] = (await res.json()) as [{ allcount: number }, RawNovel?];
    return row ? toNovel(row) : null;
  });
}

/** Оглавление со страниц сайта: номер, название, дата (страница — 100 глав). */
export function parseToc(html: string, ncode: string): { num: number; title: string; date: number | null }[] {
  const out: { num: number; title: string; date: number | null }[] = [];
  const re = new RegExp(`<a href="/${ncode}/(\\d+)/" class="p-eplist__subtitle">([\\s\\S]*?)</a>[\\s\\S]*?class="p-eplist__update">\\s*([\\d/: ]+)`, "g");
  for (const m of html.matchAll(re)) {
    const [y, mo, d, h, mi] = m[3].trim().split(/[/: ]+/).map(Number);
    out.push({ num: Number(m[1]), title: decodeEntities(m[2].trim()), date: y ? Math.floor(Date.UTC(y, mo - 1, d, (h || 0) - 9, mi || 0) / 1000) : null });
  }
  return out;
}

/** Текст главы: основной текст, предисловие и послесловие автора — через разделитель. */
export function parseEpisode(html: string): Block[] {
  const parts: Block[][] = [];
  for (const m of html.matchAll(/<div class="js-novel-text p-novel__text( p-novel__text--(?:preface|afterword))?"[^>]*>([\s\S]*?)<\/div>/g)) {
    parts.push(htmlToBlocks(m[2]).map((b) => (b.t === "p" ? { ...b, text: b.text.replace(/^　+/, "") } : b)));
  }
  return parts.flatMap((p, i) => (i ? [{ t: "hr" } as Block, ...p] : p));
}

export const syosetu: Provider = {
  id: "syosetu",
  name: "Syosetu",
  kinds: ["novel"],
  langs: ["ja"],
  bookUrl: (ref) => `https://ncode.syosetu.com/${ref}/`,
  source: "syosetu",
  ping: async () => { await get(`${API}&lim=1`, "Syosetu"); },

  async search(book, query) {
    // Код или адрес Syosetu (n9669bk, ncode.syosetu.com/n9669bk/) — напрямую: автор может исключить роман из поиска
    const code = query?.match(/(n\d{4}[a-z]{1,3})/i)?.[1]?.toLowerCase();
    if (code) {
      const n = await narouNovel(code);
      if (!n) return [];
      return [{ provider: "syosetu", ref: n.ncode, title: n.title, titles: [n.title], year: null, cover: null,
        url: `https://ncode.syosetu.com/${n.ncode}/`, edition: "web", note: `${n.writer} · ${n.chapters} гл. · ${n.ended ? "закончена" : "выходит"}` }];
    }
    // Веб-новеллы — японские: ищем по родному названию (без подзаголовка в скобках — у Syosetu он часто другой)
    const words = query ? [query] : [book.title.native, ...book.synonyms.filter((s) => /[぀-ヿ一-鿿]/.test(s))]
      .filter((x): x is string => Boolean(x)).map((t) => t.replace(/[～〜~(（【-].*$/, "").trim()).filter((t) => t.length >= 2);
    const hits = new Map<string, Hit>();
    for (const w of [...new Set(words)].slice(0, 2)) {
      for (const n of await narouSearch(w)) {
        if (hits.has(n.ncode)) continue;
        hits.set(n.ncode, {
          // Год начала API не отдаёт (только обновления) — по году не сверяем
          provider: "syosetu", ref: n.ncode, title: n.title, titles: [n.title], year: null,
          cover: null, url: `https://ncode.syosetu.com/${n.ncode}/`, edition: "web",
          note: `${n.writer} · ${n.chapters} гл. · ${n.ended ? "закончена" : "выходит"}`,
        });
      }
    }
    return [...hits.values()];
  },

  async chapters(ref) {
    const novel = await narouNovel(ref);
    const total = novel?.chapters ?? 0;
    const rows: ChapterRow[] = [];
    // Однотомник (короткий рассказ) — одна «глава» на главной странице
    const pages = Math.max(1, Math.ceil(total / 100));
    for (let p = 1; p <= pages && p <= 60; p++) {
      const res = await get(`https://ncode.syosetu.com/${ref}/?p=${p}`, "Syosetu");
      for (const e of parseToc(await res.text(), ref)) {
        rows.push({ provider: "syosetu", ref, edition: "web", lang: "ja", team: null, vol: null, num: e.num, numText: String(e.num), title: e.title, date: e.date, cref: String(e.num) });
      }
    }
    return rows;
  },

  async content(ref, cref): Promise<Content> {
    const res = await get(`https://ncode.syosetu.com/${ref}/${cref}/`, "Syosetu");
    return { kind: "text", blocks: parseEpisode(await res.text()) };
  },
};
