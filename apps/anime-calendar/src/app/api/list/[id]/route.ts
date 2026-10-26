import { after } from "next/server";
import { deleteEntry, ensureMedia, getRow, logWatch, upsertEntry, validatePatch, type EntryPatch } from "@/server/lists";
import { ApiError, authed, intParam, json } from "@/server/route";
import { pushEntry } from "@/server/sync";
import { onProgress } from "@/server/together";
import { achievementsOf } from "@/server/achievements";

export const PUT = authed<{ id: string }>(async (req, user, { id }) => {
  const anilistId = intParam(id, "id");
  let patch: EntryPatch;
  try {
    patch = validatePatch(await req.json());
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : "Некорректные данные");
  }
  const media = await ensureMedia(anilistId);
  const before = getRow(user.id, anilistId);
  upsertEntry(user.id, media, patch);
  const now = getRow(user.id, anilistId);
  logWatch(user.id, media, before && !before.deleted ? before.episodes : 0, now?.episodes ?? 0);
  // В Shikimori отправляем после ответа, чтобы интерфейс не ждал
  after(() => pushEntry(user.id, anilistId));
  // Новые уровни наград — уведомлением
  after(() => { try { achievementsOf(user.id); } catch (e) { console.warn(`[achievements] ${e}`); } });
  // Смотрим вместе — серии засчитываются и друзьям; тайтл в общем списке — подсказка «отметить и для …?»
  if (patch.episodes !== undefined || patch.status === "completed")
    await onProgress(user, anilistId, before && !before.deleted ? before.episodes : 0, now?.episodes ?? 0, "manual");
  return json({ ok: true });
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  const anilistId = intParam(id, "id");
  deleteEntry(user.id, anilistId);
  after(() => pushEntry(user.id, anilistId));
  return json({ ok: true });
});
