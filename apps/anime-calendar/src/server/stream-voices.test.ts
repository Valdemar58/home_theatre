import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const STREAM = fs.mkdtempSync(path.join(os.tmpdir(), "stream-"));
process.env.STREAM_DIR = STREAM;
const { placeVoiceSlots, voicesForVideo } = await import("./stream-voices");

const R = "[Moozzi2] Slime [BDRip HEVC FLAC]";
const ep = (n: string) => `[Moozzi2] Slime - ${n} [BDRip 1920x1080 HEVC FLAC]`;
const files = [
  { id: 1, path: `${R}/NC/[Moozzi2] Slime NCOP - 01 (BD).mkv`, length: 1 },
  { id: 5, path: `${R}/RUS Sound/[AniLibria]/${ep("01")}.mka`, length: 34e6 },
  { id: 6, path: `${R}/RUS Sound/[AniLibria]/${ep("02")}.mka`, length: 34e6 },
  { id: 7, path: `${R}/RUS Sound/[Dream.Cast]/${ep("01")}.mka`, length: 30e6 },
  { id: 8, path: `${R}/ENG Sound/${ep("01")}.mka`, length: 20e6 },
  { id: 183, path: `${R}/${ep("01")}.mkv`, length: 1e9 },
  { id: 184, path: `${R}/${ep("02")}.mkv`, length: 1e9 },
];

describe("озвучки раздачи к видео серии", () => {
  it("по имени видео: студия — папка, точки в названии убраны, язык по папке", () => {
    expect(voicesForVideo(files, 183)).toEqual([
      { group: "AniLibria", lang: "ru", id: 5, size: 34e6, ext: ".mka" },
      { group: "Dream Cast", lang: "ru", id: 7, size: 30e6, ext: ".mka" },
      { group: "ENG Sound", lang: "en", id: 8, size: 20e6, ext: ".mka" },
    ]);
    expect(voicesForVideo(files, 184).map((v) => v.id)).toEqual([6]);
  });
  it("звук назван иначе, чем видео, — по номеру серии", () => {
    const other = [
      { id: 1, path: "Show/Show - 01.mkv", length: 1 },
      { id: 2, path: "Show/Show - 02.mkv", length: 1 },
      { id: 3, path: "Show/Rus Sound/[Kansai]/01.mka", length: 5 },
      { id: 4, path: "Show/Rus Sound/[Kansai]/02.mka", length: 5 },
    ];
    expect(voicesForVideo(other, 2).map((v) => [v.group, v.id])).toEqual([["Kansai", 4]]);
    expect(voicesForVideo(other, 99)).toEqual([]);
  });
});

describe("ссылки на озвучки рядом с .strm", () => {
  it("на каждую студию серии — относительная ссылка в .voices/<хэш>, повторно не создаётся", () => {
    const season = path.join(STREAM, "Slime (2018) [tvdbid-1]", "Season 01");
    fs.mkdirSync(season, { recursive: true });
    const strm = path.join(season, "Slime - S01E01.strm");
    fs.writeFileSync(strm, "http://x");
    const hash = "a".repeat(40);
    placeVoiceSlots(files, hash, [{ strm, index: 183 }]);
    placeVoiceSlots(files, hash, [{ strm, index: 183 }]);
    expect(fs.readdirSync(season).sort()).toEqual([
      "Slime - S01E01.en.ENG Sound.mka", "Slime - S01E01.ru.AniLibria.mka", "Slime - S01E01.ru.Dream Cast.mka", "Slime - S01E01.strm",
    ]);
    expect(fs.readlinkSync(path.join(season, "Slime - S01E01.ru.AniLibria.mka"))).toBe(path.join("..", "..", ".voices", hash, "5.mka"));
    expect(fs.existsSync(path.join(STREAM, ".voices", ".ignore"))).toBe(true);
  });
});
