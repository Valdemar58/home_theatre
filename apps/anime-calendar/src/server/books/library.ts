import "server-only";
import { ANILIST_STATUS_RU, muStatusChapters } from "@/lib/book-origin";
import { bookTitles, summarize, titleMatch, type BookDetails, type BookPage, type ChapterRow, type Edition, type Origin } from "@/lib/books";
import { db, now } from "../db";
import { bookDetails } from "./anilist-books";
import { mangalib, ranobelib } from "./providers/lib";
import { mangadex, mdMeta } from "./providers/mangadex";
import { narouNovel, syosetu } from "./providers/syosetu";
import type { Content, Hit, Provider } from "./providers/types";
import { ordered, providerConfig } from "./provider-config";
import { aiChapter, aiRows } from "./ai-chapters";
import { parseAiCref } from "@/lib/book-translate";
import { muFind, muSeries } from "./trackers";

// Книга целиком: сопоставление с провайдерами (book_links), оглавления (book_chapters), сводка глав, выход в
// оригинале, глава для ридера (chapter_content). Сеть — в фоне: страница сразу отдаёт сохранённое и «обновляется».

export const PROVIDERS: Provider[] = [ranobelib, syosetu, mangalib, mangadex];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);
/** Включённые провайдеры по порядку из настроек */
export const activeProviders = () => {
  const cfg = providerConfig();
  return ordered(PROVIDERS, cfg).filter((p) => !cfg.disabled.includes(p.id));
};
export const providersFor = (b: Pick<BookDetails, "kind">) => activeProviders().filter((p) => p.kinds.includes(b.kind === "novel" ? "novel" : "manga"));

type LinkRow = { book_id: number; provider: string; ref: string; title: string | null; edition: Edition; how: string; checked_at: number; chapters_at: number | null };
const linksOf = (bookId: number) => db.prepare<[number], LinkRow>("SELECT * FROM book_links WHERE book_id = ?").all(bookId);

/** Насколько находка похожа на книгу: 2 — провайдер знает наш id AniList, 1 — совпало название, 0,6 — подзаголовок. */
export function hitScore(book: BookDetails, h: Hit): number {
  if (h.anilistId) return h.anilistId === book.id ? 2 : 0;
  return titleMatch(bookTitles(book), h.titles, { ours: book.year, theirs: h.year });
}

const RELINK_SEC = 7 * 86400;

/** Найти книгу у провайдера (раз в неделю, если не нашли; ручная привязка не трогается). */
async function linkProvider(book: BookDetails, p: Provider): Promise<void> {
  const rows = linksOf(book.id).filter((l) => l.provider === p.id);
  if (rows.some((l) => l.how === "manual")) return;
  if (rows.length && rows.every((l) => now() - l.checked_at < RELINK_SEC)) return;
  const hits = await p.search(book);
  // Точные совпадения (у Lib — по изданию: веб и книжная версии — разные книги, обе подходят)
  const good = hits.filter((h) => hitScore(book, h) >= 1);
  const best = good.some((h) => hitScore(book, h) === 2) ? good.filter((h) => hitScore(book, h) === 2) : good;
  const t = now();
  db.transaction(() => {
    db.prepare("DELETE FROM book_links WHERE book_id = ? AND provider = ? AND how IN ('auto', 'none')").run(book.id, p.id);
    const hidden = new Set(rows.filter((l) => l.how === "hidden").map((l) => l.ref));
    const keep = best.filter((h) => !hidden.has(h.ref)).slice(0, 3);
    for (const h of keep) {
      db.prepare("INSERT OR IGNORE INTO book_links (book_id, provider, ref, title, edition, how, checked_at) VALUES (?, ?, ?, ?, ?, 'auto', ?)")
        .run(book.id, p.id, h.ref, h.title, h.edition, t);
    }
    if (!keep.length) db.prepare("INSERT OR IGNORE INTO book_links (book_id, provider, ref, title, edition, how, checked_at) VALUES (?, ?, '', NULL, 'main', 'none', ?)").run(book.id, p.id, t);
  })();
}

/** Ручная привязка («это та книга») или скрытие найденного («не та»). */
export function setLink(bookId: number, provider: string, ref: string, action: "link" | "hide", hit?: Pick<Hit, "title" | "edition">) {
  const t = now();
  if (action === "hide") {
    db.prepare("UPDATE book_links SET how = 'hidden', checked_at = ? WHERE book_id = ? AND provider = ? AND ref = ?").run(t, bookId, provider, ref);
    return;
  }
  db.prepare("DELETE FROM book_links WHERE book_id = ? AND provider = ? AND ref = ''").run(bookId, provider);
  db.prepare(`INSERT INTO book_links (book_id, provider, ref, title, edition, how, checked_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)
    ON CONFLICT (book_id, provider, ref) DO UPDATE SET how = 'manual', title = excluded.title, edition = excluded.edition, checked_at = excluded.checked_at`)
    .run(bookId, provider, ref, hit?.title ?? null, hit?.edition ?? "main", t);
}

/** Оглавление провайдера устарело: онгоинг — 6 ч, остальное — неделя. */
const chaptersStale = (l: LinkRow, live: boolean) => !l.chapters_at || now() - l.chapters_at > (live ? 6 * 3600 : 7 * 86400);

async function refreshChapters(l: LinkRow): Promise<void> {
  const p = providerById(l.provider);
  if (!p || !l.ref) return;
  const rows = await p.chapters(l.ref, l.edition);
  db.transaction(() => {
    db.prepare("DELETE FROM book_chapters WHERE provider = ? AND ref = ?").run(l.provider, l.ref);
    const ins = db.prepare(`INSERT OR REPLACE INTO book_chapters (provider, ref, cref, edition, lang, team, vol, num, num_text, title, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) ins.run(r.provider, r.ref, r.cref, r.edition, r.lang, r.team, r.vol, r.num, r.numText, r.title, r.date);
    db.prepare("UPDATE book_links SET chapters_at = ? WHERE provider = ? AND ref = ?").run(now(), l.provider, l.ref);
  })();
}

type ChRow = { provider: string; ref: string; cref: string; edition: Edition; lang: string; team: string | null; vol: number | null; num: number | null; num_text: string; title: string | null; date: number | null };

/** Главы всех привязанных книг (как ChapterRow). */
export function chapterRows(bookId: number): ChapterRow[] {
  const off = providerConfig().disabled;
  const links = linksOf(bookId).filter((l) => l.ref && l.how !== "hidden" && !off.includes(l.provider));
  if (!links.length) return aiRows(bookId);
  const rows = db.prepare<string[], ChRow>(
    `SELECT * FROM book_chapters WHERE ${links.map(() => "(provider = ? AND ref = ?)").join(" OR ")}`).all(...links.flatMap((l) => [l.provider, l.ref]));
  return [...rows.map((r) => ({ provider: r.provider, ref: r.ref, cref: r.cref, edition: r.edition, lang: r.lang, team: r.team, vol: r.vol, num: r.num, numText: r.num_text, title: r.title, date: r.date })),
    ...aiRows(bookId)];
}

// Обновления книги в фоне: одна на книгу за раз
const g = globalThis as unknown as { __bookSync?: Map<number, Promise<void>> };
const syncing = (g.__bookSync ??= new Map());

/** Найти книгу у провайдеров и обновить устаревшие оглавления (в фоне; ошибки провайдеров — в лог). */
export function syncBook(book: BookDetails, force = false): Promise<void> {
  const cur = syncing.get(book.id);
  if (cur) return cur;
  const live = book.status === "RELEASING" || book.status === "HIATUS";
  const job = (async () => {
    await Promise.all(providersFor(book).map(async (p) => {
      try {
        if (force) db.prepare("UPDATE book_links SET checked_at = 0 WHERE book_id = ? AND provider = ? AND how IN ('auto', 'none')").run(book.id, p.id);
        await linkProvider(book, p);
        for (const l of linksOf(book.id).filter((x) => x.provider === p.id && x.ref && x.how !== "hidden")) {
          if (force || chaptersStale(l, live)) await refreshChapters(l);
        }
      } catch (e) {
        console.warn(`[books] ${p.name} — «${book.title.romaji}»: ${String(e).slice(0, 200)}`);
      }
    }));
  })().finally(() => syncing.delete(book.id));
  syncing.set(book.id, job);
  return job;
}

export const isSyncing = (bookId: number) => syncing.has(bookId);

/** Выход в оригинале: Syosetu (веб-новелла), MangaUpdates (через MangaDex или поиск), иначе AniList. */
async function originOf(book: BookDetails): Promise<Origin> {
  const links = linksOf(book.id).filter((l) => l.ref && l.how !== "hidden");
  const narou = links.find((l) => l.provider === "syosetu");
  if (narou) {
    const n = await narouNovel(narou.ref).catch(() => null);
    if (n) return { status: `веб-версия: ${n.chapters} гл., ${n.ended ? "завершена" : "выходит"}`, chapters: n.chapters, volumes: null, ended: n.ended, source: "Syosetu", url: `https://ncode.syosetu.com/${n.ncode}/` };
  }
  const md = links.find((l) => l.provider === "mangadex");
  const muId = md ? (await mdMeta(md.ref).catch(() => null))?.links.mu : null;
  const mu = muId ? await muSeries(muId).catch(() => null) : await muFind(book).catch(() => null);
  if (mu?.statusRu) {
    return { status: mu.statusRu, chapters: muStatusChapters(mu.status) ?? mu.latest, volumes: null, ended: mu.completed, source: "MangaUpdates", url: mu.url };
  }
  return {
    status: [book.volumes ? `${book.volumes} т.` : null, book.chapters ? `${book.chapters} гл.` : null, book.status ? ANILIST_STATUS_RU[book.status] : null].filter(Boolean).join(", ") || null,
    chapters: book.chapters, volumes: book.volumes, ended: book.status === "FINISHED", source: "AniList", url: `https://anilist.co/manga/${book.id}`,
  };
}

/** Страница книги: сохранённое сразу, обновление — в фоне (клиент опрашивает, пока updating). */
export async function bookPage(id: number): Promise<BookPage> {
  const book = await bookDetails(id);
  const live = book.status === "RELEASING" || book.status === "HIATUS";
  const links = linksOf(id);
  const stale = providersFor(book).some((p) => {
    const ls = links.filter((l) => l.provider === p.id);
    return !ls.length || ls.some((l) => l.ref && l.how !== "hidden" && chaptersStale(l, live));
  });
  if (stale && !isSyncing(id)) void syncBook(book);
  const order = activeProviders().map((p) => p.id);
  const rank = (id: string) => order.indexOf(id);
  const origin = await originOf(book).catch((): Origin => ({ status: null, chapters: null, volumes: null, ended: null, source: "AniList", url: null }));
  return {
    book, origin,
    links: linksOf(id).filter((l) => l.how !== "hidden" && !providerConfig().disabled.includes(l.provider))
      .sort((a, b) => rank(a.provider) - rank(b.provider)).map((l) => {
      const p = providerById(l.provider);
      return { provider: l.provider, name: p?.name ?? l.provider, ref: l.ref, title: l.title, edition: l.edition, how: l.how, url: l.ref && p ? p.bookUrl(l.ref) : null, chaptersAt: l.chapters_at };
    }),
    editions: summarize(chapterRows(id)),
    updating: isSyncing(id),
  };
}

/** Поиск книги у провайдера для ручной привязки (с оценкой похожести). */
export async function providerSearch(bookId: number, provider: string, query?: string) {
  const book = await bookDetails(bookId);
  const p = providerById(provider);
  if (!p) throw new Error("Нет такого провайдера");
  const hits = await p.search(book, query);
  return hits.map((h) => ({ ...h, score: hitScore(book, h) })).sort((a, b) => b.score - a.score);
}

/** Глава для ридера: сохранённая или с провайдера (только из привязанных книг). Текст и страницы — без срока. */
export async function chapterContent(bookId: number, provider: string, cref: string): Promise<Content> {
  if (provider === "ai") {
    const { edition, key } = parseAiCref(cref);
    const k = aiChapter(bookId, edition as Edition, key);
    if (!k) throw new Error("Перевода ИИ этой главы нет");
    return { kind: "text", blocks: k.value.blocks };
  }
  // cref уникален только внутри книги провайдера — ищем среди книг, привязанных к этой
  const refs = linksOf(bookId).filter((l) => l.provider === provider && l.ref && l.how !== "hidden").map((l) => l.ref);
  const ch = refs.length ? db.prepare<string[], { ref: string }>(
    `SELECT ref FROM book_chapters WHERE provider = ? AND cref = ? AND ref IN (${refs.map(() => "?").join(",")})`).get(provider, cref, ...refs) : undefined;
  if (!ch) throw new Error("Этой главы нет у книги");
  const saved = db.prepare<[string, string, string], { kind: string; body: string }>("SELECT kind, body FROM chapter_body WHERE provider = ? AND ref = ? AND cref = ?").get(provider, ch.ref, cref);
  if (saved) return { kind: saved.kind, ...JSON.parse(saved.body) } as Content;
  const p = providerById(provider)!;
  const c = await p.content(ch.ref, cref);
  if (c.kind !== "external") {
    const { kind, ...body } = c;
    db.prepare("INSERT OR REPLACE INTO chapter_body (provider, ref, cref, kind, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(provider, ch.ref, cref, kind, JSON.stringify(body), now());
  }
  return c;
}
