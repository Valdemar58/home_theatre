import "server-only";
import { db, now } from "../db";
import type { BookSourceState } from "@/lib/manga-sources";

// Добавочные таблицы не меняют старые ref/cref и не теряют сохранённые позиции чтения.
export function sourceState(bookId: number, state: Omit<BookSourceState, "checkedAt">) {
  db.prepare("INSERT INTO book_source_state VALUES (?, ?, ?, ?) ON CONFLICT (book_id, provider, source_id) DO UPDATE SET value = excluded.value")
    .run(bookId, state.provider, state.sourceId, JSON.stringify({ ...state, checkedAt: now() }));
}
export function sourceStates(bookId: number): BookSourceState[] {
  return db.prepare<[number], { value: string }>("SELECT value FROM book_source_state WHERE book_id = ?").all(bookId)
    .map((r) => JSON.parse(r.value) as BookSourceState);
}
export function rememberSource(provider: string, ref: string, sourceId: string) {
  db.prepare("INSERT INTO book_link_source VALUES (?, ?, ?) ON CONFLICT (provider, ref) DO UPDATE SET source_id = excluded.source_id").run(provider, ref, sourceId);
}
export function sourceOf(provider: string, ref: string): string | undefined {
  return db.prepare<[string, string], { source_id: string }>("SELECT source_id FROM book_link_source WHERE provider = ? AND ref = ?").get(provider, ref)?.source_id;
}
