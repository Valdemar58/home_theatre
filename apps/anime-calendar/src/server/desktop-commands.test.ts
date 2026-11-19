import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "desktop-commands-"));
const { db } = await import("./db");
const h = await import("./desktop");
const q = await import("./desktop-commands");
let device: string;
beforeEach(() => {
  db.exec("DELETE FROM desktop_devices; DELETE FROM users;");
  db.exec("INSERT INTO users(id,jellyfin_id,name,created_at) VALUES(1,'one','One',0),(2,'two','Two',0)");
  const p = h.beginPairing("Home", "win32"); h.approveDevice(p.id, 1); device = p.id;
});
it("keeps an offline command in SQL until acknowledged by its device", () => {
  const c = q.enqueue(1, device, "inspect", { magnet: "fixture", episodes: [1, 3] });
  expect(h.ownDevices(1)[0].online).toBe(false);
  expect(q.pendingCommands(device)[0].id).toBe(c.id);
  q.finishCommand("another-device", c.id, { job: "wrong" });
  expect(q.pendingCommands(device)).toHaveLength(1);
  q.finishCommand(device, c.id, { job: "correct" });
  q.finishCommand(device, c.id, { job: "duplicate" });
  expect(q.pendingCommands(device)).toHaveLength(0);
  expect(q.deviceDownloads(1, device).commands[0].result).toEqual({ job: "correct" });
});
it("prevents another account or revoked device from reading or queueing actions", () => {
  expect(() => q.enqueue(2, device, "pause", {})).toThrow();
  expect(() => q.deviceDownloads(2, device)).toThrow();
  h.revokeDevice(device, 1);
  expect(() => q.enqueue(1, device, "pause", {})).toThrow();
});
it("limits pending commands and retains last reported progress", () => {
  for (let i = 0; i < 30; i++) q.enqueue(1, device, "pause", {});
  expect(() => q.enqueue(1, device, "pause", {})).toThrow(/30/);
  q.reportDownloads(device, [{ id: "job", state: "preparing" }]);
  expect(q.deviceDownloads(1, device).jobs[0].state).toBe("preparing");
});
it("accepts storage and library from a new host while keeping old snapshots readable",()=>{
  const storage={at:1,volumes:[{id:"disk",total:1000,free:500,mediaBytes:100,titles:[]}]};
  q.reportDownloads(device,[{id:"job",title:42,state:"ready"}],{storage,library:[{id:"file",title:42,ep:1}],capabilities:["episode-delete-v1"]});
  expect(q.deviceDownloads(1,device)).toMatchObject({storage,library:[{id:"file"}],capabilities:["episode-delete-v1"]});
  q.reportDownloads(device,[]);
  expect(q.deviceDownloads(1,device)).toMatchObject({jobs:[],storage:null,library:[],capabilities:[]});
});
