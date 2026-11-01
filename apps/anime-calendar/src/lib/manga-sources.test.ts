import { describe, expect, it } from "vitest";
import { bridgeUrl, mapSources, repositoryUrl, searchNames, sourceLanguage } from "./manga-sources";

describe("manga source discovery", () => {
  it("keeps translated titles and native aliases without duplicate requests", () => {
    expect(searchNames(["Berserk", " berserk ", "Берсерк", "ベルセルク", "ベルセルク"])).toEqual(["Berserk", "Берсерк", "ベルセルク"]);
    expect(searchNames(["Berserk"], "  別名 ")).toEqual(["別名"]);
    expect(sourceLanguage("jp")).toBe("ja");
    expect(sourceLanguage("all")).toBe("multi");
  });
  it("bounds concurrency and isolates a broken source", async () => {
    let active = 0, peak = 0;
    const result = await mapSources([1, 2, 3, 4, 5], async (i) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (i === 2) throw new Error("offline");
      return i;
    }, 2);
    expect(peak).toBe(2);
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  });
  it("accepts Tachimanga protobuf repositories and rejects credential URLs", () => {
    expect(repositoryUrl("https://github.com/keiyoushi/extensions/raw/repo/index.pb")).toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(repositoryUrl("https://github.com/keiyoushi/extensions")).toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(() => repositoryUrl("file:///tmp/repo")).toThrow();
    expect(() => bridgeUrl("http://user:password@host")).toThrow();
    expect(bridgeUrl("http://suwayomi:4567/")).toBe("http://suwayomi:4567");
  });
});
