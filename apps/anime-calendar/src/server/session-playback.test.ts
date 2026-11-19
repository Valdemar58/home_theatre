import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GROUP_PERMISSIONS } from "@/lib/group-policy";

vi.mock("server-only", () => ({}));
vi.mock("./notifications", () => ({ notify: vi.fn() }));
vi.mock("./social", () => ({ areFriends: () => true, friendIds: () => [] }));
const catalog = vi.hoisted(() => ({ available: true }));
vi.mock("./lists", () => ({ getMedia: (id: number) => ({ id, title: { romaji: `Title ${id}` }, episodes: 12, status: catalog.available ? "FINISHED" : "NOT_YET_RELEASED" }) }));
process.env.DATABASE_DRIVER = process.env.POSTGRES_TEST === "1" ? "postgres" : "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "session-playback-"));
const { db } = await import("./db");
const { createRoom, roomCommand, roomReport, roomView, roomPresence, roomSessionTick } = await import("./rooms");
const owner = { id: 1, name: "organizer" }, viewer = { id: 2, name: "viewer" };
let room: string, group: number, sessionId: number, time: number;
const state = () => roomView(1, room).state;
const elapse = (ms: number) => { while (ms > 0) { const step = Math.min(10000, ms); time += step; ms -= step; roomSessionTick(); } };
const command = (body: Record<string, unknown>, user = owner) => roomCommand(user, room, { revision: state().session!.revision, ...body } as Parameters<typeof roomCommand>[2]);
const end = () => {
  const r = roomView(1, room);
  command({ action: "seek", pos: 120 });
  return command({ action: "session-ended", anilistId: r.anilistId, ep: r.state.ep, duration: 120 });
};
beforeEach(() => {
  vi.restoreAllMocks(); time = new Date("2026-11-12T10:00:00Z").getTime(); vi.spyOn(Date, "now").mockImplementation(() => time);
  catalog.available = true;
  db.exec("DELETE FROM watch_rooms; DELETE FROM shared_lists; DELETE FROM users;");
  for (const u of [owner, viewer]) db.prepare("INSERT INTO users (id,jellyfin_id,name,created_at) VALUES (?,?,?,0)").run(u.id, String(u.id), u.name);
  group = Number(db.prepare("INSERT INTO shared_lists (name,owner_id,created_at,permissions) VALUES ('test',1,0,?)").run(JSON.stringify(DEFAULT_GROUP_PERMISSIONS)).lastInsertRowid);
  for (const id of [1, 2]) db.prepare("INSERT INTO shared_list_members (list_id,user_id,status,joined_at) VALUES (?,?,'member',0)").run(group, id);
  const plan = { blocks: [{ anilistId: 10, episodes: [1, 3], breakMinutes: 2, durationMinutes: 2, durationSource: "catalog" }, { anilistId: 20, episodes: [4], breakMinutes: 10, durationMinutes: 2, durationSource: "catalog" }], timeZone: "UTC", skipCredits: false };
  sessionId = Number(db.prepare("INSERT INTO group_sessions (list_id,anilist_id,ep,count,starts_at,created_by,created_at,status,plan_json) VALUES (?,10,1,2,?,1,0,'live',?)").run(group, time / 1000, JSON.stringify(plan)).lastInsertRowid);
  room = createRoom(owner, 10, 1, [2], 0, false, { id: group, sessionId, preset: "equal", control: [] }).id;
  db.prepare("UPDATE group_sessions SET room_id = ? WHERE id = ?").run(room, sessionId);
  roomCommand(viewer, room, { action: "join" });
});

describe("planned playback", () => {
  it.each([[10, 20], [20, 10]])("respects order %s → %s and cancellation at a zero-break deadline", (first, second) => {
    const initial = state();
    initial.ep = 2;
    initial.session!.blocks = [first, second].map(anilistId => ({ anilistId, episodes: [2], breakMinutes: 0, durationMinutes: 2, durationSource: "catalog" as const }));
    db.prepare("UPDATE watch_rooms SET anilist_id=?,state=? WHERE id=?").run(first, JSON.stringify(initial), room);
    end();
    expect(state().session!.deadline).toBe(time);
    command({ action: "session-autoplay", enabled: false });
    roomSessionTick(); expect(roomView(1, room).anilistId).toBe(first);
    command({ action: "session-autoplay", enabled: true });
    roomSessionTick(); expect(roomView(1, room).anilistId).toBe(second);
    expect(state().ep).toBe(2);
    end(); roomSessionTick(); expect(state().session!.phase).toBe("complete");
  });
  it("advances exact selected episodes, waits the planned break, then finishes once", () => {
    const first = end(); expect(first.state.session?.phase).toBe("next");
    time += 9999; roomSessionTick(); expect(state().ep).toBe(1);
    time++; roomSessionTick(); expect(state().ep).toBe(3); expect(state().playing).toBe(true);
    end(); expect(state().session?.phase).toBe("break");
    elapse(119999); expect(roomView(1, room).anilistId).toBe(10);
    time++; roomSessionTick(); expect(roomView(1, room).anilistId).toBe(20); expect(state().ep).toBe(4);
    end(); expect(state().session?.phase).toBe("complete"); expect(state().playing).toBe(false);
    expect(db.prepare("SELECT status FROM group_sessions WHERE id = ?").get(sessionId)).toEqual({ status: "done" });
    time += 600000; roomSessionTick(); expect(state().ep).toBe(4);
  });
  it("cancels the shared countdown and resumes immediately after its deadline when enabled", () => {
    end(); command({ action: "session-autoplay", enabled: false });
    const deadline = state().session!.deadline;
    elapse(20000); expect(state().ep).toBe(1); expect(state().session!.deadline).toBe(deadline);
    command({ action: "session-autoplay", enabled: true }); roomSessionTick(); expect(state().ep).toBe(3);
  });
  it("rejects stale completion, stale controls and early ended reports", () => {
    expect(() => command({ action: "session-ended", anilistId: 10, ep: 1, duration: 120 })).toThrow(/конца/);
    const revision = state().session!.revision; end(); time += 10000; roomSessionTick();
    roomCommand(viewer, room, { action: "session-ended", revision, anilistId: 10, ep: 1, duration: 120 });
    roomCommand(owner, room, { action: "session-next", revision });
    expect(state().ep).toBe(3); expect(state().session!.phase).toBe("watching");
  });
  it("only connected viewers block preparation; old-episode reports cannot release the barrier", () => {
    roomPresence(1, room, true); roomPresence(2, room, true);
    end(); time += 10000; roomSessionTick();
    expect(state().hold).toEqual([1, 2]); expect(state().playing).toBe(false);
    roomReport(2, room, { buffering: false, revision: 1, anilistId: 10, ep: 1 }); expect(state().hold).toEqual([1, 2]);
    const revision = state().session!.revision;
    roomReport(1, room, { buffering: false, revision, anilistId: 10, ep: 3 }); expect(state().hold).toEqual([2]);
    roomReport(2, room, { buffering: false, revision, anilistId: 10, ep: 3 }); expect(state().playing).toBe(true);
  });
  it("lets authorized viewers continue without a stalled viewer and does not stop again until return", () => {
    roomPresence(1, room, true); roomPresence(2, room, true); end(); time += 10000; roomSessionTick();
    const revision = state().session!.revision;
    roomReport(1, room, { buffering: false, revision, anilistId: 10, ep: 3 });
    command({ action: "play", pos: 0 });
    roomReport(2, room, { buffering: true, revision, anilistId: 10, ep: 3 }); expect(state().playing).toBe(true);
    roomReport(2, room, { buffering: false, revision, anilistId: 10, ep: 3 });
    roomReport(2, room, { buffering: true, revision, anilistId: 10, ep: 3 }); expect(state().hold).toEqual([2]);
  });
  it("checks live permissions and release status without skipping a blocked item", () => {
    db.prepare("UPDATE shared_lists SET permissions = ? WHERE id = ?").run(JSON.stringify({ ...DEFAULT_GROUP_PERMISSIONS, play: "owner" }), group);
    expect(() => command({ action: "session-next" }, viewer)).toThrow(/организатор/);
    end(); catalog.available = false; time += 10000; roomSessionTick();
    expect(state().ep).toBe(1); expect(state().session!.autoplay).toBe(false); expect(state().session!.blocked).toBeTruthy();
    catalog.available = true; command({ action: "session-next" }); expect(state().ep).toBe(3);
  });
  it("pauses on a coordination outage instead of silently advancing an expired countdown", () => {
    end(); time += 30000; roomSessionTick();
    expect(state().ep).toBe(1); expect(state().session!.autoplay).toBe(false);
    command({ action: "session-next" }); expect(state().ep).toBe(3);
  });
});

it("manual next during countdown advances once; manual boundary starts the planned break",()=>{
 end();const revision=state().session!.revision;
 roomCommand(owner,room,{action:"session-next",revision});
 roomCommand(viewer,room,{action:"session-next",revision});
 expect(state().ep).toBe(3);expect(state().session!.phase).toBe("watching");
 command({action:"session-next"});expect(state().session!.phase).toBe("break");expect(state().playing).toBe(false);
 elapse(120000);expect(roomView(1,room).anilistId).toBe(20);
});
it("strip selection adjusts the live cursor without marking skipped episodes or editing the saved plan",()=>{
 const saved=db.prepare("SELECT plan_json FROM group_sessions WHERE id=?").get(sessionId);
 command({action:"ep",ep:3});expect(state().session).toMatchObject({episode:1,phase:"watching"});
 command({action:"ep",ep:2});expect(state().ep).toBe(2);
 expect(db.prepare("SELECT plan_json FROM group_sessions WHERE id=?").get(sessionId)).toEqual(saved);
});
