import { getCached } from "@/server/cache";
import type { BookLite } from "@/lib/books";
import { bookDetails } from "@/server/books/anilist-books";
import { readList } from "@/server/books/reading";
import { authed, json } from "@/server/route";

/** Список чтения с карточками книг (сохранённые; нет — с AniList). */
export const GET = authed(async (_req, user) => {
  const list = readList(user.id);
  const items = await Promise.all(list.map(async (e) => {
    const lite = getCached<BookLite>(`book:lite:${e.bookId}`, true) ?? await bookDetails(e.bookId).catch(() => null);
    return lite ? { ...e, book: lite } : null;
  }));
  return json({ items: items.filter(Boolean) });
});
