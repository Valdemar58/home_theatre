import { undoEdit } from "@/server/plot-edits";
import { adminOnly, authed, intParam, json } from "@/server/route";

/** Отменить правку (строка остаётся в журнале с отметкой отмены). */
export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  await undoEdit(user, intParam(id, "id"));
  return json({ ok: true });
});
