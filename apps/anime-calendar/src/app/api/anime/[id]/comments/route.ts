import { addComment, listComments } from "@/server/comments";
import { authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(listComments(user, intParam(id, "id"))));

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const anilistId = intParam(id, "id");
  const b = (await req.json()) as { body: string; parentId?: number | null; spoiler?: boolean; episode?: number | null };
  addComment(user, anilistId, { body: b.body, parentId: b.parentId ? Number(b.parentId) : null, spoiler: Boolean(b.spoiler), episode: b.episode ? Number(b.episode) : null });
  return json(listComments(user, anilistId));
});
