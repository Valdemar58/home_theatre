import { bookDetails } from "@/server/books/anilist-books";
import { syncBook } from "@/server/books/library";
import { authed, json } from "@/server/route";

/** Обновить книгу у провайдеров сейчас (заново искать и перечитать оглавления). */
export const POST = authed<{ id: string }>(async (_req, _user, { id }) => {
  void syncBook(await bookDetails(Number(id)), true);
  return json({ ok: true });
});
