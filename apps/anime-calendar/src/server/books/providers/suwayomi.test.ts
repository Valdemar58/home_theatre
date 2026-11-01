import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetails } from "@/lib/books";

vi.mock("server-only", () => ({}));
vi.mock("../../sources", () => ({ guarded: (_source: string, fn: () => unknown) => fn() }));
const { state, remember } = vi.hoisted(() => ({ state: vi.fn(), remember: vi.fn() }));
vi.mock("../source-state", () => ({ sourceState: state, rememberSource: remember }));
vi.mock("../provider-config", () => ({ providerConfig: () => ({ suwayomi: { url: "http://suwayomi:4567", sources: ["ru", "en", "ja"], languages: ["ru", "en", "ja"] } }) }));
import { suwayomi } from "./suwayomi";

const book = { id: 30002, title: { romaji: "Berserk", english: "Berserk", ru: "Берсерк", native: "ベルセルク" }, synonyms: ["Berserk"] } as BookDetails;
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

beforeEach(() => { state.mockClear(); remember.mockClear(); });
describe("Suwayomi adapter", () => {
  it("keeps healthy language sources when another extension fails and records the failure", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      if (query.includes("__type")) return response({ __type: { fields: [{ name: "addExtensionStore" }] } });
      if (query.includes("sources {")) return response({ sources: { nodes: ["ru", "en", "ja"].map((id) => ({ id, name: id, displayName: id, lang: id })) } });
      if (variables.input.source === "ru") return { ok: true, json: async () => ({ errors: [{ message: "WebView required" }] }) };
      return response({ fetchSourceManga: { mangas: [{ id: variables.input.source === "en" ? 13 : 2, title: "Berserk", thumbnailUrl: null, realUrl: null }] } });
    });
    vi.stubGlobal("fetch", fetcher);
    const hits = await suwayomi.search(book);
    expect(hits.map((h) => h.lang).sort()).toEqual(["en", "ja"]);
    expect(state).toHaveBeenCalledWith(30002, expect.objectContaining({ sourceId: "ru", status: "error", message: expect.stringContaining("WebView") }));
    expect(remember).toHaveBeenCalledWith("suwayomi", "13", "en");
    const queries = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(queries.some((q) => q.variables?.input?.query === "ベルセルク")).toBe(true);
    expect(queries.every((q) => !q.query.includes("isNsfw"))).toBe(true);
  });

  it("uses modern chapter API and preserves negative and special chapters", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      expect(query).toContain("fetchMangaAndChapters");
      return response({ fetchMangaAndChapters: { manga: { source: { id: "en", lang: "en", displayName: "Weeb Central" } }, chapters: [
        { id: 1, name: "Chapter -16", chapterNumber: -16, scanlator: null, uploadDate: "0" },
        { id: 2, name: "Extra", chapterNumber: -1, scanlator: null, uploadDate: "0" },
      ] } });
    }));
    const chapters = await suwayomi.chapters("13", "main");
    expect(chapters[0]).toMatchObject({ num: -16, numText: "-16", lang: "en" });
    expect(chapters[1]).toMatchObject({ num: null, numText: "Extra" });
  });
});
