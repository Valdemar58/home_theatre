import "server-only";
import { rankPicks, seedWeight } from "@/lib/book-picks";
import type { BookLite } from "@/lib/books";
import { getCached } from "../cache";
import { db } from "../db";
import { bookDetails, similarBooks } from "./anilist-books";
import { booksFromMyAnime } from "./discover";

// «Для тебя» в режимах книг (TASKS 5.10): рекомендации читателей AniList к книгам из моего списка (вес — моя оценка)
// и первоисточники любимых аниме. Рекомендаций книги нет в хранилище — догружаются в фоне, страница переспрашивает.

const SEEDS = 24;
const g = globalThis as unknown as { __bookRecsFill?: boolean };

const isNovel = (b: Pick<BookLite, "kind">) => b.kind === "novel";

export async function bookPicks(userId: number, kind: "manga" | "novel") {
  const rows = db.prepare<[number], { book_id: number; status: string; score: number }>(
    "SELECT book_id, status, score FROM read_entries WHERE user_id = ? AND deleted = 0 ORDER BY score DESC, updated_at DESC").all(userId);
  const exclude = new Set(rows.map((r) => r.book_id));
  const lite = (id: number) => getCached<BookLite>(`book:lite:${id}`, true);
  // Источники — сначала книги того же вида, мало — добавляем другого (вкусы в манге и ранобэ близки)
  const all = rows.map((r) => ({ id: r.book_id, weight: seedWeight(r.status, r.score), book: lite(r.book_id) })).filter((s) => s.weight > 0);
  const same = all.filter((s) => s.book && isNovel(s.book) === (kind === "novel"));
  const seeds = (same.length >= 5 ? same : [...same, ...all.filter((s) => !same.includes(s)).map((s) => ({ ...s, weight: s.weight * 0.6 }))]).slice(0, SEEDS);

  const recs = new Map<number, number[]>();
  const missing: number[] = [];
  const books = new Map<number, BookLite>();
  for (const s of seeds) {
    const list = getCached<BookLite[]>(`book:recs:${s.id}`, true);
    if (!list) { missing.push(s.id); continue; }
    const fit = list.filter((b) => isNovel(b) === (kind === "novel"));
    for (const b of fit) books.set(b.id, b);
    recs.set(s.id, fit.map((b) => b.id));
  }
  if (missing.length && !g.__bookRecsFill) {
    g.__bookRecsFill = true;
    void (async () => { for (const id of missing) await similarBooks(id).catch(() => null); })().finally(() => { g.__bookRecsFill = false; });
  }
  const picks = rankPicks(seeds, recs, exclude, 36).map((p) => ({
    book: books.get(p.id)!, score: p.score,
    because: p.because.map((id) => ({ id, title: (() => { const b = lite(id); return b ? b.title.ru || b.title.romaji || b.title.english || String(id) : String(id); })() })),
  }));
  // Названия источников для «потому что» — если карточки нет, догрузить (в следующий раз будет)
  for (const s of seeds) if (!s.book) void bookDetails(s.id).catch(() => null);
  return { picks, fromAnime: booksFromMyAnime(userId, kind), seeds: seeds.length, partial: missing.length > 0 };
}
