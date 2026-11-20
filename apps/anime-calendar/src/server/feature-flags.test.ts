import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { FeatureFlagRuntime } = await import("./feature-flags");
const folders: string[] = [];
const clients: InstanceType<typeof FeatureFlagRuntime>[] = [];
const servers: Server[] = [];
const folder = () => { const dir = mkdtempSync(path.join(tmpdir(), "flags-")); folders.push(dir); return dir; };
const client = (options: ConstructorParameters<typeof FeatureFlagRuntime>[0]) => {
  const c = new FeatureFlagRuntime(options); clients.push(c); return c;
};
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("Flag synchronization timed out");
};
const flag = (name: string, enabled = true) => ({ name, enabled, strategies: [{ name: "default", parameters: {} }] });

afterEach(async () => {
  clients.splice(0).forEach((c) => c.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  folders.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  delete process.env.FEATURE_FLAGS_FORCE_OFF;
});

describe("operational AI flags", () => {
  it("keeps existing AI available without the optional service; local off is immediate", () => {
    const c = client({ directory: folder() });
    expect(c.allowed("personal")).toBe(true);
    writeFileSync(c.overridesFile, JSON.stringify({ version: 1, disabled: ["ai-personal"] }));
    expect(c.allowed("personal")).toBe(false);
    expect(c.allowed("shared")).toBe(true);
    process.env.FEATURE_FLAGS_FORCE_OFF = "ai-enabled";
    expect(c.allowed("shared")).toBe(false);
  });

  it("fails closed on damaged overrides and incomplete managed configuration", () => {
    const directory = folder();
    const c = client({ directory, url: "http://127.0.0.1:1/api" });
    expect(c.allowed("shared")).toBe(false);
    writeFileSync(c.overridesFile, "{");
    expect(c.status().localOverrideValid).toBe(false);
    expect(c.allowed("media")).toBe(false);
  });

  it("updates live, survives restart offline, separates token scope and retains deletion", async () => {
    let features = [flag("ai-enabled"), flag("ai-shared"), flag("ai-personal", false)];
    let offline = false;
    const server = createServer((req, res) => {
      if (offline) { res.writeHead(503).end(); return; }
      expect(req.headers.authorization).toBe("backend-test-token");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ version: 2, features }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const options = { directory: folder(), url: `http://127.0.0.1:${address.port}/api`,
      token: "backend-test-token", environment: "production", refreshInterval: 40 };
    const live = client(options);
    await until(() => live.allowed("shared"));
    expect(live.allowed("personal")).toBe(false);
    await until(() => readdirSync(options.directory).some((name) => name.endsWith(".json")));
    offline = true;
    live.destroy(); clients.splice(clients.indexOf(live), 1);
    const cached = client(options);
    await until(() => cached.status().ready);
    expect(cached.allowed("shared")).toBe(true);
    expect(cached.status().cacheLoaded).toBe(true);
    const other = client({ ...options, token: "another-scope", url: "http://127.0.0.1:1/api" });
    expect(other.allowed("shared")).toBe(false);
    offline = false;
    features = [];
    await until(() => !cached.allowed("shared"));
    const file = readdirSync(options.directory).find((name) => name.startsWith("snapshot-"))!;
    await until(() => JSON.parse(readFileSync(path.join(options.directory, file), "utf8")).data.features.length === 0);
    offline = true;
    cached.destroy(); clients.splice(clients.indexOf(cached), 1);
    const empty = client(options);
    await until(() => empty.status().ready);
    expect(empty.allowed("shared")).toBe(false);
    expect(empty.status().cacheLoaded).toBe(true);
  }, 15000);
});
