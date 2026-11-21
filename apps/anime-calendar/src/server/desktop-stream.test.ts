import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./rooms", () => ({ roomView: (user: number) => ({ id: "room", groupId: 1, anilistId: 42, ended: false, preset: "host", state: { ep: 1 }, members: [{ id: 1, host: true, control: true, status: "joined" }, { id: 2, host: false, control: false, status: user === 3 ? "left" : "joined" }] }) }));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "desktop-stream-"));
const { db } = await import("./db");
const h = await import("./desktop");
const s = await import("./desktop-stream");
let device: ReturnType<typeof h.deviceByToken>;
const file = { id: "1234567890abcdef", title: 42, ep: 1, version: `sha256:${"a".repeat(64)}`, preparedVersion: `sha256:${"b".repeat(64)}`, bytes: 8, preparedBytes: 8, duration: 24, state: "ready", progress: 1 };
const leases: { id: string; user: number }[] = [];
it("plays an owner's local copy without a room and rejects a different account", () => {
  s.hostState(device.id);
  const lease = s.openLease(1, `device:${device.id}`, 42, 1); leases.push(lease);
  expect(lease.device).toBe(device.id);
  expect(() => s.openLease(2, `device:${device.id}`, 42, 1)).toThrow();
  h.revokeDevice(device.id, 1);
  expect(() => s.leaseFor(lease.id, 1)).toThrow();
});
it("resumes personal desktop playback while preserving an explicit restart", async () => {
  const { startDesktopPlayback, stopPlayback } = await import("./player");
  s.hostState(device.id);
  db.prepare("INSERT INTO playback_pos(user_id,anilist_id,ep,pos,dur,updated_at) VALUES(1,42,1,5,24,1)").run();
  const resumed=startDesktopPlayback(1,`device:${device.id}`,42,1);
  expect(resumed.start).toBe(5);
  await stopPlayback(resumed.sid,1);
  const restarted=startDesktopPlayback(1,`device:${device.id}`,42,1,0);
  expect(restarted.start).toBe(0);
  await stopPlayback(restarted.sid,1);
});
beforeEach(() => {
  for (const l of leases) s.closeLease(l.id, l.user); leases.length = 0;
  db.exec("DELETE FROM desktop_room_sources; DELETE FROM desktop_grants; DELETE FROM desktop_devices; DELETE FROM watch_room_members; DELETE FROM watch_rooms; DELETE FROM shared_list_members; DELETE FROM shared_lists; DELETE FROM users;");
  db.exec("INSERT INTO users(id,jellyfin_id,name,created_at) VALUES(1,'h','Host',0),(2,'v','Viewer',0),(3,'x','Outside',0); INSERT INTO shared_lists(id,name,owner_id,created_at) VALUES(1,'Room',1,0); INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(1,1,'member',0),(1,2,'member',0);");
  // Source FK points at a real room; room view itself is isolated from notifications.
  db.prepare("INSERT INTO watch_rooms(id,owner_id,anilist_id,preset,state,created_at,last_activity) VALUES('room',1,42,'host','{}',0,0)").run();
  const p = h.beginPairing("Host", "win32"); h.approveDevice(p.id, 1); device = h.deviceByToken(p.token);
  h.heartbeat(device, [file]); device = h.deviceByToken(p.token); h.setGrant(device, 1, 42, true); s.hostState(device.id); s.selectSource(1, "room", device.id);
});
function open(user = 2) { const l = s.openLease(user, "room", 42, 1); leases.push(l); return l; }
it("advertises the real relay policy independently from healthy room signaling", () => {
  const l = open(), previous = process.env.DESKTOP_RELAY_ENABLED;
  try {
    process.env.DESKTOP_RELAY_ENABLED = "0"; expect(s.viewerSignal(l.id, 2).relayEnabled).toBe(false);
    process.env.DESKTOP_RELAY_ENABLED = "1"; expect(s.viewerSignal(l.id, 2).relayEnabled).toBe(true);
  } finally { if (previous === undefined) delete process.env.DESKTOP_RELAY_ENABLED; else process.env.DESKTOP_RELAY_ENABLED = previous; }
});
it("only joined room members may open and only controllers may change source", () => {
  expect(() => open(3)).toThrow(); expect(() => s.selectSource(2, "room", null)).toThrow(); expect(open().bytes).toBe(8);
});
it("relay delivers only the requested range to its viewer", async () => {
  const l = open(), p = s.relayChunk(l, 2, 3);
  const work = s.hostState(device.id); expect(work.jobs).toHaveLength(1);
  expect(() => s.fulfill("other-device", work.jobs[0].id, new Uint8Array([2,3,4]))).toThrow();
  s.fulfill(device.id, work.jobs[0].id, new Uint8Array([2,3,4]));
  expect([...await p]).toEqual([2,3,4]); expect(l.relayBytes).toBe(3); expect(() => s.leaseFor(l.id, 1)).toThrow();
});
it("revocation invalidates direct authorization and outstanding relay work", async () => {
  const l = open(), p = s.relayChunk(l, 0, 2); const assertion = expect(p).rejects.toThrow();
  h.setGrant(device, 1, 42, false); expect(s.hostState(device.id).streams).toEqual([]); await assertion;
  expect(() => s.leaseFor(l.id, 2)).toThrow();
});
it("changed prepared version cannot reuse a lease", () => {
  const l = open(); h.heartbeat(device, [{ ...file, preparedVersion: `sha256:${"c".repeat(64)}` }]); expect(() => s.leaseFor(l.id, 2)).toThrow();
});
it("range parser handles suffix, open ranges and rejects invalid or multi-range", () => {
  expect(s.parseRange("bytes=-3", 8)).toEqual([5,7]); expect(s.parseRange("bytes=2-", 8)).toEqual([2,7]); expect(s.parseRange("bytes=0-99", 8)).toEqual([0,7]);
  for (const value of ["bytes=8-", "bytes=4-1", "bytes=0-1,3-4", "bytes=-0"]) expect(() => s.parseRange(value, 8)).toThrow();
});
it("aborted requests release relay capacity", async () => {
  const l = open(), controller = new AbortController(), p = s.relayChunk(l, 0, 2, controller.signal); const assertion = expect(p).rejects.toThrow(); controller.abort(); await assertion; expect(s.hostState(device.id).jobs).toEqual([]);
});
it("changing source closes active media leases", () => { const l = open(); s.selectSource(1, "room", null); expect(() => s.leaseFor(l.id, 2)).toThrow(); });
it("host offline and device revocation reject new access", () => { h.revokeDevice(device.id, 1); expect(() => open()).toThrow(); });
it("inventory heartbeat alone cannot advertise a compatible live transport", () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 6000);
  h.heartbeat(device, [file]);
  expect(s.sourceState(1, "room").hosts.find(x => x.id === device.id)?.online).toBe(false);
  expect(() => open()).toThrow();
  s.hostState(device.id);
  expect(s.sourceState(1, "room").hosts.find(x => x.id === device.id)?.online).toBe(true);
  expect(open().bytes).toBe(8);
});

afterEach(() => { vi.useRealTimers(); delete process.env.DESKTOP_HANDOVER_ENABLED; });
function backup(copy = file) {
  const p = h.beginPairing("Backup", "linux"); h.approveDevice(p.id, 1);
  const d = h.deviceByToken(p.token); h.heartbeat(d, [{ ...copy, id: "fedcba0987654321" }]); h.setGrant(h.deviceByToken(p.token), 1, 42, true);
  s.hostState(d.id); return d;
}
it("retargets all viewers, preserving leases and pending byte ranges; rejects old host responses", async () => {
  vi.useFakeTimers(); const a = open(), b = open(1); s.hostState(device.id); const d = backup();
  const pending = s.relayChunk(a, 2, 3); const old = s.hostState(device.id).jobs[0];
  vi.setSystemTime(Date.now() + 6000); s.hostState(d.id);
  const signal = s.viewerSignal(a.id, 2); expect(signal.generation).toBe(2); expect(signal.device).toBe(d.id);
  expect(open().device).toBe(d.id);
  expect(b.device).toBe(d.id); expect(b.generation).toBe(2); expect(s.sourceState(2, "room").selected).toBe(device.id);
  expect(() => s.hostAnswer(device.id, a.id, "v=0 old", 1)).toThrow();
  expect(() => s.fulfill(device.id, old.id, new Uint8Array([2,3,4]), undefined, 1)).toThrow();
  const work = s.hostState(d.id).jobs[0]; s.fulfill(d.id, work.id, new Uint8Array([2,3,4]), undefined, 2);
  expect([...await pending]).toEqual([2,3,4]); expect(s.leaseFor(a.id, 2).id).toBe(a.id);
  expect(() => s.viewerSignal(a.id, 2, "v=0 old", 1)).toThrow();
  s.viewerSignal(a.id, 2, "v=0 new", 2); const negotiation = s.hostState(d.id).streams.find(x => x.id === a.id)!.negotiation;
  s.hostAnswer(d.id, a.id, "v=0 answer", 2, negotiation);
  s.viewerSignal(a.id, 2, "v=0 newer", 2);
  expect(() => s.hostAnswer(d.id, a.id, "v=0 stale answer", 2, negotiation)).toThrow();
  s.hostAnswer(d.id, a.id, "v=0 answer", 2, s.hostState(d.id).streams.find(x => x.id === a.id)!.negotiation);
  expect(s.viewerSignal(a.id, 2).answer).toBe("v=0 answer");
});
it("does not switch to another encode or an ungranted copy, and recovers when the original returns", () => {
  vi.useFakeTimers(); const l = open(); s.hostState(device.id);
  const wrong = backup({ ...file, preparedVersion: `sha256:${"c".repeat(64)}` });
  const revoked = backup(); h.setGrant(revoked, 1, 42, false);
  vi.setSystemTime(Date.now() + 6000); s.hostState(wrong.id); s.hostState(revoked.id);
  expect(s.viewerSignal(l.id, 2)).toMatchObject({ device: device.id, generation: 1, recovering: true });
  s.hostState(device.id); expect(s.viewerSignal(l.id, 2).recovering).toBe(false);
});
it("ignores a stale matching backup and does not switch back merely because the preferred host returns", () => {
  vi.useFakeTimers(); const l = open(); s.hostState(device.id); const d = backup();
  vi.setSystemTime(Date.now() + 6000); expect(s.viewerSignal(l.id, 2).device).toBe(device.id);
  s.hostState(d.id); expect(s.viewerSignal(l.id, 2).device).toBe(d.id);
  s.hostState(device.id); expect(s.viewerSignal(l.id, 2)).toMatchObject({ device: d.id, generation: 2 });
});

it("handover can be disabled without closing a viewer's existing buffer lease", () => {
  vi.useFakeTimers(); const l = open(); s.hostState(device.id); const d = backup();
  vi.setSystemTime(Date.now() + 6000); s.hostState(d.id); process.env.DESKTOP_HANDOVER_ENABLED = "0";
  expect(s.viewerSignal(l.id, 2)).toMatchObject({ device: device.id, generation: 1, recovering: true });
  delete process.env.DESKTOP_HANDOVER_ENABLED;
  expect(s.viewerSignal(l.id, 2)).toMatchObject({ device: d.id, generation: 2 });
});
