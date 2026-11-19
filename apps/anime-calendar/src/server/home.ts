import "server-only";
import { db, now } from "./db";
import { listWithMedia, getMedia } from "./lists";
import { latestCycle, cycleEpisodes } from "./watch-history";
import { episodeAvailability } from "@/lib/session-plan";
import { groupPlan } from "./groups";
import { membersOf } from "./together";
import { ownDevices } from "./desktop";
import { deviceDownloads } from "./desktop-commands";

/** Personal dashboard. No external API fan-out and no other users' device state. */
export function homeData(user: number) {
  const continuing = listWithMedia(user).filter(e => e.media && ["watching", "rewatching"].includes(e.status)).map(e => {
    const media = e.media!;
    const cycle = latestCycle(user, e.anilistId);
    const watched = new Set(cycle && !cycle.ended_at ? cycleEpisodes(cycle) : []);
    const baseline = cycle && !cycle.ended_at ? cycle.baseline : e.episodes;
    let ep = baseline + 1;
    while (watched.has(ep)) ep++;
    const recent = db.prepare<[number,number], {ep:number;pos:number;dur:number|null;updated_at:number}>("SELECT ep,pos,dur,updated_at FROM playback_pos WHERE user_id=? AND anilist_id=? ORDER BY updated_at DESC").all(user,media.id)
      .find(p => p.ep > baseline && !watched.has(p.ep) && p.pos>0 && (!p.dur || p.pos<p.dur*.8) && (!cycle || p.updated_at >= (cycle.started_at ?? cycle.last_activity)));
    if (recent) ep=recent.ep;
    const availability = episodeAvailability(media, ep, now());
    const saved = db.prepare<[number, number, number], {pos:number;dur:number|null;updated_at:number}>("SELECT pos,dur,updated_at FROM playback_pos WHERE user_id=? AND anilist_id=? AND ep=?").get(user, media.id, ep);
    const current = saved && (!cycle || saved.updated_at >= (cycle.started_at ?? cycle.last_activity));
    return { media, ep, status: e.status, available: availability.selectable, releaseAt: availability.releaseAt ?? null,
      position: current && saved.pos > 0 && (!saved.dur || saved.pos < saved.dur * .8) ? saved.pos : 0,
      updatedAt: Math.max(e.updatedAt, cycle?.last_activity ?? 0, current ? saved.updated_at : 0) };
  }).sort((a,b) => b.updatedAt - a.updatedAt).slice(0,6);
  const upcoming = db.prepare<[number, number], {id:number;list_id:number;name:string}>(`SELECT s.id,s.list_id,l.name FROM group_sessions s
    JOIN shared_lists l ON l.id=s.list_id JOIN shared_list_members m ON m.list_id=l.id
    WHERE m.user_id=? AND m.status='member' AND (s.status='live' OR (s.status='planned' AND s.starts_at>?))
    ORDER BY CASE WHEN s.status='live' THEN 0 ELSE 1 END,s.starts_at LIMIT 1`).get(user, now()-7200);
  const session = upcoming ? groupPlan(user, upcoming.list_id).sessions.find(s => s.id === upcoming.id) : null;
  const next = session && upcoming ? { ...session, groupId: upcoming.list_id, groupName: upcoming.name,
    titles: (session.plan?.blocks ?? []).map(b => ({ ...b, media: getMedia(b.anilistId) })),
    attendees: membersOf(upcoming.list_id).filter(m => session.rsvp.some(r => r.userId === m.user_id && r.answer === "yes")).map(m => ({id:m.user_id,name:m.name})) } : null;
  const devices = ownDevices(user).filter(d => !d.revoked).map(d => {
    const snapshot = deviceDownloads(user,d.id);
    return { ...d, updatedAt: snapshot.updatedAt, jobs: snapshot.jobs, queued: snapshot.commands.filter(c => c.state === "queued").length };
  });
  return { continuing, next, devices };
}
