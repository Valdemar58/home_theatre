import { bookDetails } from "@/server/books/anilist-books";
import { syncBook } from "@/server/books/library";
import { authed, json } from "@/server/route";

/** Обновить книгу у провайдеров сейчас (заново искать и перечитать оглавления). */
export const POST = authed<{ id: string }>(async (req, _user, { id }) => {
  const b = await req.json().catch(() => ({})) as { provider?: string; sourceId?: string };
  void syncBook(await bookDetails(Number(id)), true, b.provider ? { provider: b.provider, sourceId: b.sourceId } : undefined);
  return json({ ok: true });
});
