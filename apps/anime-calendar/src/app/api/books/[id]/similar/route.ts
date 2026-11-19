import { similarBooks } from "@/server/books/anilist-books";
import { authed, intParam, json } from "@/server/route";

/** Похожие книги — рекомендации AniList. */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => json({ books: await similarBooks(intParam(id, "id")) }));
