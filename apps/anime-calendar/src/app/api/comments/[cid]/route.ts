import { deleteComment, editComment } from "@/server/comments";
import { authed, intParam, json } from "@/server/route";

export const PATCH = authed<{ cid: string }>(async (req, user, { cid }) => {
  const b = (await req.json()) as { body?: string; spoiler?: boolean };
  editComment(user, intParam(cid, "cid"), b);
  return json({ ok: true });
});

export const DELETE = authed<{ cid: string }>(async (_req, user, { cid }) => {
  deleteComment(user, intParam(cid, "cid"));
  return json({ ok: true });
});
