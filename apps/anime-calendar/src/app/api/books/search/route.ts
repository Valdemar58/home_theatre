import { searchBooks } from "@/server/books/anilist-books";
import { authed, json } from "@/server/route";

/** Поиск книг: ?q=&kind=all|manga|novel */
export const GET = authed(async (req) => {
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind");
  return json({ books: await searchBooks(u.searchParams.get("q") ?? "", kind === "manga" || kind === "novel" ? kind : "all") });
});
