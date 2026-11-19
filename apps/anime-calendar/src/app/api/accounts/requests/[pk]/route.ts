import { privateJson as json } from "@/server/account-http";
import { decide, authBody } from "@/server/local-accounts";
import { adminOnly, authed, intParam, ApiError } from "@/server/route";
export const POST = authed<{ pk: string }>(async (req, user, { pk }) => {
  adminOnly(user);
  const b = await authBody(req);
  if (typeof b.approve !== "boolean")
    throw new ApiError(400, "Выберите решение");
  decide(user, intParam(pk, "pk"), b.approve);
  return json({ ok: true });
});
