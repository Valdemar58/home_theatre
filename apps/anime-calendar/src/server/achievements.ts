import "server-only";
import { achievementDef, ACHIEVEMENTS, describe, seasonEvent, seasonOf, TIER_NAMES, tierOf, type AchievementProgress, type Tier } from "@/lib/achievements";
import { watchMinutes } from "@/lib/social-rules";
import { db, now } from "./db";
import { listWithMedia } from "./lists";
import { notify } from "./notifications";
import { friendIds } from "./social";

// Значения для наград по данным пользователя (правила и пороги — lib/achievements.ts).

export function achievementValues(userId: number): Map<string, number> {
  const list = listWithMedia(userId);
  const done = list.filter((e) => e.status === "completed" && e.media);
  const v = new Map<string, number>();

  for (const a of ACHIEVEMENTS.filter((x) => x.group === "genre")) {
    const g = a.id.slice("genre:".length);
    v.set(a.id, done.filter((e) => e.media!.genres.includes(g)).length);
  }
  v.set("hours", Math.floor(list.reduce((s, e) => s + watchMinutes(e, e.media), 0) / 60));
  // Привычки
  v.set("rated", list.filter((e) => e.score > 0).length);
  const perGenre = new Map<string, number>();
  for (const e of done) for (const g of e.media!.genres) perGenre.set(g, (perGenre.get(g) ?? 0) + 1);
  v.set("diverse", [...perGenre.values()].filter((n) => n >= 5).length);
  const dropped = list.filter((e) => e.status === "dropped").length;
  v.set("finisher", done.length && dropped / (done.length + dropped) <= 0.15 ? done.length : 0);
  v.set("films", done.filter((e) => e.media!.format === "MOVIE").length);
  v.set("ongoing", list.filter((e) => e.status === "watching" && e.media?.status === "RELEASING").length);
  v.set("archaeologist", done.filter((e) => (e.media!.seasonYear ?? 9999) < 2000).length);
  v.set("marathon", done.filter((e) => (e.media!.episodes ?? 0) >= 50).length);
  v.set("own-view", list.filter((e) => e.score > 0 && e.media?.averageScore && Math.abs(e.score - e.media.averageScore / 10) >= 2).length);

  v.set("critic", db.prepare<[number], { n: number }>("SELECT COUNT(*) n FROM comments WHERE user_id = ? AND deleted = 0").get(userId)?.n ?? 0);

  // Вместе: тайтлы, где я был среди отмеченных или отмечал сам (не отменённое)
  const events = db.prepare<[], { actor_id: number; anilist_id: number; changes: string }>("SELECT actor_id, anilist_id, changes FROM watch_events").all();
  const together = new Set<number>();
  for (const ev of events) {
    const ch = (JSON.parse(ev.changes) as { userId: number; undone?: boolean }[]).filter((c) => !c.undone);
    if (ch.length && (ev.actor_id === userId || ch.some((c) => c.userId === userId)) && ch.some((c) => c.userId !== userId)) together.add(ev.anilist_id);
  }
  v.set("together", together.size);

  // Первооткрыватель и советчик — по спискам друзей
  const friends = friendIds(userId);
  v.set("friends", friends.length);
  let pioneer = 0;
  let adviser = 0;
  if (friends.length) {
    const theirs = db.prepare<number[], { user_id: number; anilist_id: number; status: string; score: number; updated_at: number }>(
      `SELECT user_id, anilist_id, status, score, updated_at FROM list_entries
       WHERE deleted = 0 AND status = 'completed' AND user_id IN (${friends.map(() => "?").join(",")})`).all(...friends);
    const byTitle = new Map<number, typeof theirs>();
    for (const r of theirs) byTitle.set(r.anilist_id, [...(byTitle.get(r.anilist_id) ?? []), r]);
    for (const e of done) {
      const later = (byTitle.get(e.anilistId) ?? []).filter((r) => r.updated_at > e.updatedAt);
      if (later.length) pioneer++;
      if (e.recommend) adviser += later.filter((r) => r.score >= 7).length;
    }
  }
  v.set("pioneer", pioneer);
  v.set("adviser", adviser);

  // Сезонные события: «Осень 2026» — досмотренное или начатое из тайтлов сезона
  for (const e of list) {
    const m = e.media;
    if (!m?.season || !m.seasonYear || !(e.status === "completed" || e.status === "watching" || e.status === "rewatching")) continue;
    const id = seasonEvent(m.season, m.seasonYear).id;
    v.set(id, (v.get(id) ?? 0) + 1);
  }
  const cur = seasonOf(now());
  const curId = seasonEvent(cur.season, cur.year).id;
  if (!v.has(curId)) v.set(curId, 0);
  return v;
}

type Earned = { id: string; tier: Tier; earned_at: number };

/**
 * Награды пользователя: значения, уровни и даты получения. Новые уровни записываются в user_achievements,
 * о них — уведомление (кроме самого первого подсчёта: старые заслуги не сыплются уведомлениями).
 */
export function achievementsOf(userId: number, opts: { notify?: boolean } = {}): AchievementProgress[] {
  const v = achievementValues(userId);
  const earned = new Map(db.prepare<[number], Earned>("SELECT id, tier, earned_at FROM user_achievements WHERE user_id = ?").all(userId).map((r) => [r.id, r]));
  // Первый подсчёт — запоминаем заслуги молча (метка _init), дальше — уведомляем о новых уровнях
  const first = !earned.has("_init");
  if (first) db.prepare("INSERT OR IGNORE INTO user_achievements (user_id, id, tier, earned_at) VALUES (?, '_init', 0, ?)").run(userId, now());
  const out: AchievementProgress[] = [];
  const ids = [...ACHIEVEMENTS.map((a) => a.id), ...[...v.keys()].filter((id) => id.startsWith("season:"))];
  for (const id of ids) {
    const def = achievementDef(id);
    if (!def) continue;
    const value = v.get(id) ?? 0;
    const tier = tierOf(value, def.thresholds);
    const was = earned.get(id);
    // Уровень не отнимается (бросил тайтл — награда остаётся)
    const best = Math.max(tier, was?.tier ?? 0) as Tier;
    let at = was?.earned_at ?? null;
    if (best > (was?.tier ?? 0)) {
      at = now();
      db.prepare("INSERT INTO user_achievements (user_id, id, tier, earned_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET tier = excluded.tier, earned_at = excluded.earned_at")
        .run(userId, id, best, at);
      if (!first && opts.notify !== false) {
        notify(userId, {
          kind: "achievement", title: `Награда «${def.name}» — ${TIER_NAMES[best].toLowerCase()}`, body: describe(def, def.thresholds[best - 1]),
          href: `/users/${userId}#awards`, achievement: { id, tier: best },
        });
      }
    }
    out.push({ id, value, tier: best, earnedAt: at });
  }
  return out;
}
