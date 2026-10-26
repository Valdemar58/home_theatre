import { refreshListMedia } from "@/server/lists";
import { ApiError, authed, json } from "@/server/route";
import { syncUser, unlinkShikimori } from "@/server/sync";

export const POST = authed(async (_req, user) => {
  if (!user.shiki_refresh) throw new ApiError(400, "Shikimori не привязан");
  const stats = await syncUser(user);
  await refreshListMedia().catch(() => undefined);
  return json(stats);
});

export const DELETE = authed(async (_req, user) => {
  unlinkShikimori(user.id);
  return json({ ok: true });
});
