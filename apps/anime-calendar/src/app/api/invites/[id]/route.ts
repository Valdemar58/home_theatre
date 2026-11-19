import { privateJson as json } from "@/server/account-http";
import { revokeInvitation, sameOrigin } from "@/server/local-accounts";
import { authed } from "@/server/route";
export const DELETE = authed<{ id: string }>(async (req, user, { id }) => {
  sameOrigin(req);
  revokeInvitation(user, id);
  return json({ ok: true });
});
