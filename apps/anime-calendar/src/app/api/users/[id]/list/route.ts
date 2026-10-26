import { publicList, visibleTo } from "@/server/social";
import { ApiError, authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  const ownerId = intParam(id, "id");
  if (!visibleTo(user.id, ownerId)) throw new ApiError(403, "Профиль скрыт");
  return json(publicList(ownerId, user.id));
});
