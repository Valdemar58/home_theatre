import { privateJson as json } from "@/server/account-http";
import { copyInvitation, sameOrigin } from "@/server/local-accounts";
import { authed } from "@/server/route";

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  sameOrigin(req);
  return json(copyInvitation(user, id));
});
