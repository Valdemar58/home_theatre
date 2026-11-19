import { createInvite, myInvites } from "@/server/accounts";
import { ssoConfigured } from "@/server/env";
import { authed, json } from "@/server/route";

export const GET = authed(async (_req, user) => json({ sso: ssoConfigured(), invites: myInvites(user.id) }));

export const POST = authed(async (req, user) => {
  const body = (await req.json().catch(() => ({}))) as { note?: string; groupId?: number };
  return json(await createInvite(user, { note: body.note, groupId: Number(body.groupId) || undefined }));
});
