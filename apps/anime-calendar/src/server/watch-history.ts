import "server-only";
import { randomUUID } from "node:crypto";
import { db, now } from "./db";
import { getMedia, getRow, upsertEntry } from "./lists";
import { coverageState } from "@/lib/watch-coverage";
import { airedCount } from "@/lib/entry-rules";
import { ApiError } from "./route";

type Cycle = { id: string; user_id: number; anilist_id: number; baseline: number; prior_completed: number;
  initial_status: import("@/lib/types").ListStatus | null;
  started_at: number | null; last_activity: number; ended_at: number | null; outcome: string | null; idle_since: number | null };
export const latestCycle = (user: number, title: number) => db.prepare<[number, number], Cycle>(
  "SELECT * FROM watch_cycles WHERE user_id = ? AND anilist_id = ? ORDER BY created_at DESC LIMIT 1").get(user, title);
const cycleById = (id: string) => db.prepare<[string], Cycle>("SELECT * FROM watch_cycles WHERE id = ?").get(id)!;

export function ensureCycle(user: number, title: number): Cycle {
  const old = latestCycle(user, title);
  if (old && !old.ended_at) return old;
  if (old?.outcome === "inactive" && !old.prior_completed) {
    db.prepare("UPDATE watch_cycles SET ended_at=NULL,outcome=NULL,idle_since=NULL WHERE id=?").run(old.id);
    return cycleById(old.id);
  }
  const entry = getRow(user, title);
  const prior = entry?.status === "completed" || entry?.status === "rewatching" || Boolean(old?.prior_completed);
  const id = randomUUID(), t = now();
  // Only the initial legacy counter is a baseline. Never invent individual old events.
  const baseline = !old && entry && !entry.deleted && entry.status !== "completed" ? entry.episodes : 0;
  const created = db.prepare<[number, number], { t: number | null }>("SELECT MAX(created_at) t FROM watch_cycles WHERE user_id=? AND anilist_id=?").get(user,title)?.t ?? 0;
  db.prepare(`INSERT INTO watch_cycles (id,user_id,anilist_id,baseline,prior_completed,last_activity,created_at,initial_status)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, user, title, baseline, prior ? 1 : 0, t, Math.max(Date.now(),created+1),entry?.status??"planned");
  return cycleById(id);
}

export function cycleEpisodes(c: Cycle): number[] {
  return db.prepare<[string], { ep: number }>("SELECT DISTINCT ep FROM watch_episode_events WHERE cycle_id = ? AND revoked_at IS NULL ORDER BY ep").all(c.id).map(x => x.ep);
}

export function projectCycle(id: string) {
  const c = cycleById(id), media = getMedia(c.anilist_id);
  if (!media) return;
  const episodes = new Set(cycleEpisodes(c));
  db.prepare("UPDATE watch_log SET episodes=0,minutes=0 WHERE cycle_id=?").run(id);
  for(const ep of episodes) db.prepare(`INSERT INTO watch_log (user_id,anilist_id,episodes,minutes,at,cycle_id,ep)
    VALUES (?,?,1,?,?,?,?) ON CONFLICT (cycle_id,ep) WHERE cycle_id IS NOT NULL
    DO UPDATE SET episodes=1,minutes=excluded.minutes`).run(c.user_id,c.anilist_id,Math.round(media.duration??24),now(),id,ep);
  if (latestCycle(c.user_id,c.anilist_id)?.id!==id) return;
  if(!episodes.size) {
    const measured=db.prepare<[string],{intervals:string;duration:number}>("SELECT intervals,duration FROM playback_coverage WHERE cycle_id=?").all(id)
      .some(r=>coverageState(JSON.parse(r.intervals),r.duration).started);
    if(!measured && c.started_at) {
      upsertEntry(c.user_id,media,{status:c.initial_status??(c.prior_completed?"completed":"planned"),episodes:c.baseline});
      db.prepare("UPDATE watch_cycles SET started_at=NULL,ended_at=?,outcome='corrected' WHERE id=?").run(now(),id);
      return;
    }
  }
  let prefix = c.baseline;
  while (episodes.has(prefix + 1)) prefix++;
  const complete = media.status === "FINISHED" && Boolean(media.episodes && prefix >= media.episodes);
  if (!c.started_at && !episodes.size) return;
  const status = complete ? "completed" : c.prior_completed ? "rewatching" : "watching";
  const row = getRow(c.user_id,c.anilist_id);
  if (row?.status !== status || row.episodes !== prefix) upsertEntry(c.user_id, media, { status, episodes: prefix });
  db.prepare("UPDATE watch_cycles SET ended_at = ?, outcome = ? WHERE id = ?")
    .run(complete ? c.ended_at ?? now() : null, complete ? "completed" : null, id);
}

export function addEpisode(cycle: Cycle, ep: number, source: string, actor: number, key: string, meeting: number | null = null) {
  const inserted = db.prepare(`INSERT INTO watch_episode_events (id,cycle_id,ep,source,actor_id,meeting_id,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`).run(key, cycle.id, ep, source, actor, meeting, now()).changes;
  if (inserted) db.prepare("UPDATE watch_cycles SET started_at = COALESCE(started_at, ?), last_activity = ?, idle_since = NULL WHERE id = ?")
    .run(now(), now(), cycle.id);
  return Boolean(inserted);
}

export function applyCoverage(user: number, title: number, ep: number, attempt: string, duration: number, changed = true) {
  return db.transaction(() => {
    db.prepare("UPDATE users SET name = name WHERE id = ?").run(user);
    const raw = db.prepare<[string], { cycle_id: string | null; intervals: string }>("SELECT cycle_id, intervals FROM playback_coverage WHERE sid = ?").get(attempt);
    if (!raw) return false;
    const c = raw.cycle_id ? cycleById(raw.cycle_id) : ensureCycle(user, title);
    if (!raw.cycle_id) db.prepare("UPDATE playback_coverage SET cycle_id = ? WHERE sid = ?").run(c.id, attempt);
    const evidence = coverageState(JSON.parse(raw.intervals), duration);
    // A late heartbeat from a finished attempt must not create or alter a new cycle.
    if (c.ended_at) return cycleEpisodes(c).includes(ep);
    if (evidence.started) {
      if (changed) db.prepare("UPDATE watch_cycles SET started_at = COALESCE(started_at, ?), last_activity = ? WHERE id = ?").run(now(), now(), c.id);
      if (evidence.watched) addEpisode(c, ep, "player", user, `player:${c.id}:${ep}`);
      projectCycle(c.id);
    }
    return evidence.watched || cycleEpisodes(c).includes(ep);
  })();
}

export function markEpisode(user: number, title: number, ep: number, source = "manual", key?: string) {
  const media = getMedia(title);
  if (!media || !Number.isInteger(ep) || ep < 1 || (media.episodes && ep > media.episodes)) throw new ApiError(400, "Некорректная серия");
  return db.transaction(() => {
    db.prepare("UPDATE users SET name = name WHERE id = ?").run(user);
    if (key && db.prepare("SELECT id FROM watch_episode_events WHERE id = ?").get(key)) return false;
    // Repeated manual click is idempotent, including the final episode of a completed cycle.
    const last = latestCycle(user, title);
    if (!key && last && cycleEpisodes(last).includes(ep)) return false;
    const c = ensureCycle(user, title);
    const inserted = addEpisode(c, ep, source, user, key ?? `manual:${c.id}:${ep}`);
    projectCycle(c.id);
    return inserted;
  })();
}

export function personalHistory(user: number, title?: number) {
  const cycles = title ? db.prepare<[number, number], Cycle>("SELECT * FROM watch_cycles WHERE user_id = ? AND anilist_id = ? ORDER BY created_at DESC").all(user, title)
    : db.prepare<[number], Cycle>("SELECT * FROM watch_cycles WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(user);
  return cycles.map(c => ({ ...c, title: getMedia(c.anilist_id)?.title.ru ?? getMedia(c.anilist_id)?.title.romaji ?? `Тайтл #${c.anilist_id}`, episodes: cycleEpisodes(c), events: db.prepare<[string], { id: string; ep: number; source: string; actor_id: number; created_at: number; revoked_at: number | null; meeting_id: number | null }>(
    "SELECT id,ep,source,actor_id,created_at,revoked_at,meeting_id FROM watch_episode_events WHERE cycle_id = ? ORDER BY created_at DESC").all(c.id) }));
}

export function revokeOwnEvent(user: number, eventId: string) {
  db.transaction(() => {
    db.prepare("UPDATE users SET name = name WHERE id = ?").run(user);
    const e = db.prepare<[string, number], { cycle_id: string; source: string }>(`SELECT e.cycle_id,e.source FROM watch_episode_events e
      JOIN watch_cycles c ON c.id=e.cycle_id WHERE e.id = ? AND c.user_id = ?`).get(eventId, user);
    if (!e || e.source !== "organizer") throw new ApiError(403, "Можно исправить только сделанную за вас отметку организатора");
    db.prepare("UPDATE watch_episode_events SET revoked_at = COALESCE(revoked_at, ?), revoked_by = ? WHERE id = ?").run(now(), user, eventId);
    projectCycle(e.cycle_id);
  })();
}

export const inactivityDays = (user: number) => db.prepare<[number], { inactivity_days: number }>("SELECT inactivity_days FROM watch_preferences WHERE user_id = ?").get(user)?.inactivity_days ?? 60;
export function setInactivity(user: number, days: number) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new ApiError(400, "Срок — от 1 до 3650 дней, 0 отключает правило");
  db.prepare("INSERT INTO watch_preferences (user_id,inactivity_days) VALUES (?,?) ON CONFLICT (user_id) DO UPDATE SET inactivity_days=excluded.inactivity_days").run(user, days);
}
export function inactivityTick() {
  // Adopt legacy in-progress entries as explicit baselines, starting a fresh grace period.
  const legacy=db.prepare<[],{user_id:number;anilist_id:number}>(`SELECT e.user_id,e.anilist_id FROM list_entries e
    WHERE e.deleted=0 AND e.status IN ('watching','rewatching') AND NOT EXISTS
    (SELECT 1 FROM watch_cycles c WHERE c.user_id=e.user_id AND c.anilist_id=e.anilist_id)`).all();
  for(const e of legacy) db.transaction(()=>{
    db.prepare("UPDATE users SET name=name WHERE id=?").run(e.user_id);
    const c=ensureCycle(e.user_id,e.anilist_id);
    db.prepare("UPDATE watch_cycles SET started_at=COALESCE(started_at,?) WHERE id=?").run(now(),c.id);
  })();
  for (const c of db.prepare<[], Cycle>("SELECT * FROM watch_cycles WHERE ended_at IS NULL AND started_at IS NOT NULL").all()) {
    const days = inactivityDays(c.user_id), m = getMedia(c.anilist_id), row = getRow(c.user_id, c.anilist_id);
    if (!days || !m || !row || !["watching", "rewatching"].includes(row.status)) continue;
    const aired = airedCount(m), seen = new Set(cycleEpisodes(c));
    const waiting = aired !== null && Array.from({ length: aired }, (_, i) => i + 1).every(ep => ep <= c.baseline || seen.has(ep));
    if (waiting && m.status !== "FINISHED") {
      db.prepare("UPDATE watch_cycles SET idle_since = NULL WHERE id = ?").run(c.id); continue;
    }
    // First observation of an unwatched release starts its inactivity clock.
    const since = c.idle_since ?? (m.status === "FINISHED" ? c.last_activity : now());
    if (!c.idle_since) db.prepare("UPDATE watch_cycles SET idle_since = ? WHERE id = ?").run(since, c.id);
    if (now() - Math.max(since, c.last_activity) < days * 86400) continue;
    upsertEntry(c.user_id, m, { status: c.prior_completed ? "completed" : "dropped" });
    db.prepare("UPDATE watch_cycles SET ended_at = ?, outcome = 'inactive' WHERE id = ?").run(now(), c.id);
  }
}
