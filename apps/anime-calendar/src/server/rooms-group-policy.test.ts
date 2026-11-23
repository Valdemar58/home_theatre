import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GROUP_PERMISSIONS } from "@/lib/group-policy";

vi.mock("server-only", () => ({}));
vi.mock("./notifications", () => ({ notify: vi.fn() }));
vi.mock("./social", () => ({ areFriends: () => true, friendIds: () => [] }));
vi.mock("./lists", () => ({ getMedia: () => ({status:"FINISHED",episodes:12,schedule:[],title:{romaji:"Test"}}) }));
process.env.DATABASE_DRIVER = process.env.POSTGRES_TEST === "1" ? "postgres" : "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "room-policy-"));
const { db } = await import("./db");
const { createRoom, roomCommand, roomReport, roomView, roomPresence, roomPoll, roomSessionTick } = await import("./rooms");
const owner = { id: 1, name: "organizer" }, member = { id: 2, name: "viewer" };
let group: number;
let room: string;
const { createRoomWithSource } = await import("./room-source");
const desktop = await import("./desktop");
const stream = await import("./desktop-stream");
it("carries the owned desktop source into a new group room for both viewers", () => {
  const pair = desktop.beginPairing("Host", "win32"); desktop.approveDevice(pair.id, 1);
  const device = desktop.deviceByToken(pair.token);
  desktop.heartbeat(device, [{ id: "1234567890abcdef", title: 10, ep: 1, state: "ready", bytes: 8, preparedBytes: 8, duration: 24, preparedVersion: `sha256:${"a".repeat(64)}`, version: `sha256:${"b".repeat(64)}`, progress: 1 }]);
  stream.hostState(device.id);
  const next = createRoomWithSource(device.id, owner, 10, 1, [2], 12, false, { id: group, preset: "equal", control: [] });
  roomCommand(member, next.id, { action: "join" });
  expect(stream.sourceState(1, next.id).selected).toBe(device.id);
  expect(stream.sourceState(2, next.id).selected).toBe(device.id);
  expect(roomView(1, next.id).state.pos).toBe(12);
});
it("rejects an unavailable device or a missing group without ending the old room", () => {
  expect(() => createRoomWithSource("missing", owner, 10, 1, [2], 0, false, { id: group, preset: "equal", control: [] })).toThrow();
  expect(() => createRoomWithSource("missing", owner, 10, 1, [2])).toThrow(/выберите группу/);
  expect(roomView(1, room).ended).toBe(false);
  expect(db.prepare("SELECT id FROM watch_rooms").all()).toHaveLength(1);
});
it("rolls back a new room and grant when the owned host has no prepared copy", () => {
  const pair = desktop.beginPairing("Empty host", "win32"); desktop.approveDevice(pair.id, 1);
  const device = desktop.deviceByToken(pair.token);
  desktop.heartbeat(device, [{ id: "1234567890abcdef", title: 10, ep: 1, state: "imported", bytes: 8, version: `sha256:${"b".repeat(64)}`, progress: 0 }]); stream.hostState(device.id);
  expect(() => createRoomWithSource(device.id, owner, 10, 1, [2], 5, false, { id: group, preset: "equal", control: [] })).toThrow(/готовой/);
  expect(roomView(1, room).ended).toBe(false);
  expect(db.prepare("SELECT id FROM watch_rooms").all()).toHaveLength(1);
  expect(desktop.grantsFor(device.id)).toHaveLength(0);
});
beforeEach(() => {
  db.exec("DELETE FROM watch_rooms; DELETE FROM shared_lists; DELETE FROM users;");
  for (const u of [owner, member, { id: 3, name: "outsider" }]) db.prepare("INSERT INTO users (id,jellyfin_id,name,created_at) VALUES (?,?,?,0)").run(u.id, String(u.id), u.name);
  group = Number(db.prepare("INSERT INTO shared_lists (name,owner_id,created_at,permissions) VALUES ('test',1,0,?)").run(JSON.stringify(DEFAULT_GROUP_PERMISSIONS)).lastInsertRowid);
  for (const id of [1, 2]) db.prepare("INSERT INTO shared_list_members (list_id,user_id,status,joined_at) VALUES (?,?,'member',0)").run(group, id);
  room = createRoom(owner, 10, 1, [2], 0, false, { id: group, preset: "equal", control: [] }).id;
  roomCommand(member, room, { action: "join" });
});
describe("group playback permissions", () => {
  it("honors a permission revocation in an already open player", () => {
    roomCommand(member, room, { action: "play", pos: 10 });
    db.prepare("UPDATE shared_lists SET permissions = ? WHERE id = ?").run(JSON.stringify({ ...DEFAULT_GROUP_PERMISSIONS, play: "owner" }), group);
    expect(() => roomCommand(member, room, { action: "pause", pos: 11 })).toThrow(/организатор/);
    expect(roomView(2, room).members.find(m => m.id === 2)?.control).toBe(false);
    roomCommand(owner, room, { action: "pause", pos: 11 });
  });
  it("removed members cannot rejoin, receive state, or pause everyone through buffering", () => {
    roomCommand(owner, room, { action: "play", pos: 20 });
    db.prepare("DELETE FROM shared_list_members WHERE list_id = ? AND user_id = 2").run(group);
    expect(() => roomReport(2, room, { buffering: true })).toThrow();
    expect(() => roomCommand(member, room, { action: "join" })).toThrow();
    expect(() => roomView(2, room)).toThrow();
    expect(roomView(1, room).state.playing).toBe(true);
  });
  it("a rejected group creation leaves existing playback intact", () => {
    expect(() => createRoom(owner, 10, 1, [3], 0, false, { id: group, preset: "equal", control: [] })).toThrow(/вступления/);
    expect(roomView(1, room).ended).toBe(false);
    expect(db.prepare("SELECT id FROM watch_rooms").all()).toHaveLength(1);
  });
  it("rejects outside friends before recording a broken invitation", () => {
    expect(() => roomCommand(owner, room, { action: "invite", users: [3] })).toThrow(/вступления/);
    expect(db.prepare("SELECT 1 FROM watch_room_members WHERE room_id = ? AND user_id = 3").get(room)).toBeUndefined();
  });
});

afterEach(() => vi.useRealTimers());
it("polling keeps a viewer online without leaking SSE counts, and expires into the shared barrier", () => {
  vi.useFakeTimers(); roomCommand(owner, room, {action:"play",pos:10});
  for(let i=0;i<10;i++)roomPoll(2,room);
  roomPresence(2,room,false);
  expect(roomView(1,room).members.find(m=>m.id===2)?.presence?.online).toBe(true);
  expect(roomView(1,room).state.playing).toBe(true);
  vi.advanceTimersByTime(9000); roomSessionTick();
  expect(roomView(1,room).members.find(m=>m.id===2)?.presence?.online).toBe(false);
  expect(roomView(1,room).state.playing).toBe(false); expect(roomView(1,room).state.hold).toContain(2);
});
it("reports a media failure separately from buffering and clears it on retry", () => {
  roomReport(2,room,{buffering:true,playbackError:true});
  expect(roomView(1,room).members.find(m=>m.id===2)?.presence?.playbackError).toBe(true);
  roomReport(2,room,{buffering:false,playbackError:false});
  expect(roomView(1,room).members.find(m=>m.id===2)?.presence?.playbackError).toBe(false);
});
it("buffer exhaustion pauses everyone, never times out, and recovery resumes automatically", () => {
  vi.useFakeTimers(); roomCommand(owner, room, { action: "play", pos: 10 });
  roomReport(2, room, { buffering: false, position: 10, buffered: [[0,20]] });
  expect(roomView(1, room).state.playing).toBe(true);
  roomReport(2, room, { buffering: true, position: 20, buffered: [[0,20]] });
  expect(roomView(1, room).state).toMatchObject({ playing: false, hold: [2] });
  vi.advanceTimersByTime(120000); expect(roomView(1, room).state.hold).toEqual([2]);
  roomReport(2, room, { buffering: false, position: 20, buffered: [[0,30]] });
  expect(roomView(1, room).state).toMatchObject({ playing: true, hold: [] });
});
it("continue without waiting excludes only until actual recovery", () => {
  roomCommand(owner, room, { action: "play", pos: 10 }); roomReport(2, room, { buffering: true });
  roomCommand(owner, room, { action: "play", pos: 10 }); roomReport(2, room, { buffering: true });
  expect(roomView(1, room).state.playing).toBe(true);
  roomReport(2, room, { buffering: false }); roomReport(2, room, { buffering: true });
  expect(roomView(1, room).state).toMatchObject({ playing: false, hold: [2] });
});

it("a disconnected active viewer remains in the group barrier until recovery", () => {
  roomPresence(2, room, true); roomCommand(owner, room, { action: "play", pos: 12 });
  roomPresence(2, room, false); expect(roomView(1, room).state).toMatchObject({ playing: false, hold: [2] });
  roomPresence(2, room, true); roomReport(2, room, { buffering: false });
  expect(roomView(1, room).state).toMatchObject({ playing: true, hold: [] });
});
it("a disconnect during a manual pause does not turn it into autoplay", () => {
  roomPresence(2, room, true); roomPresence(2, room, false); roomPresence(2, room, true);
  roomReport(2, room, { buffering: false }); expect(roomView(1, room).state.playing).toBe(false);
});

it("manual changes wait for connected viewers and reject stale reports and commands",()=>{
 roomPresence(1,room,true);roomPresence(2,room,true);
 expect(roomCommand(owner,room,{action:"ep",ep:2,expectedGeneration:0}).state).toMatchObject({ep:2,playing:false,hold:[1,2],generation:1});
 roomReport(2,room,{buffering:false,anilistId:10,ep:1,revision:0});expect(roomView(1,room).state.hold).toEqual([1,2]);
 roomCommand(owner,room,{action:"pause",pos:50,expectedGeneration:0,expectedEp:1});
 roomReport(1,room,{buffering:false,anilistId:10,ep:2,revision:1});expect(roomView(1,room).state).toMatchObject({playing:false,hold:[2],pos:0});
 roomReport(2,room,{buffering:false,anilistId:10,ep:2,revision:1});expect(roomView(1,room).state).toMatchObject({playing:true,hold:[],ep:2});
 roomCommand(owner,room,{action:"ep",ep:3,expectedGeneration:0});expect(roomView(1,room).state.ep).toBe(2);
});
