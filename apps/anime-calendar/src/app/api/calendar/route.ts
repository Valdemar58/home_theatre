import { getCalendar } from "@/server/anilist";
import { withShikimori } from "@/server/lists";
import { ApiError, authed, intParam, json } from "@/server/route";

export const GET = authed(async (req) => {
  const url = new URL(req.url);
  const from = intParam(url.searchParams.get("from"), "from");
  const to = intParam(url.searchParams.get("to"), "to");
  if (to <= from || to - from > 62 * 86400) throw new ApiError(400, "Диапазон должен быть не больше 62 дней");
  const cal = await getCalendar(from, to);
  await withShikimori(Object.values(cal.media));
  return json(cal);
});
