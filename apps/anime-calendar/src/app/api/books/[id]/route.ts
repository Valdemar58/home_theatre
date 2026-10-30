import { bookPage } from "@/server/books/library";
import { ApiError, authed, json } from "@/server/route";

/** Страница книги: AniList + провайдеры (сохранённое сразу, обновление — в фоне, пока updating). */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, "Неверный id");
  return json(await bookPage(n));
});
