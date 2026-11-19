import "server-only";
import { coverageState } from "@/lib/watch-coverage";
import { db, now } from "./db";

type CoverageSession = { sid: string; userId: number; anilistId: number; ep: number; duration: number };

/** Continue unfinished evidence only for exactly the same media, never inherit a completed attempt. */
export function coverageAttempt(s: CoverageSession, itemKey: string): string {
  return db.transaction(() => {
    db.prepare("UPDATE users SET name = name WHERE id = ?").run(s.userId);
    const previous = db.prepare<[number, number, number, string, number], { sid: string }>(
      `SELECT p.sid FROM playback_coverage p LEFT JOIN watch_cycles c ON c.id=p.cycle_id
       WHERE p.user_id = ? AND p.anilist_id = ? AND p.ep = ?
       AND p.item_key = ? AND p.duration = ? AND p.watched = 0 AND (c.id IS NULL OR c.ended_at IS NULL) ORDER BY p.updated_at DESC LIMIT 1`)
      .get(s.userId, s.anilistId, s.ep, itemKey, s.duration);
    if (previous) return previous.sid;
    db.prepare(`INSERT INTO playback_coverage (sid,user_id,anilist_id,ep,duration,item_key,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(s.sid, s.userId, s.anilistId, s.ep, s.duration, itemKey, now());
    return s.sid;
  })();
}

/** Durable raw evidence. Cycle/group projections are deliberately separate from this journal. */
export function recordCoverage(s: CoverageSession, input: unknown) {
  return db.transaction(() => {
    db.prepare(`INSERT INTO playback_coverage (sid,user_id,anilist_id,ep,duration,intervals,updated_at)
      VALUES (?,?,?,?,?,'[]',?) ON CONFLICT (sid) DO NOTHING`)
      .run(s.sid, s.userId, s.anilistId, s.ep, s.duration, now());
    // Serializes concurrent periodic/pause/final reports on PostgreSQL as well as SQLite.
    db.prepare("UPDATE playback_coverage SET updated_at = ? WHERE sid = ?").run(now(), s.sid);
    const row = db.prepare<[string], { intervals: string }>("SELECT intervals FROM playback_coverage WHERE sid = ?").get(s.sid)!;
    const incoming = Array.isArray(input) ? input.slice(0, 4096) : [];
    const result = coverageState([...JSON.parse(row.intervals), ...incoming], s.duration);
    const changed = result.seconds > coverageState(JSON.parse(row.intervals),s.duration).seconds;
    db.prepare("UPDATE playback_coverage SET intervals = ?, watched = ? WHERE sid = ?")
      .run(JSON.stringify(result.intervals), result.watched ? 1 : 0, s.sid);
    return { ...result, changed };
  })();
}
