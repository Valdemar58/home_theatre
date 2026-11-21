import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("./maintenance", () => ({ maintenanceActive: () => false, maintenanceProgressAllowed: () => false, MAINTENANCE_MESSAGE: "maintenance" }));
const { proxy } = await import("../proxy");
const { GET } = await import("../app/api/desktop/info/route");
it("publishes a public non-cacheable compatibility contract without account state", async () => {
  const response = GET(), body = await response.json();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toEqual({ service: "home_theater", desktopProtocol: 2, name: "Пивосинема", desktop: { manifestVersion: 1, protocol: { min: 2, max: 2 }, capabilities: ["accounts-v1", "device-binding-v1", "desktop-commands-v1", "host-transport-v2"], requiredClientCapabilities: ["accounts-v1", "device-binding-v1", "desktop-commands-v1", "host-transport-v2"] } });
});
it("rejects incompatible desktop APIs before login, binding and commands; ordinary web and protocol 2 keep working", () => {
  for (const pathname of ["/api/auth/login", "/api/auth/register", "/api/desktop/binding", "/api/desktop/commands", "/api/rooms/abc"]) {
    for (const protocol of ["", "1", "3", "2.0", "invalid"])
      expect(proxy(new NextRequest("https://test.example" + pathname, { method: "POST", headers: { "X-Desktop-Protocol": protocol } })).status).toBe(426);
    for (const headers of [new Headers(), new Headers({ "X-Desktop-Protocol": "2" })])
      expect(proxy(new NextRequest("https://test.example" + pathname, { method: "POST", headers })).status).toBe(200);
  }
  expect(proxy(new NextRequest("https://test.example/api/desktop/info", { headers: { "X-Desktop-Protocol": "3" } })).status).toBe(200);
});
