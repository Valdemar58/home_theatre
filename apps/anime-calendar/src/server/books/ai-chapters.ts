import "server-only";
import { aiCref } from "@/lib/book-translate";
import type { Block, ChapterRow, Edition } from "@/lib/books";
import { db } from "../db";
import { bestOutput } from "../knowledge";

// Главы, переведённые ИИ (TASKS 5.7): чтение готового — для оглавления и ридера (перевод — book-translate.ts).

export type AiStored = { blocks: Block[]; source: { provider: string; cref: string; lang: string } };
export const aiSubject = (bookId: number, edition: Edition, key: string) => `book:${bookId}:${edition}:${key}`;

/** Сохранённый перевод главы (лучший из имеющихся). */
export function aiChapter(bookId: number, edition: Edition, key: string) {
  return bestOutput<AiStored>("book_translate", aiSubject(bookId, edition, key), { policy: "tier-first", staleOk: true });
}

/** Главы ИИ в оглавлении — как строки провайдера «ai». */
export function aiRows(bookId: number): ChapterRow[] {
  return db.prepare<[number], { edition: Edition; chapter_key: string; vol: number | null; num: number | null; num_text: string; title: string | null; model: string | null; created_at: number }>(
    "SELECT * FROM book_ai WHERE book_id = ?").all(bookId).map((r) => ({
    provider: "ai", ref: "", cref: aiCref(r.edition, r.chapter_key), edition: r.edition, lang: "ai", team: r.model,
    vol: r.vol, num: r.num, numText: r.num_text, title: r.title, date: r.created_at,
  }));
}
