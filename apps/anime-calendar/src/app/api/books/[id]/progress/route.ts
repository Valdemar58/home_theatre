import type { Edition } from "@/lib/books";
import { queueAhead } from "@/server/books/book-translate";
import { bookPref, readEntry, readPositions, saveProgress, setBookPref, type BookPref } from "@/server/books/reading";
import { ApiError, authed, json } from "@/server/route";

/** Где остановился, выбранный перевод и запись списка чтения. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) =>
  json({ positions: readPositions(user.id, Number(id)), pref: bookPref(user.id, Number(id)), entry: readEntry(user.id, Number(id)) }));

/** { chapter, edition, provider, cref, pos, done, ordinal } — позиция; { pref } — выбранный перевод. */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const b = (await req.json().catch(() => ({}))) as {
    chapter?: string; edition?: Edition; provider?: string; cref?: string; pos?: number; done?: boolean; ordinal?: number | null; pref?: BookPref;
  };
  if (b.pref) setBookPref(user.id, Number(id), b.pref);
  if (b.chapter && b.edition && b.provider && b.cref) {
    saveProgress(user.id, Number(id), { chapter: b.chapter, edition: b.edition, provider: b.provider, cref: b.cref, pos: Number(b.pos) || 0, done: Boolean(b.done), ordinal: b.ordinal ?? null });
    // Дочитал — перевод ИИ вперёд (если включён у книги)
    const ahead = bookPref(user.id, Number(id)).aiAhead ?? 0;
    if (b.done && ahead > 0) void queueAhead(user.id, Number(id), b.edition, b.chapter, ahead).catch(() => undefined);
  } else if (!b.pref) throw new ApiError(400, "Нужна позиция или pref");
  return json({ ok: true });
});
