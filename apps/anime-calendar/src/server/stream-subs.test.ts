import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { subGroup } = await import("./stream-subs");

describe("студия субтитров по пути в раздаче", () => {
  it("папка в скобках, надписи — отдельно", () => {
    expect(subGroup("Slime [BDRip]/RUS Subs/[AniLibria]/ep01.AniLibria.ass")).toEqual({ group: "AniLibria", signs: false });
    expect(subGroup("Slime [BDRip]/RUS Subs/[AniLibria]/надписи/ep01.ass")).toEqual({ group: "AniLibria", signs: true });
    expect(subGroup("Slime [BDRip]/RUS Subs/[YakuSub Studio]/ep01.ass")).toEqual({ group: "YakuSub Studio", signs: false });
  });
  it("без скобок — ближайшая папка, не служебная", () => {
    expect(subGroup("Show/Subs/Kansai/ep01.srt")).toEqual({ group: "Kansai", signs: false });
    expect(subGroup("ep01.srt")).toEqual({ group: "Субтитры", signs: false });
  });
});
