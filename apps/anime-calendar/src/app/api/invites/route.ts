import { privateJson as json } from "@/server/account-http";
import { issueToken, localInvites, authBody } from "@/server/local-accounts";
import { authed, adminOnly } from "@/server/route";
export const GET = authed(async (_req, user) =>
  json({
    enabled: !!user.is_admin,
    invites: user.is_admin ? localInvites(user.id) : [],
  }),
);
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const b = await authBody(req);
  const issued = issueToken(
    user,
    "invite",
    null,
    b.hours === undefined ? 168 : Number(b.hours),
    {
      note: String(b.note ?? ""),
      groupId: b.groupId ? Number(b.groupId) : undefined,
    },
  );
  const view = localInvites(user.id).find((i) => i.id === issued.id)!;
  return json({ ...view, link: issued.link });
});
