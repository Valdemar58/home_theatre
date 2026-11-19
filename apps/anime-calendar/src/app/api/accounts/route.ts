import { privateJson as json } from "@/server/account-http";
import { localAccountsView } from "@/server/local-accounts";
import { adminOnly, authed } from "@/server/route";
export const GET = authed(async (_req, user) => {
  adminOnly(user);
  return json(localAccountsView());
});
