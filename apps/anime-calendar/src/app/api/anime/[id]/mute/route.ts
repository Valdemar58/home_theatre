import { isMuted, setMuted } from "@/server/episode-notices";
import { authed, intParam, json } from "@/server/route";

// Уведомления о сериях тайтла: выключены ли
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json({ muted: isMuted(user.id, intParam(id, "id")) }));

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const { muted } = (await req.json()) as { muted: boolean };
  setMuted(user.id, intParam(id, "id"), Boolean(muted));
  return json({ muted: Boolean(muted) });
});
