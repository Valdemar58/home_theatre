import type { Profile } from "@/lib/types";
import { getUserById } from "@/server/session";
import { profileStats, publicList, stateBetween, tasteWith, visibleTo } from "@/server/social";
import { ApiError, authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  const ownerId = intParam(id, "id");
  const owner = getUserById(ownerId);
  if (!owner) throw new ApiError(404, "Пользователь не найден");
  const visible = Boolean(visibleTo(user.id, ownerId));
  const self = ownerId === user.id;
  const profile: Profile = {
    user: { id: owner.id, name: owner.name },
    self,
    state: self ? "none" : stateBetween(user.id, ownerId),
    visible,
    visibility: self ? owner.visibility : undefined,
    stats: visible ? profileStats(publicList(ownerId, user.id)) : null,
    taste: visible && !self ? await tasteWith(user.id, ownerId) : null,
  };
  return json(profile);
});
