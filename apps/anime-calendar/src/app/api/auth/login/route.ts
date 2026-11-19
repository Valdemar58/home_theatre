import {
  authBody,
  authLimit,
  authenticate,
  legacyAuthEnabled,
  sameOrigin,
} from "@/server/local-accounts";
import { accountEndpoint, signIn } from "@/server/account-http";
import { legacyLogin } from "./legacy";
export const POST = (req: Request) =>
  accountEndpoint(async () => {
    sameOrigin(req);
    authLimit(req, "login");
    if (
      legacyAuthEnabled() &&
      new URL(req.url).searchParams.get("legacy") === "1"
    )
      return legacyLogin(req);
    const b = await authBody(req);
    return signIn(await authenticate(b.login ?? b.username, b.password));
  });
