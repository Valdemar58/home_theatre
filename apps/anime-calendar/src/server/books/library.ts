import "server-only";
import { ANILIST_STATUS_RU, muStatusChapters } from "@/lib/book-origin";
import { bookTitles, summarize, titleMatch, type BookDetails, type BookPage, type ChapterRow, type Edition, type Origin } from "@/lib/books";
import { db, now } from "../db";
import { bookDetails } from "./anilist-books";
import { mangalib, ranobelib } from "./providers/lib";
import { mangadex, mdMeta } from "./providers/mangadex";
import { lnreader } from "./providers/lnreader";
import { narouNovel, syosetu } from "./providers/syosetu";
import { suwayomi } from "./providers/suwayomi";
import type { Content, Hit, Provider } from "./providers/types";
import { ordered, providerConfig } from "./provider-config";
import { aiChapter, aiRows } from "./ai-chapters";
import { rememberSource, sourceOf, sourceState, sourceStates } from "./source-state";
import { parseAiCref } from "@/lib/book-translate";
import { muFind, muSeries } from "./trackers";

// Книга целиком: сопоставление с провайдерами (book_links), оглавления (book_chapters), сводка глав, выход в
// оригинале, глава для ридера (chapter_content). Сеть — в фоне: страница сразу отдаёт сохранённое и «обновляется».

export const PROVIDERS: Provider[] = [ranobelib, syosetu, mangalib, mangadex, lnreader, suwayomi];
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
async function linkProvider(book: BookDetails, p: Provider, sourceId?: string): Promise<void> {
  const rows = linksOf(book.id).filter((l) => l.provider === p.id);
  const covered = p.id !== "suwayomi" || providerConfig().suwayomi.sources.every((id) => sourceStates(book.id)
    .some((s) => s.provider === p.id && s.sourceId === id && ["found", "empty"].includes(s.status) && now() - s.checkedAt < RELINK_SEC));
  if (!sourceId && covered && rows.length && rows.every((l) => now() - l.checked_at < RELINK_SEC)) return;
  const hits = await p.search(book, undefined, { sourceId });
  // Точные совпадения (у Lib — по изданию: веб и книжная версии — разные книги, обе подходят)
  const good = hits.filter((h) => hitScore(book, h) >= 1);
  const best = good.some((h) => hitScore(book, h) === 2) ? good.filter((h) => hitScore(book, h) === 2) : good;
  const t = now();
  db.transaction(() => {
    db.prepare("DELETE FROM book_links WHERE book_id = ? AND provider = ? AND how = 'none'").run(book.id, p.id);
    const hidden = new Set(rows.filter((l) => l.how === "hidden").map((l) => l.ref));
    const counts = new Map<string, number>();
    const keep = best.filter((h) => {
      const scope = h.sourceId ?? h.edition;
      const n = counts.get(scope) ?? 0;
      if (hidden.has(h.ref) || n >= 3) return false;
      counts.set(scope, n + 1); return true;
    });
    for (const h of keep) {
      db.prepare("INSERT INTO book_links (book_id, provider, ref, title, edition, how, checked_at) VALUES (?, ?, ?, ?, ?, 'auto', ?) ON CONFLICT DO NOTHING")
        .run(book.id, p.id, h.ref, h.title, h.edition, t);
      if (h.sourceId) rememberSource(p.id, h.ref, h.sourceId);
    }
    if (!keep.length && !rows.some((l) => l.ref) && !sourceStates(book.id).some((s) => s.provider === p.id && s.status === "error")) db.prepare("INSERT INTO book_links (book_id, provider, ref, title, edition, how, checked_at) VALUES (?, ?, '', NULL, 'main', 'none', ?) ON CONFLICT DO NOTHING").run(book.id, p.id, t);
    db.prepare("UPDATE book_links SET checked_at = ? WHERE book_id = ? AND provider = ?").run(t, book.id, p.id);
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
    const ins = db.prepare("INSERT INTO book_chapters (provider, ref, cref, edition, lang, team, vol, num, num_text, title, date)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, ref, cref) DO UPDATE SET edition = excluded.edition, lang = excluded.lang, team = excluded.team, vol = excluded.vol, num = excluded.num, num_text = excluded.num_text, title = excluded.title, date = excluded.date");
    for (const r of rows) ins.run(r.provider, r.ref, r.cref, r.edition, r.lang, r.team, r.vol, r.num, r.numText, r.title, r.date);
    db.prepare("UPDATE book_links SET chapters_at = ? WHERE provider = ? AND ref = ?").run(now(), l.provider, l.ref);
  })();
}

type ChRow = { provider: string; ref: string; cref: string; edition: Edition; lang: string; team: string | null; vol: number | null; num: number | null; num_text: string; title: string | null; date: number | null };

/** Главы всех привязанных книг (как ChapterRow). */
export function chapterRows(bookId: number): ChapterRow[] {
  const cfg = providerConfig();
  const off = cfg.disabled;
  const links = linksOf(bookId).filter((l) => l.ref && l.how !== "hidden" && !off.includes(l.provider) &&
    (l.provider !== "suwayomi" || !sourceOf(l.provider, l.ref) || cfg.suwayomi.sources.includes(sourceOf(l.provider, l.ref)!)));
  if (!links.length) return aiRows(bookId);
  const rows = db.prepare<string[], ChRow>(
    `SELECT * FROM book_chapters WHERE ${links.map(() => "(provider = ? AND ref = ?)").join(" OR ")}`).all(...links.flatMap((l) => [l.provider, l.ref]));
  const rank = (r: ChRow) => r.provider === "suwayomi" ? cfg.suwayomi.sources.indexOf(sourceOf(r.provider, r.ref) ?? "") : 0;
  rows.sort((a, b) => rank(a) - rank(b));
  return [...rows.map((r) => ({ provider: r.provider, ref: r.ref, cref: r.cref, edition: r.edition, lang: r.lang, team: r.team, vol: r.vol, num: r.num, numText: r.num_text, title: r.title, date: r.date })),
    ...aiRows(bookId)];
}

// Обновления книги в фоне: одна на книгу за раз
const g = globalThis as unknown as { __bookSync?: Map<number, Promise<void>> };
const syncing = (g.__bookSync ??= new Map());

/** Найти книгу у провайдеров и обновить устаревшие оглавления (в фоне; ошибки провайдеров — в лог). */
export function syncBook(book: BookDetails, force = false, only?: { provider: string; sourceId?: string }): Promise<void> {
  const cur = syncing.get(book.id);
  if (cur) return cur;
  const live = book.status === "RELEASING" || book.status === "HIATUS";
  const job = (async () => {
    await Promise.all(providersFor(book).filter((p) => !only || p.id === only.provider).map(async (p) => {
      const state = { provider: p.id, sourceId: "", name: p.name, lang: null, count: 0 };
      sourceState(book.id, { ...state, status: "searching", message: null });
      try {
        if (force) db.prepare("UPDATE book_links SET checked_at = 0 WHERE book_id = ? AND provider = ? AND how IN ('auto', 'none')").run(book.id, p.id);
        await linkProvider(book, p, only?.sourceId);
        let failed = false;
        for (const l of linksOf(book.id).filter((x) => x.provider === p.id && x.ref && x.how !== "hidden" &&
          (p.id !== "suwayomi" || !sourceOf(p.id, x.ref) || providerConfig().suwayomi.sources.includes(sourceOf(p.id, x.ref)!)) &&
          (!only?.sourceId || sourceOf(p.id, x.ref) === only.sourceId))) {
          try {
            if (force || chaptersStale(l, live)) await refreshChapters(l);
          } catch (e) {
            failed = true;
            const sid = sourceOf(p.id, l.ref) ?? "";
            const old = sourceStates(book.id).find((s) => s.provider === p.id && s.sourceId === sid);
            sourceState(book.id, { ...state, ...old, sourceId: sid, status: "error", message: `Главы: ${String(e).split("\n")[0].slice(0, 250)}` });
          }
        }
        const count = chapterRows(book.id).filter((r) => r.provider === p.id).length;
        sourceState(book.id, { ...state, status: failed ? "error" : count ? "found" : "empty", count, message: failed ? "Не все оглавления обновлены. Сохранённые главы доступны." : null });
      } catch (e) {
        sourceState(book.id, { ...state, status: "error", message: e instanceof Error ? e.message : String(e) });
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
    const lastError = sourceStates(id).find((s) => s.provider === p.id && s.sourceId === "" && s.status === "error");
    if (lastError && now() - lastError.checkedAt < 300) return false;
    return !ls.length || ls.some((l) => now() - l.checked_at >= RELINK_SEC || (l.ref && l.how !== "hidden" && chaptersStale(l, live)));
  });
  if (stale && !isSyncing(id)) void syncBook(book);
  const order = activeProviders().map((p) => p.id);
  const rank = (id: string) => order.indexOf(id);
  const origin = await originOf(book).catch((): Origin => ({ status: null, chapters: null, volumes: null, ended: null, source: "AniList", url: null }));
  return {
    book, origin, preferredLanguages: providerConfig().suwayomi.languages,
    sources: providersFor(book).flatMap((p) => {
      const states = sourceStates(id).filter((s) => s.provider === p.id && (!s.sourceId || p.id !== "suwayomi" || providerConfig().suwayomi.sources.includes(s.sourceId)));
      return states.length ? states : [{ provider: p.id, sourceId: "", name: p.name, lang: null, status: "setup" as const, message: p.id === "suwayomi" && !providerConfig().suwayomi.sources.length ? "Настройте источники в расширениях" : "Ещё не проверен", count: 0, checkedAt: 0 }];
    }),
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
export async function providerSearch(bookId: number, provider: string, query?: string, options?: { sourceId?: string; page?: number; signal?: AbortSignal }) {
  const book = await bookDetails(bookId);
  const p = providerById(provider);
  if (!p) throw new Error("Нет такого провайдера");
  const hits = await p.search(book, query, options);
  return hits.map((h) => ({ ...h, score: hitScore(book, h) })).sort((a, b) => b.score - a.score);
}

/** Глава для ридера: сохранённая или с провайдера (только из привязанных книг). Текст и страницы — без срока. */
export async function chapterContent(bookId: number, provider: string, cref: string, refresh = false): Promise<Content> {
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
  if (saved && !refresh) return { kind: saved.kind, ...JSON.parse(saved.body) } as Content;
  const p = providerById(provider)!;
  const c = await p.content(ch.ref, cref);
  if (c.kind !== "external") {
    const { kind, ...body } = c;
    db.prepare("INSERT INTO chapter_body (provider, ref, cref, kind, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider, ref, cref) DO UPDATE SET kind = excluded.kind, body = excluded.body, fetched_at = excluded.fetched_at")
      .run(provider, ch.ref, cref, kind, JSON.stringify(body), now());
  }
  return c;
}
