import { privateJson as json } from "@/server/account-http";
import { manage, authBody } from "@/server/local-accounts";
import { adminOnly, authed, intParam } from "@/server/route";
export const POST = authed<{ uid: string }>(async (req, user, { uid }) => {
  adminOnly(user);
  const b = await authBody(req);
  return json(manage(user, intParam(uid, "uid"), String(b.action)));
});
