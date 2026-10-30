import type { Edition } from "@/lib/books";
import { bookDetails } from "@/server/books/anilist-books";
import { setLink, syncBook } from "@/server/books/library";
import { ApiError, authed, json } from "@/server/route";

/** Привязать книгу провайдера вручную или скрыть найденную: { provider, ref, action: "link" | "hide", title?, edition? } */
export const POST = authed<{ id: string }>(async (req, _user, { id }) => {
  const b = (await req.json().catch(() => ({}))) as { provider?: string; ref?: string; action?: "link" | "hide"; title?: string; edition?: Edition };
  if (!b.provider || !b.ref || !b.action) throw new ApiError(400, "Нужны provider, ref и action");
  setLink(Number(id), b.provider, b.ref, b.action, { title: b.title ?? "", edition: b.edition ?? "main" });
  void syncBook(await bookDetails(Number(id)));
  return json({ ok: true });
});
