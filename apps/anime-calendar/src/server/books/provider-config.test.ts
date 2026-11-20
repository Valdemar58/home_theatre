import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ row: undefined as { value: string } | undefined }));
vi.mock("../db", () => ({ db: { prepare: () => ({ get: () => fixture.row }) }, now: () => 0 }));
import { providerConfig } from "./provider-config";
afterEach(() => { fixture.row = undefined; vi.unstubAllEnvs(); });
it("explicitly absent Suwayomi stays absent instead of reverting to a Docker hostname", () => {
  vi.stubEnv("SUWAYOMI_URL", "");
  expect(providerConfig().suwayomi.url).toBe("");
});
it("existing explicitly configured bridges keep their endpoint", () => {
  vi.stubEnv("SUWAYOMI_URL", "");
  fixture.row = { value: JSON.stringify({ suwayomi: { url: "http://bridge.example:4567" } }) };
  expect(providerConfig().suwayomi.url).toBe("http://bridge.example:4567");
});
it("legacy installations without an explicit module setting keep the previous default", () => {
  vi.stubEnv("SUWAYOMI_URL", undefined);
  expect(providerConfig().suwayomi.url).toBe("http://suwayomi:4567");
});
