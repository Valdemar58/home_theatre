import "server-only";
import type { Edition } from "@/lib/books";
import { db, now } from "../db";

// Чтение: где остановился в главе (абзац / страница), выбранный перевод книги, отметка прочитанного в списке.

export type ReadPos = { chapter: string; edition: Edition; provider: string; cref: string; pos: number; done: boolean; updatedAt: number };
/** Выбранный перевод книги: провайдер и команда (переключатель в ридере), шрифт и тема — у браузера */
export type BookPref = { provider?: string; team?: string | null; lang?: string; edition?: Edition };

export function readPositions(userId: number, bookId: number): ReadPos[] {
  return db.prepare<[number, number], { chapter: string; edition: Edition; provider: string; cref: string; pos: number; done: number; updated_at: number }>(
    "SELECT * FROM read_pos WHERE user_id = ? AND book_id = ? ORDER BY updated_at DESC").all(userId, bookId)
    .map((r) => ({ chapter: r.chapter, edition: r.edition, provider: r.provider, cref: r.cref, pos: r.pos, done: Boolean(r.done), updatedAt: r.updated_at }));
}

export function bookPref(userId: number, bookId: number): BookPref {
  const r = db.prepare<[number, number], { data: string }>("SELECT data FROM book_pref WHERE user_id = ? AND book_id = ?").get(userId, bookId);
  return r ? (JSON.parse(r.data) as BookPref) : {};
}

export function setBookPref(userId: number, bookId: number, pref: BookPref) {
  db.prepare("INSERT INTO book_pref (user_id, book_id, data) VALUES (?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET data = excluded.data")
    .run(userId, bookId, JSON.stringify({ ...bookPref(userId, bookId), ...pref }));
}

/**
 * Позиция в главе. Дочитал (done) — глава отмечается в списке чтения: «Читаю», прочитано глав — не меньше номера этой
 * (у книжного издания номер внутри тома — считаем главы издания по порядку, отмечаем порядковый номер).
 */
export function saveProgress(userId: number, bookId: number, p: { chapter: string; edition: Edition; provider: string; cref: string; pos: number; done: boolean; ordinal: number | null }) {
  const t = now();
  db.prepare(`INSERT INTO read_pos (user_id, book_id, chapter, edition, provider, cref, pos, done, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, book_id, edition, chapter) DO UPDATE SET provider = excluded.provider, cref = excluded.cref, pos = excluded.pos,
      done = max(done, excluded.done), updated_at = excluded.updated_at`)
    .run(userId, bookId, p.chapter, p.edition, p.provider, p.cref, p.pos, p.done ? 1 : 0, t);
  if (!p.done || !p.ordinal) return;
  const e = db.prepare<[number, number], { status: string; chapters: number; deleted: number }>("SELECT status, chapters, deleted FROM read_entries WHERE user_id = ? AND book_id = ?").get(userId, bookId);
  if (e && !e.deleted && e.chapters >= p.ordinal) return;
  const status = !e || e.deleted || e.status === "planned" || e.status === "on_hold" || e.status === "dropped" ? "watching" : e.status;
  db.prepare(`INSERT INTO read_entries (user_id, book_id, status, chapters, updated_at, dirty) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT (user_id, book_id) DO UPDATE SET status = excluded.status, chapters = max(read_entries.chapters, excluded.chapters),
      deleted = 0, updated_at = excluded.updated_at, dirty = 1`)
    .run(userId, bookId, status, p.ordinal, t);
}

export type ReadEntry = { bookId: number; status: string; chapters: number; volumes: number; score: number; note: string | null; updatedAt: number };

export function readEntry(userId: number, bookId: number): ReadEntry | null {
  const r = db.prepare<[number, number], { book_id: number; status: string; chapters: number; volumes: number; score: number; note: string | null; updated_at: number; deleted: number }>(
    "SELECT * FROM read_entries WHERE user_id = ? AND book_id = ?").get(userId, bookId);
  return r && !r.deleted ? { bookId: r.book_id, status: r.status, chapters: r.chapters, volumes: r.volumes, score: r.score, note: r.note, updatedAt: r.updated_at } : null;
}

/** Правка записи списка чтения (статус, оценка, глав прочитано); status null — убрать из списка. */
export function setEntry(userId: number, bookId: number, malId: number | null, patch: { status?: string | null; score?: number; chapters?: number }) {
  const t = now();
  if (patch.status === null) {
    db.prepare("UPDATE read_entries SET deleted = 1, dirty = 1, updated_at = ? WHERE user_id = ? AND book_id = ?").run(t, userId, bookId);
    return;
  }
  const cur = db.prepare<[number, number], { status: string; chapters: number; score: number; deleted: number }>(
    "SELECT status, chapters, score, deleted FROM read_entries WHERE user_id = ? AND book_id = ?").get(userId, bookId);
  const live = cur && !cur.deleted ? cur : null;
  db.prepare(`INSERT INTO read_entries (user_id, book_id, mal_id, status, chapters, score, updated_at, dirty, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT (user_id, book_id) DO UPDATE SET mal_id = excluded.mal_id, status = excluded.status, chapters = excluded.chapters,
      score = excluded.score, updated_at = excluded.updated_at, dirty = 1, deleted = 0`)
    .run(userId, bookId, malId, patch.status ?? live?.status ?? "planned", patch.chapters ?? live?.chapters ?? 0, patch.score ?? live?.score ?? 0, t);
}

/** Список чтения пользователя (свежие сверху). */
export function readList(userId: number): ReadEntry[] {
  return db.prepare<[number], { book_id: number; status: string; chapters: number; volumes: number; score: number; note: string | null; updated_at: number }>(
    "SELECT * FROM read_entries WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC").all(userId)
    .map((r) => ({ bookId: r.book_id, status: r.status, chapters: r.chapters, volumes: r.volumes, score: r.score, note: r.note, updatedAt: r.updated_at }));
}
