import { booksForAnime } from "@/server/books/anilist-books";
import { authed, json } from "@/server/route";

/** Книги, связанные с аниме (первоисточник, спин-оффы) — для блока на странице тайтла. */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => json({ books: await booksForAnime(Number(id)) }));
