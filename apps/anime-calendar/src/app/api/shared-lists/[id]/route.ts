import { deleteList, inviteToList, listDetail, memberAction, renameList } from "@/server/together";
import { ApiError, authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(listDetail(user.id, intParam(id, "id"))));

export const PATCH = authed<{ id: string }>(async (req, user, { id }) => {
  const { name } = (await req.json()) as { name: string };
  renameList(user.id, intParam(id, "id"), String(name ?? ""));
  return json(listDetail(user.id, intParam(id, "id")));
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  deleteList(user.id, intParam(id, "id"));
  return json({ ok: true });
});

/** Участники: invite (друга), accept / decline (приглашение), leave, remove (создатель убирает участника). */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const listId = intParam(id, "id");
  const { action, userId } = (await req.json()) as { action: string; userId?: number };
  if (action === "invite") inviteToList(user, listId, intParam(String(userId), "userId"));
  else if (action === "accept" || action === "decline" || action === "leave" || action === "remove") memberAction(user, listId, action, userId);
  else throw new ApiError(400, "Неизвестное действие");
  if (action === "decline" || action === "leave") return json({ ok: true });
  return json(listDetail(user.id, listId));
});
