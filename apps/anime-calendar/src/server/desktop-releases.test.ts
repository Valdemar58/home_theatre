import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ ru: vi.fn(), orig: vi.fn() }));
vi.mock("./ru/arr", () => ({ searchRu: mocks.ru, searchOrig: mocks.orig }));
vi.mock("./env", () => ({ env: { prowlarrUrl: "http://indexer:9696", prowlarrApiKey: "test-indexer-key" } }));
const { desktopReleases, desktopTorrent } = await import("./desktop-releases");
const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&tr=https%3A%2F%2Ftracker.example%2Fannounce&xs=http%3A%2F%2Flocalhost%2Fsecret`;
it("includes magnet-only releases, validates hashes and removes metadata/web-seed URLs", async () => {
  mocks.ru.mockResolvedValue([{ guid: "magnet", title: "Magnet", magnetUrl: magnet }]);
  const result = await desktopReleases("magnet-device", "Title");
  const fetch = vi.spyOn(globalThis, "fetch");
  const descriptor = await desktopTorrent("magnet-device", result.releases[0].id);
  expect(descriptor).toHaveProperty("magnet");
  expect(JSON.stringify(descriptor)).not.toContain("localhost");
  expect(fetch).not.toHaveBeenCalled();
  mocks.ru.mockResolvedValue([{ guid: "bad-magnet", title: "Bad", magnetUrl: "magnet:?dn=NoHash" }]);
  const bad = await desktopReleases("magnet-device", "Title");
  await expect(desktopTorrent("magnet-device", bad.releases[0].id)).rejects.toThrow(/info-hash/);
});
it("accepts an indexer redirect to magnet without fetching the redirect", async () => {
  const result = await desktopReleases("redirect", "Title");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: magnet } }));
  expect(await desktopTorrent("redirect", result.releases[0].id)).toHaveProperty("magnet");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
});
beforeEach(() => { vi.restoreAllMocks(); mocks.ru.mockResolvedValue([{ guid: "release", title: "Title 01", size: 123, seeders: 4, downloadUrl: "http://indexer:9696/download?apikey=secret", indexer: "test" }]); mocks.orig.mockResolvedValue([]); });
it("does not disclose tracker credentials and binds selection to the device", async () => {
  const result = await desktopReleases("device-a", "Title");
  expect(JSON.stringify(result)).not.toContain("secret");
  await expect(desktopTorrent("device-b", result.releases[0].id)).rejects.toThrow(/устарел/);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("torrent"));
  expect(await desktopTorrent("device-a", result.releases[0].id)).toEqual({ torrent: Buffer.from("torrent").toString("base64"), title: "Title 01" });
});
it("partial indexer failure remains usable; total failure is actionable", async () => {
  mocks.orig.mockRejectedValue(new Error("secret upstream url"));
  expect((await desktopReleases("partial", "Title")).warning).toBeTruthy();
  mocks.ru.mockRejectedValue(new Error("upstream"));
  await expect(desktopReleases("partial", "Title")).rejects.toThrow(/Индексаторы недоступны/);
});
it("rejects a download URL outside the configured indexer and expired handles", async () => {
  mocks.ru.mockResolvedValue([{ guid: "evil", title: "x", downloadUrl: "http://localhost/secret" }]);
  const result = await desktopReleases("a", "Title");
  await expect(desktopTorrent("a", result.releases[0].id)).rejects.toThrow(/серверную ссылку/);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  await expect(desktopTorrent("a", result.releases[0].id)).rejects.toThrow(/устарел/);
});
