import "server-only";
import { chapterKey, langGroup, type BookLite } from "@/lib/books";
import { getCached } from "../cache";
import { db } from "../db";
import { bookDetails } from "./anilist-books";
import { chapterRows } from "./library";

// «Выход глав» (TASKS 5.10) — календарь книг: какие главы вышли за последние недели у книг из моего списка
// (кроме прочитанных и брошенных), по оглавлениям провайдеров. Одна глава в нескольких переводах — одной строкой.

export type ReleaseItem = {
  bookId: number; date: number; key: string; numText: string; vol: number | null; edition: string;
  langs: { lang: string; team: string | null; provider: string; cref: string }[];
  /** Глава дальше прочитанного */
  unread: boolean;
};

const DAYS = 45;
const LIMIT = 400;

export async function bookReleases(userId: number): Promise<{ items: ReleaseItem[]; books: Record<number, BookLite & { status: string }> }> {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const entries = db.prepare<[number], { book_id: number; status: string; chapters: number }>(
    "SELECT book_id, status, chapters FROM read_entries WHERE user_id = ? AND deleted = 0 AND status NOT IN ('completed', 'dropped')").all(userId);
  const items: ReleaseItem[] = [];
  const books: Record<number, BookLite & { status: string }> = {};
  for (const e of entries) {
    const byKey = new Map<string, ReleaseItem>();
    for (const r of chapterRows(e.book_id)) {
      if (!r.date || r.date < since) continue;
      const key = `${r.edition}|${chapterKey(r.edition, r.vol, r.num, r.numText)}`;
      const it = byKey.get(key) ?? { bookId: e.book_id, date: r.date, key, numText: r.numText, vol: r.vol, edition: r.edition, langs: [], unread: (r.num ?? 0) > e.chapters };
      it.date = Math.max(it.date, r.date);
      if (!it.langs.some((l) => langGroup(l.lang) === langGroup(r.lang) && l.team === r.team)) it.langs.push({ lang: r.lang, team: r.team, provider: r.provider, cref: r.cref });
      byKey.set(key, it);
    }
    if (!byKey.size) continue;
    const lite = getCached<BookLite>(`book:lite:${e.book_id}`, true) ?? await bookDetails(e.book_id).catch(() => null);
    if (!lite) continue;
    books[e.book_id] = { ...lite, status: e.status };
    items.push(...byKey.values());
  }
  items.sort((a, b) => b.date - a.date);
  return { items: items.slice(0, LIMIT), books };
}
