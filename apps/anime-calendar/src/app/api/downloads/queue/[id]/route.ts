import { removeFromQueue } from "@/server/downloads";
import { adminOnly, authed, intParam, json } from "@/server/route";

/** Отменить загрузку; ?blocklist=1 — и не брать эту раздачу снова. */
export const DELETE = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  await removeFromQueue(intParam(id, "id"), new URL(req.url).searchParams.get("blocklist") === "1");
  return json({ ok: true });
});
