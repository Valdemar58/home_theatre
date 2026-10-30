import { providerSearch } from "@/server/books/library";
import { ApiError, authed, json } from "@/server/route";

/** Поиск книги у провайдера для ручной привязки: ?provider=&q= */
export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  const u = new URL(req.url);
  const provider = u.searchParams.get("provider");
  if (!provider) throw new ApiError(400, "Нужен provider");
  return json({ hits: await providerSearch(Number(id), provider, u.searchParams.get("q") ?? undefined) });
});
