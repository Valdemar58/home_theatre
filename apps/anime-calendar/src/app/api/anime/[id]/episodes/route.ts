import { episodeStatus } from "@/server/availability";
import { db } from "@/server/db";
import { authed, intParam, json } from "@/server/route";

// Готовность серий тайтла к просмотру: библиотека, «Стрим» (буфер, кэш TorrServer), загрузка, вышла/не вышла;
// где я остановился в каждой серии (плеер календаря)
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  const anilistId = intParam(id, "id");
  const positions = db.prepare<[number, number], { ep: number; pos: number; dur: number | null }>(
    "SELECT ep, pos, dur FROM playback_pos WHERE user_id = ? AND anilist_id = ?").all(user.id, anilistId);
  return json({ ...(await episodeStatus(anilistId)), positions });
});
