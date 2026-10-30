import "server-only";
import { airedNow, episodeNotice, readyNotice } from "@/lib/episode-notice";
import { lastPlayable } from "@/lib/playback";
import type { MediaLite } from "@/lib/types";
import { mediaByIds } from "./anilist";
import { episodeStatus } from "./availability";
import { db, now } from "./db";
import { env } from "./env";
import { saveMedia, withShikimori } from "./lists";
import { notify } from "./notifications";

// Новые серии: «Смотрю» — о каждой вышедшей серии, «Жду выхода» — когда вышла последняя (тайтл целиком).
// «Смотрю» — ещё и когда серия появилась в библиотеке или «Стриме» («можно смотреть»).
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
  if (env.jellyfinApiKey) await checkReady();
}

/** «Можно смотреть»: дальняя серия в библиотеке или «Стриме» выросла (по тайтлу — один запрос к Jellyfin). */
async function checkReady() {
  const rows = db.prepare<[], { user_id: number; anilist_id: number; episodes: number; ready: number | null }>(
    `SELECT e.user_id, e.anilist_id, e.episodes, k.ready FROM list_entries e
     JOIN episode_marks k ON k.user_id = e.user_id AND k.anilist_id = e.anilist_id
     WHERE e.deleted = 0 AND e.status = 'watching'
       AND NOT EXISTS (SELECT 1 FROM notice_mutes x WHERE x.user_id = e.user_id AND x.anilist_id = e.anilist_id)`).all();
  const last = new Map<number, number>();
  for (const id of new Set(rows.map((r) => r.anilist_id))) {
    const st = await episodeStatus(id).catch(() => null);
    if (st) last.set(id, lastPlayable(st.episodes));
  }
  const mark = db.prepare("UPDATE episode_marks SET ready = ? WHERE user_id = ? AND anilist_id = ?");
  for (const r of rows) {
    const ready = last.get(r.anilist_id);
    if (ready === undefined) continue;
    // Первый раз — только запомнить
    const n = r.ready === null ? null : readyNotice(r.ready, ready, r.episodes);
    if (n) notify(r.user_id, { kind: "episode", anilistId: r.anilist_id, href: `/anime/${r.anilist_id}`, title: n.title });
    // Только рост: серия «Стрима» ушла после загрузки — не сообщать о ней снова
    if (r.ready === null || ready > r.ready) mark.run(ready, r.user_id, r.anilist_id);
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
    db.prepare("DELETE FROM chapter_marks WHERE user_id = ? AND book_id = ?").run(userId, anilistId);
  }
}
