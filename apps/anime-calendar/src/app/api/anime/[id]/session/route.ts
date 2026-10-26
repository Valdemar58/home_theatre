import { endSession, startSession, updateSession } from "@/server/together";
import { authed, intParam, json } from "@/server/route";

// «Смотрим вместе с…»: начать / сменить участников / закончить (участник — выйти)
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const { members } = (await req.json()) as { members: number[] };
  startSession(user, intParam(id, "id"), (members ?? []).map(Number));
  return json({ ok: true });
});

export const PATCH = authed<{ id: string }>(async (req, user, { id }) => {
  const { members } = (await req.json()) as { members: number[] };
  updateSession(user.id, intParam(id, "id"), (members ?? []).map(Number));
  return json({ ok: true });
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  endSession(user.id, intParam(id, "id"));
  return json({ ok: true });
});
