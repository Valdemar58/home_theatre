import { parseFilters } from "@/lib/filters";
import { authed, json } from "@/server/route";
import { suggest } from "@/server/search";

// Подсказки для строки поиска в шапке
export const GET = authed(async (req) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return json({ media: await suggest(q, parseFilters(new URLSearchParams())) });
});
