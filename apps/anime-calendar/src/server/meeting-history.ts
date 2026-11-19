import "server-only";
import { randomUUID } from "node:crypto";
import { db, now } from "./db";
import { getMedia } from "./lists";
import { groupAccess } from "./group-policy";
import { ApiError } from "./route";
import { addEpisode, ensureCycle, projectCycle } from "./watch-history";
import { coverageState } from "@/lib/watch-coverage";
import type { RoomState } from "@/lib/room";

export type MeetingResult = { anilistId: number; episodes: number[] };
type Correction = { results: MeetingResult[]; attendees: number[]; note: string };
type Meeting = { id: number; list_id: number; status: string; revision: number; starts_at: number };
const getMeeting = (id: number) => db.prepare<[number], Meeting>("SELECT id,list_id,status,revision,starts_at FROM group_sessions WHERE id = ?").get(id);

export function meetingResult(id: number) {
  const journal = db.prepare<[number], { id: string; actor_id: number; created_at: number; payload: string }>("SELECT * FROM meeting_history WHERE meeting_id = ? ORDER BY created_at DESC,id DESC").all(id);
  if (journal.length) {
    const correction = JSON.parse(journal[0].payload) as Correction;
    return { ...correction, source: "organizer" as const, journal: journal.map(x => ({ ...x, payload: JSON.parse(x.payload) as Correction })) };
  }
  const rows = db.prepare<[number], { anilist_id: number; ep: number; user_id: number; duration: number; intervals: string }>("SELECT * FROM meeting_coverage WHERE meeting_id = ?").all(id);
  const grouped = new Map<number, Set<number>>(), attendees = new Set<number>();
  const evidence = new Map<string, { title:number; ep:number; duration:number; intervals:number[][] }>();
  for (const r of rows) {
    const state = coverageState(JSON.parse(r.intervals), r.duration);
    if (state.seconds > 0) attendees.add(r.user_id);
    const key=`${r.anilist_id}:${r.ep}:${r.duration}`;
    const item=evidence.get(key)??{title:r.anilist_id,ep:r.ep,duration:r.duration,intervals:[]};
    item.intervals.push(...state.intervals);evidence.set(key,item);
  }
  for(const e of evidence.values()) {
    if(!coverageState(e.intervals,e.duration).watched)continue;
    if(!grouped.has(e.title))grouped.set(e.title,new Set());
    grouped.get(e.title)!.add(e.ep);
  }
  return { results: [...grouped].map(([anilistId, eps]) => ({ anilistId, episodes: [...eps].sort((a,b) => a-b) })), attendees: [...attendees], note: "", source: "online" as const, journal: [] };
}

export function groupEpisodes(group: number, title: number) {
  const ids = db.prepare<[number], { id: number }>("SELECT id FROM group_sessions WHERE list_id = ?").all(group);
  return [...new Set(ids.flatMap(x => meetingResult(x.id).results.filter(r => r.anilistId === title).flatMap(r => r.episodes)))].sort((a,b) => a-b);
}

export function recordMeetingCoverage(user: number, room: string, revision: number, title: number, ep: number, attempt: string, duration: number, intervals: unknown) {
  const r = db.prepare<[string, number], { anilist_id: number; session_id: number | null; state: string; ended_at: number | null }>(
    `SELECT r.anilist_id,r.session_id,r.state,r.ended_at FROM watch_rooms r JOIN watch_room_members m ON m.room_id=r.id
     JOIN shared_list_members gm ON gm.list_id=r.group_id AND gm.user_id=m.user_id AND gm.status='member'
     WHERE r.id = ? AND m.user_id = ? AND m.status = 'joined'`).get(room, user);
  if (!r?.session_id || r.ended_at) return;
  const s = JSON.parse(r.state) as RoomState;
  if (s.session?.revision !== revision || s.session.phase !== "watching" || r.anilist_id !== title || s.ep !== ep) return;
  // Evidence belongs to the reporting viewer, never to RSVPs or absent participants.
  const previous=db.prepare<[number,number,string],{intervals:string}>("SELECT intervals FROM meeting_coverage WHERE meeting_id=? AND user_id=? AND attempt=?").get(r.session_id,user,attempt);
  const state = coverageState([...(previous?JSON.parse(previous.intervals):[]),...(Array.isArray(intervals)?intervals:[])], duration);
  db.prepare(`INSERT INTO meeting_coverage (meeting_id,anilist_id,ep,user_id,attempt,duration,intervals,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (meeting_id,user_id,attempt) DO UPDATE SET intervals=excluded.intervals,updated_at=excluded.updated_at`)
    .run(r.session_id,title,ep,user,attempt,duration,JSON.stringify(state.intervals),now());
}

function validate(user: number, id: number, input: Correction, revision: number) {
  const meeting = getMeeting(id);
  if (!meeting) throw new ApiError(404, "Встреча не найдена");
  const access = groupAccess(meeting.list_id,user);
  const owner = db.prepare<[number], { owner_id: number }>("SELECT owner_id FROM shared_lists WHERE id = ?").get(meeting.list_id);
  if (!access || owner?.owner_id !== user) throw new ApiError(403, "Исправляет результат организатор комнаты");
  if (meeting.status === "live") throw new ApiError(409, "Сначала завершите активный сеанс");
  if (meeting.revision !== revision) throw new ApiError(409, "Результат изменился. Откройте его заново");
  if (!Array.isArray(input.results) || input.results.length > 50 || !Array.isArray(input.attendees)) throw new ApiError(400, "Неверный результат");
  const members = db.prepare<[number], { user_id: number }>("SELECT user_id FROM shared_list_members WHERE list_id = ? AND status = 'member'").all(meeting.list_id).map(x=>x.user_id);
  if (input.attendees.some(x=>!members.includes(x))) throw new ApiError(400, "Выберите действующих участников комнаты");
  const results = input.results.map(r => {
    const m = getMedia(r.anilistId);
    if (!m || !Array.isArray(r.episodes) || r.episodes.length > 2000 || r.episodes.some(ep=>!Number.isInteger(ep)||ep<1||(m.episodes && ep>m.episodes))) throw new ApiError(400,"Некорректные серии");
    return { anilistId:r.anilistId, episodes:[...new Set(r.episodes)].sort((a,b)=>a-b) };
  });
  if (new Set(results.map(x=>x.anilistId)).size !== results.length) throw new ApiError(400,"Тайтл повторяется");
  return { meeting, correction: { results, attendees:[...new Set(input.attendees)],note:String(input.note??"").trim().slice(0,1000) } };
}

export function previewMeeting(user: number, id: number, input: Correction, revision: number) {
  const { correction } = validate(user,id,input,revision);
  const previous=db.prepare<[number],{user_id:number;anilist_id:number;ep:number}>(`SELECT c.user_id,c.anilist_id,e.ep FROM watch_episode_events e
    JOIN watch_cycles c ON c.id=e.cycle_id WHERE e.meeting_id=? AND e.source='organizer' AND e.revoked_at IS NULL`).all(id);
  const declined=db.prepare<[number],{user_id:number;anilist_id:number;ep:number}>(`SELECT c.user_id,c.anilist_id,e.ep FROM watch_episode_events e
    JOIN watch_cycles c ON c.id=e.cycle_id WHERE e.meeting_id=? AND e.source='organizer' AND e.revoked_by=c.user_id`).all(id);
  const users=[...new Set([...correction.attendees,...previous.map(e=>e.user_id)])];
  return { ...correction, changes: users.map(userId=>{
    const before=previous.filter(e=>e.user_id===userId);
    const after=correction.attendees.includes(userId)?correction.results.map(r=>({...r,episodes:r.episodes.filter(ep=>!declined.some(e=>e.user_id===userId&&e.anilist_id===r.anilistId&&e.ep===ep))})):[];
    return {userId,added:after.map(r=>({...r,episodes:r.episodes.filter(ep=>!before.some(e=>e.anilist_id===r.anilistId&&e.ep===ep))})).filter(r=>r.episodes.length),
      removed:[...new Set(before.map(e=>e.anilist_id))].map(anilistId=>({anilistId,episodes:before.filter(e=>e.anilist_id===anilistId&&!after.some(r=>r.anilistId===anilistId&&r.episodes.includes(e.ep))).map(e=>e.ep)})).filter(r=>r.episodes.length)};
  }) };
}

export function correctMeeting(user: number, id: number, input: Correction, revision: number) {
  return db.transaction(() => {
    db.prepare("UPDATE group_sessions SET revision=revision WHERE id = ?").run(id);
    const { correction } = validate(user,id,input,revision);
    const affected = new Set<string>();
    const old = db.prepare<[number], { cycle_id: string; user_id: number; anilist_id: number; ep: number; revoked_at: number | null; revoked_by: number | null }>(`SELECT e.cycle_id,c.user_id,c.anilist_id,e.ep,e.revoked_at,e.revoked_by FROM watch_episode_events e JOIN watch_cycles c ON c.id=e.cycle_id
      WHERE e.meeting_id = ? AND e.source='organizer'`).all(id);
    for (const e of old) affected.add(e.cycle_id);
    db.prepare("UPDATE watch_episode_events SET revoked_at=COALESCE(revoked_at,?) WHERE meeting_id=? AND source='organizer'").run(now(),id);
    const event = randomUUID();
    for (const member of correction.attendees.sort((a,b)=>a-b)) {
      db.prepare("UPDATE users SET name=name WHERE id=?").run(member);
      for (const r of correction.results) {
        const previous = old.find(x=>x.user_id===member&&x.anilist_id===r.anilistId);
        const c = previous ? db.prepare<[string], ReturnType<typeof ensureCycle>>("SELECT * FROM watch_cycles WHERE id=?").get(previous.cycle_id)! : ensureCycle(member,r.anilistId);
        for (const ep of r.episodes) {
          // A participant's explicit correction is not silently overwritten by an organizer edit.
          const declined = old.some(x=>x.user_id===member&&x.anilist_id===r.anilistId&&x.ep===ep&&x.revoked_by===member);
          if (!declined) addEpisode(c,ep,"organizer",user,`${event}:${member}:${r.anilistId}:${ep}`,id);
        }
        affected.add(c.id);
      }
    }
    const last = db.prepare<[number], { t: number | null }>("SELECT MAX(created_at) t FROM meeting_history WHERE meeting_id=?").get(id)?.t ?? 0;
    db.prepare("INSERT INTO meeting_history (id,meeting_id,actor_id,created_at,payload) VALUES (?,?,?,?,?)")
      .run(event,id,user,Math.max(now(),last+1),JSON.stringify(correction));
    db.prepare("UPDATE group_sessions SET status='done',revision=revision+1 WHERE id=?").run(id);
    affected.forEach(projectCycle);
    return meetingResult(id);
  })();
}
