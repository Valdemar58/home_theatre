import { nameRefs } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** Имена персонажей для подсветки в тексте о сериях до upTo (без него — весь сезон). */
export const GET = authed<{ id: string }>(async (req, user, { id }) => {
  const upTo = new URL(req.url).searchParams.get("upTo");
  return json(await nameRefs(user.id, intParam(id, "id"), upTo ? intParam(upTo, "upTo") : 1e6));
});
