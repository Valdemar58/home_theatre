import { bookCharacters } from "@/server/books/anilist-books";
import { authed, intParam, json } from "@/server/route";

/** Персонажи книги (AniList + русские имена Shikimori). */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => json({ characters: await bookCharacters(intParam(id, "id")) }));
