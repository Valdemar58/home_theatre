import {
  authBody,
  authLimit,
  redeem,
  tokenInfo,
} from "@/server/local-accounts";
import { accountEndpoint, signIn } from "@/server/account-http";
import { json } from "@/server/route";
export const POST = (req: Request) =>
  accountEndpoint(async () => {
    const b = await authBody(req);
    authLimit(req, "setup");
    return b.action === "info"
      ? json(tokenInfo(b.token))
      : signIn(await redeem(b));
  });
