import { revokeInvite } from "@/server/accounts";
import { authed, json } from "@/server/route";

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  await revokeInvite(user, id);
  return json({ ok: true });
});
