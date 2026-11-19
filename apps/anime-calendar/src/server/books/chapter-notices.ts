import "server-only";
import { summarize } from "@/lib/books";
import { chapterNotice, chapterSnap, mergeSnap, type ChapterSnap } from "@/lib/chapter-notice";
import { db } from "../db";
import { notify } from "../notifications";
import { bookDetails } from "./anilist-books";
import { chapterRows, syncBook } from "./library";

// Новые главы у книг в «Читаю» (TASKS 5.5): раз в час обновить устаревшие оглавления (онгоинг — раз в 6 ч, это решает
// library.ts) и сравнить со снимком. Выключатель — тот же, что у серий (`notice_mutes`: id книг и аниме не пересекаются).

export async function checkNewChapters(): Promise<void> {
  const rows = db.prepare<[], { user_id: number; book_id: number; snap: string | null }>(
    `SELECT e.user_id, e.book_id, k.snap FROM read_entries e
     LEFT JOIN chapter_marks k ON k.user_id = e.user_id AND k.book_id = e.book_id
     WHERE e.deleted = 0 AND e.status IN ('watching', 'rewatching')
       AND NOT EXISTS (SELECT 1 FROM notice_mutes x WHERE x.user_id = e.user_id AND x.anilist_id = e.book_id)`).all();
  const mark = db.prepare("INSERT INTO chapter_marks (user_id, book_id, snap) VALUES (?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET snap = excluded.snap");
  for (const id of new Set(rows.map((r) => r.book_id))) {
    const book = await bookDetails(id).catch(() => null);
    if (!book) continue;
    await syncBook(book);
    const editions = summarize(chapterRows(id));
    if (!editions.length) continue;
    const snap = chapterSnap(editions);
    for (const r of rows.filter((x) => x.book_id === id)) {
      const prev = r.snap ? (JSON.parse(r.snap) as ChapterSnap) : null;
      const n = prev ? chapterNotice(prev, editions) : null;
      if (n) notify(r.user_id, {
        kind: "chapter", title: n.title, href: `/manga/${id}`,
        book: { id, title: book.title.ru || book.title.romaji || book.title.english || String(id), cover: book.coverImage.large },
      });
      mark.run(r.user_id, id, JSON.stringify(mergeSnap(prev, snap)));
    }
  }
}
