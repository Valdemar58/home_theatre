import { decideSignup } from "@/server/accounts";
import { adminOnly, authed, intParam, json } from "@/server/route";

export const POST = authed<{ pk: string }>(async (req, user, { pk }) => {
  adminOnly(user);
  const { approve } = (await req.json().catch(() => ({}))) as { approve?: boolean };
  await decideSignup(user, intParam(pk, "pk"), Boolean(approve));
  return json({ ok: true });
});
