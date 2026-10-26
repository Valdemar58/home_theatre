import { describe, expect, it } from "vitest";
import { assignEpisodes, localEpisode, refFromTitle } from "./episode";

describe("localEpisode", () => {
  it.each([
    ["Tensei shitara Slime Datta Ken 3rd Season/Tensei shitara Slime Datta Ken S3 [01].avi", 1],
    ["[AniLibria] Sousou no Frieren - 05 [1080p].mkv", 5],
    ["[SubsPlease] Tensei Shitara Slime Datta Ken - 49 (1080p) [03747270].mkv", 49],
    ["Shingeki.no.Kyojin.S03E07.1080p.BDRip.mkv", 7],
    ["Mushoku_Tensei_Ep12_[1080p].mkv", 12],
    ["Re Zero 2nd Season [13v2] [BDRip 1080p].mkv", 13],
    ["07.mkv", 7],
    ["One Piece [1156] [RUS].mkv", 1156],
    ["Title [2024] [1080p] [05].mkv", 5],
  ])("%s → %d", (name, n) => {
    expect(localEpisode(name)).toBe(n);
  });

  it("без номера", () => {
    expect(localEpisode("Title [1080p] [AniLibria].mkv")).toBeNull();
  });
});

describe("refFromTitle", () => {
  it("наши форматы", () => {
    expect(refFromTitle("That Time I Got Reincarnated as a Slime S03 [WEBRip 1080p] [RUS(int), JAP] MVO, AniLibria RUS"))
      .toEqual({ kind: "season", season: 3, from: 1, to: 0, full: true });
    expect(refFromTitle("That Time I Got Reincarnated as a Slime S02E13-24 [BluRay 1080p] RUS"))
      .toEqual({ kind: "season", season: 2, from: 13, to: 24, full: false });
    expect(refFromTitle("One Piece - 1156-1180 [WEB-DL 1080p] RUS")).toEqual({ kind: "absolute", from: 1156, to: 1180 });
  });
});

describe("assignEpisodes", () => {
  it("вторая часть сезона с нумерацией файлов с 01", () => {
    expect(assignEpisodes([1, 2, 12], { kind: "season", season: 2, from: 13, to: 24, full: false }))
      .toEqual([{ season: 2, episode: 13 }, { season: 2, episode: 14 }, { season: 2, episode: 24 }]);
  });
  it("файлы уже пронумерованы как в TVDB", () => {
    expect(assignEpisodes([13, 24], { kind: "season", season: 2, from: 13, to: 24, full: false }))
      .toEqual([{ season: 2, episode: 13 }, { season: 2, episode: 24 }]);
  });
  it("весь сезон", () => {
    expect(assignEpisodes([1, null, 24], { kind: "season", season: 3, from: 1, to: 0, full: true }))
      .toEqual([{ season: 3, episode: 1 }, null, { season: 3, episode: 24 }]);
  });
});
