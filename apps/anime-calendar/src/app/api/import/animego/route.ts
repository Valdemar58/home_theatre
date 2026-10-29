import { review, saveEdit, startApply } from "@/server/animego-import";
import { adminOnly, ApiError, authed, json } from "@/server/route";

/** План импорта AnimeGo с правками и ходом записи. */
export const GET = authed(async (_req, user) => {
  adminOnly(user);
  return json(await review(user));
});

/** { agId, anilistId?|status?|score?|skip?|reset? } — правка записи; { apply: true } — записать в список. */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.apply) return json(startApply(user));
  if (!body.agId) throw new ApiError(400, "Нужен agId");
  const { agId, ...patch } = body;
  try {
    saveEdit(Number(agId), patch);
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  return json({ ok: true });
});
