import { addItem, removeItem } from "@/server/together";
import { authed, intParam, json } from "@/server/route";

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const { anilistId } = (await req.json()) as { anilistId: number };
  await addItem(user, intParam(id, "id"), intParam(String(anilistId), "anilistId"));
  return json({ ok: true });
});

export const DELETE = authed<{ id: string }>(async (req, user, { id }) => {
  removeItem(user.id, intParam(id, "id"), intParam(new URL(req.url).searchParams.get("anilistId"), "anilistId"));
  return json({ ok: true });
});
