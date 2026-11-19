import { authBody, authLimit, register } from "@/server/local-accounts";
import { accountEndpoint, signIn } from "@/server/account-http";
export const POST = (req: Request) =>
  accountEndpoint(async () => {
    const b = await authBody(req);
    authLimit(req, "register");
    return signIn(await register(b));
  });
