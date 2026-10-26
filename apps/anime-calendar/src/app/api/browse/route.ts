import { parseFilters } from "@/lib/filters";
import { searchCatalog } from "@/server/search";
import { authed, json } from "@/server/route";

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED"];
const SORTS = ["POPULARITY_DESC", "SCORE_DESC", "TRENDING_DESC", "START_DATE_DESC", "SEARCH_MATCH"];

export const GET = authed(async (req) => {
  const p = new URL(req.url).searchParams;
  const season = p.get("season") ?? "";
  const status = p.get("status") ?? "";
  const sort = p.get("sort") ?? "";
  return json(await searchCatalog({
    page: Math.max(1, Number(p.get("page")) || 1),
    season: SEASONS.includes(season) ? season : undefined,
    year: Number(p.get("year")) || undefined,
    status: STATUSES.includes(status) ? status : undefined,
    sort: SORTS.includes(sort) ? sort : undefined,
    filters: parseFilters(p),
  }));
});
