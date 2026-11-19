import { bookDetails } from "@/server/books/anilist-books";
import { setEntry } from "@/server/books/reading";
import { ApiError, authed, json } from "@/server/route";

const STATUSES = new Set(["watching", "planned", "completed", "on_hold", "dropped", "rewatching"]);

/** Список чтения: { status (null — убрать), score?, chapters? } */
export const PUT = authed<{ id: string }>(async (req, user, { id }) => {
  const b = (await req.json().catch(() => ({}))) as { status?: string | null; score?: number; chapters?: number };
  if (b.status !== undefined && b.status !== null && !STATUSES.has(b.status)) throw new ApiError(400, "Неверный статус");
  const book = await bookDetails(Number(id));
  setEntry(user.id, book.id, book.idMal, { status: b.status, score: b.score, chapters: b.chapters });
  return json({ ok: true });
});
