import { commentPage } from "@/lib/comment-page";
import { addComment, listComments } from "@/server/comments";
import { authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (req, user, { id }) => {
 const data=listComments(user,intParam(id,"id")),q=new URL(req.url).searchParams;
 return json(q.has("paged")?commentPage(data,q.has("episode")?intParam(q.get("episode")!,"episode"):null,q.has("before")?intParam(q.get("before")!,"before"):null):data);
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const anilistId = intParam(id, "id");
  const b = (await req.json()) as { body: string; parentId?: number | null; spoiler?: boolean; episode?: number | null };
  addComment(user, anilistId, { body: b.body, parentId: b.parentId ? Number(b.parentId) : null, spoiler: Boolean(b.spoiler), episode: b.episode ? Number(b.episode) : null });
  return json(listComments(user, anilistId));
});
