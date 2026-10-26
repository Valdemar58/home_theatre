import { achievementsOf } from "@/server/achievements";
import { visibleTo } from "@/server/social";
import { ApiError, authed, intParam, json } from "@/server/route";

// Награды пользователя (?user=ID; по умолчанию — свои)
export const GET = authed(async (req, user) => {
  const raw = new URL(req.url).searchParams.get("user");
  const id = raw ? intParam(raw, "user") : user.id;
  if (!visibleTo(user.id, id)) throw new ApiError(403, "Профиль скрыт");
  return json(achievementsOf(id));
});
