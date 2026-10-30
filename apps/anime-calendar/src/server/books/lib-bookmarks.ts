import "server-only";
import { bookTitles, titleMatch, type BookLite } from "@/lib/books";
import type { ListStatus } from "@/lib/types";
import { cached } from "../cache";
import { db, now } from "../db";
import type { User } from "../session";
import { searchBooks } from "./anilist-books";
import { setLink } from "./library";
import { libBookmarks, type LibBookmark } from "./providers/lib";
import { setEntry } from "./reading";

// Импорт закладок mangalib и ranobelib в список чтения (TASKS 5.5). Аккаунт Lib общий с AniLib — профиль берём оттуда.
// Id AniList в закладках нет: книга — по привязке провайдера (book_links), иначе поиском по названиям (русское — через
// Shikimori) с точным совпадением и проверкой вида. Найденная книга заодно привязывается к провайдеру.
// Главнее календарь: новое добавляется, у имеющегося только растёт число прочитанных глав, удалённое не возвращается.

const FOLDERS: Record<string, ListStatus> = {
  "читаю": "watching",
  "в планах": "planned",
  "брошено": "dropped",
  "прочитано": "completed",
  "отложено": "on_hold",
  "перечитываю": "rewatching",
};

export type BookImportItem = { title: string; url: string; folder: string };
export type BookImportProgress = {
  stage: "fetch" | "match" | "done" | "error";
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: { added: number; updated: number; same: number; skipped: number; removed: number; unmatched: BookImportItem[] };
};

const progress = new Map<number, BookImportProgress>();

/** Книга AniList для закладки: привязка провайдера → поиск (ненайденное перепроверяем через сутки). */
async function matchBookmark(b: LibBookmark): Promise<Pick<BookLite, "id" | "idMal"> | null> {
  const linked = db.prepare<[string, string], { book_id: number }>(
    "SELECT book_id FROM book_links WHERE provider = ? AND ref = ? AND how != 'hidden' LIMIT 1").get(b.provider, b.ref);
  if (linked) return { id: linked.book_id, idMal: null };
  const found = await cached<{ id: number | null; lite: BookLite | null }>(`lib-book:match:${b.provider}:${b.ref}`,
    { fresh: (v) => (v.id ? 365 * 86400 : 86400), source: "lib" }, async () => {
      for (const q of [b.titles.find((t) => /[а-яё]/i.test(t)), ...b.titles.filter((t) => !/[а-яё]/i.test(t))]) {
        if (!q) continue;
        const hits = await searchBooks(q, b.kind);
        const hit = hits.find((h) => titleMatch(bookTitles({ ...h, synonyms: [] }), b.titles) === 1);
        if (hit) return { id: hit.id, lite: hit };
      }
      return { id: null, lite: null };
    });
  return found.lite;
}

async function run(user: User, p: BookImportProgress): Promise<void> {
  const marks = await libBookmarks(user.lib_user_id!);
  Object.assign(p, { stage: "match", done: 0, total: marks.length });
  const result: NonNullable<BookImportProgress["result"]> = { added: 0, updated: 0, same: 0, skipped: 0, removed: 0, unmatched: [] };
  const entry = db.prepare<[number, number], { chapters: number; deleted: number }>("SELECT chapters, deleted FROM read_entries WHERE user_id = ? AND book_id = ?");
  for (const b of marks) {
    p.done++;
    const status = FOLDERS[b.folder.trim().toLowerCase()] ?? null;
    const book = await matchBookmark(b).catch(() => null);
    if (!book?.id) {
      result.unmatched.push({ title: b.title, url: b.url, folder: b.folder });
      continue;
    }
    // Своя закладка — надёжная привязка провайдера (если её не отметили «не та»)
    const hidden = db.prepare("SELECT 1 FROM book_links WHERE book_id = ? AND provider = ? AND ref = ? AND how = 'hidden'").get(book.id, b.provider, b.ref);
    if (hidden) { result.unmatched.push({ title: b.title, url: b.url, folder: b.folder }); continue; }
    setLink(book.id, b.provider, b.ref, "link", { title: b.title, edition: b.edition });
    const cur = entry.get(user.id, book.id);
    if (cur?.deleted) { result.removed++; continue; }
    if (!cur) {
      if (!status) { result.skipped++; continue; }
      setEntry(user.id, book.id, book.idMal ?? null, { status, chapters: b.chapter ?? 0 });
      result.added++;
    } else if (b.chapter && b.chapter > cur.chapters) {
      setEntry(user.id, book.id, book.idMal ?? null, { chapters: b.chapter });
      result.updated++;
    } else result.same++;
  }
  p.result = result;
}

/** Запустить импорт в фоне (или вернуть идущий). */
export function startBookImport(user: User): BookImportProgress {
  const cur = progress.get(user.id);
  if (cur && !cur.finishedAt) return cur;
  if (!user.lib_user_id) throw new Error("Профиль Lib не подключён — подключите его в карточке AniLib в Настройках");
  const p: BookImportProgress = { stage: "fetch", done: 0, total: 0, startedAt: now() };
  progress.set(user.id, p);
  void run(user, p)
    .then(() => Object.assign(p, { stage: "done", finishedAt: now() }))
    .catch((err) => {
      console.warn(`[lib-bookmarks] ${user.name}: ${String(err)}`);
      Object.assign(p, { stage: "error", error: err instanceof Error ? err.message : String(err), finishedAt: now() });
    });
  return p;
}

export const bookImportStatus = (user: User) => ({ linked: Boolean(user.lib_user_id), progress: progress.get(user.id) ?? null });
