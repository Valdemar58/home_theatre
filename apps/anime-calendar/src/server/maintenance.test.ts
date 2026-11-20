import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("./notifications", () => ({ notify: vi.fn() }));
vi.mock("./social", () => ({ areFriends: () => true, friendIds: () => [] }));
vi.mock("./lists", () => ({ getMedia: () => ({status:"FINISHED",episodes:12,schedule:[],title:{romaji:"Test"}}) }));
process.env.DATABASE_DRIVER = process.env.POSTGRES_TEST === "1" ? "postgres" : "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "maintenance-test-"));
const { db } = await import("./db");
const { maintenance, maintenanceActive, maintenancePath, beginMaintenanceWork } = await import("./maintenance");
const { createRoom, roomView, roomCommand } = await import("./rooms");
const { maintenanceTick } = await import("./maintenance-loop");
const { startMaintenanceHttpTracking } = await import("./maintenance-http");
const { proxy } = await import("../proxy");
const owner = { id: 1, name: "owner" };
const plan = () => ({ id: "a".repeat(24), label: "0123456789ab", startsAt: Date.now() - 1000, endsAt: Date.now() + 60000 });
beforeEach(() => {
  unlinkSyncSafe();
  db.exec("DELETE FROM watch_rooms; DELETE FROM shared_lists; DELETE FROM users;");
  db.prepare("INSERT INTO users (id,jellyfin_id,name,created_at) VALUES (1,'maintenance-owner','owner',0)").run();
});
function unlinkSyncSafe() { try { unlinkSync(maintenancePath()); } catch {} }
afterEach(unlinkSyncSafe);
it("does not enter maintenance before its server deadline and fails closed on a broken file", () => {
  expect(maintenance()).toBeNull();
  writeFileSync(maintenancePath(), JSON.stringify({ ...plan(), startsAt: Date.now() + 30000 }));
  expect(maintenanceActive()).toBe(false);
  writeFileSync(maintenancePath(), "broken");
  expect(maintenanceActive()).toBe(true);
});
it("pauses and persists rooms once, and does not acknowledge readiness while work is running", () => {
  const room = createRoom(owner, 10, 1, [], 30, true);
  writeFileSync(maintenancePath(), JSON.stringify({ ...plan(), startsAt: Date.now() - 15000 }));
  const finish = beginMaintenanceWork("fixture");
  try {
    maintenanceTick();
    const saved = roomView(1, room.id).state;
    expect(saved.playing).toBe(false);
    expect(saved.pos).toBeGreaterThanOrEqual(30);
    expect(saved.hold).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "maintenance-ack.json"), "utf8")).ready).toBe(false);
    expect(() => roomCommand(owner, room.id, { action: "play", pos: 35 })).toThrow(/Обслуживание/);
    expect(() => createRoom(owner, 10, 2, [])).toThrow(/Обслуживание/);
  } finally { finish(); }
  maintenanceTick();
  expect(JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "maintenance-ack.json"), "utf8")).ready).toBe(true);
  unlinkSyncSafe();
  expect(roomView(1, room.id).state.playing).toBe(false);
  roomCommand(owner, room.id, { action: "play", pos: 35 });
  expect(roomView(1, room.id).state.playing).toBe(true);
});
it("blocks new API work including desktop routes, retains health and rewrites full-page loads", () => {
  writeFileSync(maintenancePath(), JSON.stringify(plan()));
  for (const pathname of ["/api/play", "/api/desktop/commands", "/api/auth/register", "/api/calendar"]) {
    const response = proxy(new NextRequest("https://test.example" + pathname, { method: "POST" }));
    expect(response.status).toBe(503);
  }
  expect(proxy(new NextRequest("https://test.example/api/health/database")).status).toBe(200);
  expect(proxy(new NextRequest("https://test.example/api/maintenance")).status).toBe(200);
  expect(proxy(new NextRequest("https://test.example/api/play/abc123", { method: "POST" })).status).toBe(200);
  writeFileSync(maintenancePath(), JSON.stringify({ ...plan(), startsAt: Date.now() - 15000 }));
  expect(proxy(new NextRequest("https://test.example/api/play/abc123", { method: "POST" })).status).toBe(503);
  const page = proxy(new NextRequest("https://test.example/calendar"));
  expect(page.status).toBe(503);
  expect(page.headers.get("x-middleware-rewrite")).toBe("https://test.example/maintenance");
});
it("waits for an already admitted HTTP write outside the cookie-auth wrapper", async () => {
  const stop = startMaintenanceHttpTracking();
  let received!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_req, res) => { received(); void gate.then(() => res.end("ok")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const pending = fetch(`http://127.0.0.1:${address.port}/api/desktop/commands`, { method: "POST", body: "fixture" });
    await started;
    writeFileSync(maintenancePath(), JSON.stringify({ ...plan(), startsAt: Date.now() - 15000 }));
    maintenanceTick();
    expect(JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "maintenance-ack.json"), "utf8")).ready).toBe(false);
    release();
    await (await pending).text();
    maintenanceTick();
    expect(JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "maintenance-ack.json"), "utf8")).ready).toBe(true);
  } finally {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    stop();
  }
});
