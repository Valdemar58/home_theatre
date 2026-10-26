import "server-only";
import { airedNow, episodeNotice } from "@/lib/episode-notice";
import type { MediaLite } from "@/lib/types";
import { mediaByIds } from "./anilist";
import { db, now } from "./db";
import { saveMedia, withShikimori } from "./lists";
import { notify } from "./notifications";

// Новые серии: «Смотрю» — о каждой вышедшей серии, «Жду выхода» — когда вышла последняя (тайтл целиком).
// Первый проход по тайтлу только запоминает, сколько уже вышло (без лавины уведомлений о старом).
// Снимок тайтла обновляется, как только время следующей серии прошло, — не ждём планового обновления.

type Row = { user_id: number; anilist_id: number; status: string; waiting: number; episodes: number; json: string; updated_at: number; notified: number | null };

export async function checkNewEpisodes(): Promise<void> {
  const watched = () => db.prepare<[], Row>(
    `SELECT e.user_id, e.anilist_id, e.status, e.waiting, e.episodes, m.json, m.updated_at, k.notified
     FROM list_entries e JOIN media m ON m.anilist_id = e.anilist_id
     LEFT JOIN episode_marks k ON k.user_id = e.user_id AND k.anilist_id = e.anilist_id
     WHERE e.deleted = 0 AND (e.status = 'watching' OR (e.status = 'planned' AND e.waiting = 1))
       AND NOT EXISTS (SELECT 1 FROM notice_mutes x WHERE x.user_id = e.user_id AND x.anilist_id = e.anilist_id)`).all();

  // Время серии прошло, а снимок старше — обновить из AniList
  const t = now();
  const stale = [...new Set(watched().filter((r) => {
    const next = (JSON.parse(r.json) as MediaLite).nextAiringEpisode;
    return next && next.airingAt <= t && r.updated_at < next.airingAt + 600;
  }).map((r) => r.anilist_id))];
  if (stale.length) saveMedia(await withShikimori(await mediaByIds(stale)));

  const mark = db.prepare("INSERT INTO episode_marks (user_id, anilist_id, notified) VALUES (?, ?, ?) ON CONFLICT(user_id, anilist_id) DO UPDATE SET notified = excluded.notified");
  for (const r of watched()) {
    const m = JSON.parse(r.json) as MediaLite;
    const aired = airedNow(m, now());
    if (aired === null) continue;
    if (r.notified === null) { mark.run(r.user_id, r.anilist_id, aired); continue; }
    const n = episodeNotice({ waiting: Boolean(r.waiting), episodes: r.episodes }, m, r.notified, aired);
    if (n) notify(r.user_id, { anilistId: r.anilist_id, href: `/anime/${r.anilist_id}`, ...n });
    if (aired !== r.notified) mark.run(r.user_id, r.anilist_id, aired);
  }
}

export const isMuted = (userId: number, anilistId: number) =>
  Boolean(db.prepare<[number, number], { x: number }>("SELECT 1 x FROM notice_mutes WHERE user_id = ? AND anilist_id = ?").get(userId, anilistId));

export function setMuted(userId: number, anilistId: number, muted: boolean) {
  if (muted) db.prepare("INSERT OR IGNORE INTO notice_mutes (user_id, anilist_id) VALUES (?, ?)").run(userId, anilistId);
  else {
    db.prepare("DELETE FROM notice_mutes WHERE user_id = ? AND anilist_id = ?").run(userId, anilistId);
    // Включили обратно — не присылать всё, что вышло за время тишины
    db.prepare("DELETE FROM episode_marks WHERE user_id = ? AND anilist_id = ?").run(userId, anilistId);
  }
}
