import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../cache", () => ({ cached: (_key: string, _ttl: unknown, load: () => unknown) => load() }));
vi.mock("../env", () => ({ env: { prowlarrUrl: "http://indexer", prowlarrApiKey: "fixture", ruIndexerTag: "ru" } }));
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../http", () => ({ fetchWithRetry: mocks.fetch, expectOk: async (r: Response) => { if (!r.ok) throw Error("upstream"); }, RateLimiter: class {} }));
const { searchRu } = await import("./arr");
let fail: number[];
let searches: URL[];
beforeEach(() => {
  fail = []; searches = [];
  mocks.fetch.mockImplementation(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname.endsWith("/tag")) return Response.json([{ id: 7, label: "ru" }]);
    if (url.pathname.endsWith("/indexer")) return Response.json([
      { id: 1, name: "Renamed public tracker", definitionName: "rutor", enable: true, tags: [7] },
      { id: 2, name: "Other Russian tracker", definitionName: "rutracker-ru", enable: true, tags: [7] },
      { id: 3, name: "Disabled", definitionName: "rutor", enable: false, tags: [7] },
    ]);
    searches.push(url);
    const id = Number(url.searchParams.get("indexerIds"));
    if (fail.includes(id)) throw Error("unavailable");
    const matched = id === 2 || url.searchParams.getAll("categories").includes("8000");
    return Response.json(matched ? [{ guid: `release-${id}`, title: "О моём перерождении в слизь", indexerId: id }] : []);
  });
});
it("finds RuTor anime in Other without broadening unrelated trackers or losing the Russian query", async () => {
  const rows = await searchRu("О моём перерождении в слизь");
  expect(rows).toHaveLength(2);
  expect(searches).toHaveLength(2);
  for (const url of searches) {
    expect(url.searchParams.get("query")).toBe("О моём перерождении в слизь");
    const id = url.searchParams.get("indexerIds");
    expect(url.searchParams.getAll("categories")).toEqual(id === "1" ? ["5000", "5070", "8000"] : ["5000", "5070"]);
    expect(url.searchParams.getAll("indexerIds")).not.toContain("3");
  }
});
it("keeps available Russian results on partial failure, but propagates a total failure", async () => {
  fail = [2];
  expect(await searchRu("Название")).toHaveLength(1);
  fail = [1, 2];
  await expect(searchRu("Название")).rejects.toThrow("unavailable");
});
