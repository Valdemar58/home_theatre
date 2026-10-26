import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfiles, scoreTitle } from "./profiles";

// Настоящий profiles.toml из корня home_theater
const real = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "profiles.toml"), "utf-8");

describe("profiles.toml", () => {
  const p = parseProfiles(real);

  it("разбирает обе секции", () => {
    expect(p.general.length).toBeGreaterThanOrEqual(4);
    expect(p.anime.find((r) => r.name === "Studio AniLibria")?.score).toBeGreaterThan(0);
  });

  it("правило без regex в [[anime]] берёт regex из [[general]]", () => {
    expect(p.anime.find((r) => r.name === "RU audio")?.regex).toBeInstanceOf(RegExp);
  });

  it("баллы как у Sonarr для названия от RU-индексатора", () => {
    const { matched } = scoreTitle("X S03 [WEBRip 1080p] [RUS(int), JAP] MVO, AniLibria RUS", p.anime);
    expect(matched).toEqual(expect.arrayContaining(["RU audio embedded", "JP audio", "Studio AniLibria", "RU audio"]));
  });
});
