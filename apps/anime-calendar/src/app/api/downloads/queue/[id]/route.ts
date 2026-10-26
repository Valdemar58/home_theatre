import { removeFromQueue } from "@/server/downloads";
import { authed, intParam, json } from "@/server/route";

/** Отменить загрузку; ?blocklist=1 — и не брать эту раздачу снова. */
export const DELETE = authed<{ id: string }>(async (req, _user, { id }) => {
  await removeFromQueue(intParam(id, "id"), new URL(req.url).searchParams.get("blocklist") === "1");
  return json({ ok: true });
});
