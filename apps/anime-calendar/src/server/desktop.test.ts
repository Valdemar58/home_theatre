import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "desktop-"));
const { db } = await import("./db");
const h = await import("./desktop");
beforeEach(() => {
  db.exec(
    "DELETE FROM desktop_grants; DELETE FROM desktop_devices; DELETE FROM shared_list_members; DELETE FROM shared_lists; DELETE FROM users;",
  );
  db.prepare(
    "INSERT INTO users (id,jellyfin_id,name,created_at) VALUES (1,'host','Host',0),(2,'friend','Friend',0),(3,'stranger','Stranger',0)",
  ).run();
  db.prepare(
    "INSERT INTO shared_lists (id,name,owner_id,created_at) VALUES (1,'Room',2,0)",
  ).run();
  db.prepare(
    "INSERT INTO shared_list_members (list_id,user_id,status,joined_at) VALUES (1,1,'member',0),(1,2,'member',0)",
  ).run();
});
const file = {
  id: "1234567890abcdef",
  title: 42,
  ep: 1,
  version: `sha256:${"a".repeat(64)}`,
  bytes: 100,
  state: "ready",
  progress: 1,
};
function paired() {
  const p = h.beginPairing("My PC", "linux");
  h.approveDevice(p.id, 1);
  return { p, d: h.deviceByToken(p.token) };
}
it("requires approval, expires pending tokens and never exposes bearer secrets", () => {
  const p = h.beginPairing("PC", "win32");
  expect(() => h.deviceByToken(p.token)).toThrow();
  expect(h.deviceByToken(p.token, true).user_id).toBeNull();
  h.approveDevice(p.id, 1);
  expect(() => h.approveDevice(p.id, 2)).toThrow();
  expect(h.deviceByToken(p.token).user_id).toBe(1);
  expect(JSON.stringify(h.ownDevices(1))).not.toContain(p.token);
  const q = h.beginPairing("Expired", "linux");
  db.prepare("UPDATE desktop_devices SET expires_at=0 WHERE id=?").run(q.id);
  expect(() => h.deviceByToken(q.token, true)).toThrow();
});
it("publishes only granted titles, strips paths and rechecks room membership", () => {
  const { p, d } = paired();
  h.heartbeat(d, [{ ...file, path: "C:/secret/file.mkv" }]);
  expect(h.roomHosts(1, 2)[0].files).toEqual([]);
  h.setGrant(h.deviceByToken(p.token), 1, 42, true);
  expect(h.roomHosts(1, 2)[0].files).toEqual([file]);
  expect(() => h.roomHosts(1, 3)).toThrow();
  db.prepare("DELETE FROM shared_list_members WHERE user_id=1").run();
  expect(h.roomHosts(1, 2)).toEqual([]);
  expect(() => h.setGrant(h.deviceByToken(p.token), 1, 42, true)).toThrow();
});
it("revocation by another user does nothing; owner revocation invalidates credentials", () => {
  const { p } = paired();
  h.revokeDevice(p.id, 2);
  expect(h.deviceByToken(p.token).user_id).toBe(1);
  h.revokeDevice(p.id, 1);
  expect(() => h.deviceByToken(p.token)).toThrow();
  expect(h.roomHosts(1, 2)).toEqual([]);
});
it("stale heartbeat means offline and a grant can be revoked", () => {
  const { p, d } = paired();
  h.heartbeat(d, [file]);
  h.setGrant(h.deviceByToken(p.token), 1, 42, true);
  expect(h.roomHosts(1, 2)[0].online).toBe(true);
  db.prepare("UPDATE desktop_devices SET last_seen=1 WHERE id=?").run(p.id);
  expect(h.roomHosts(1, 2)[0].online).toBe(false);
  h.setGrant(h.deviceByToken(p.token), 1, 42, false);
  expect(h.roomHosts(1, 2)[0].files).toEqual([]);
});
it("rejects invalid inventory and blocked accounts", () => {
  const { p } = paired();
  expect(() => h.inventoryInput([{ ...file, progress: NaN }])).toThrow();
  expect(() => h.inventoryInput([file, file])).toThrow();
  db.prepare("UPDATE users SET blocked=1 WHERE id=1").run();
  expect(() => h.deviceByToken(p.token)).toThrow();
});

it("rejects incompatible desktop protocols with an actionable update error", () => {
  for (const version of [null, "1", "3"]) {
    const req = new Request("http://localhost/api/desktop/transport", { headers: version ? { "X-Desktop-Protocol": version } : {} });
    expect(() => h.requireDesktopProtocol(req)).toThrow(/Обновите desktop/);
  }
  expect(() => h.requireDesktopProtocol(new Request("http://localhost", { headers: { "X-Desktop-Protocol": "2" } }))).not.toThrow();
});

it("one installation retains identity across retries, revocation and account transfer",()=>{
 const key="c".repeat(64), a=h.installationBinding(1,key,"PC","win32","link");
 expect(a.token).toBeTruthy();
 expect(h.installationBinding(1,key,"PC","win32","link",a.token)).toMatchObject({id:a.id,status:"linked",alreadyLinked:true});
 expect(db.prepare("SELECT id FROM desktop_devices").all()).toHaveLength(1);
 expect(h.installationBinding(2,key,"PC","win32","status").status).toBe("other-account");
 expect(()=>h.installationBinding(2,key,"PC","win32","link")).toThrow(/отвяжите/);
 h.heartbeat(h.deviceByToken(a.token!),[file]);
 h.setGrant(h.deviceByToken(a.token!),1,42,true);
 h.installationBinding(2,key,"PC","win32","unlink");
 expect(()=>h.deviceByToken(a.token!)).toThrow();
 const b=h.installationBinding(2,key,"PC","win32","link");
 expect(b.id).toBe(a.id);expect(h.deviceByToken(b.token!).user_id).toBe(2);expect(h.grantsFor(b.id!)).toEqual([]);
 expect(db.prepare("SELECT id FROM desktop_devices").all()).toHaveLength(1);
 h.revokeDevice(b.id!,2);expect(h.installationBinding(2,key,"PC","win32","status").status).toBe("unlinked");
});
it("adopts an existing desktop token without creating another device",()=>{
 const {p}=paired();expect(h.installationBinding(1,"d".repeat(64),"PC","linux","link",p.token).id).toBe(p.id);
 expect(db.prepare("SELECT id FROM desktop_devices").all()).toHaveLength(1);
});
