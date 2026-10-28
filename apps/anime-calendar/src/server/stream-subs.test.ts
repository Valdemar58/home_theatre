import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { releaseTag, subGroup } = await import("./stream-subs");

describe("студия субтитров по пути в раздаче", () => {
  it("папка в скобках, надписи — отдельно", () => {
    expect(subGroup("Slime [BDRip]/RUS Subs/[AniLibria]/ep01.AniLibria.ass")).toEqual({ group: "AniLibria", signs: false });
    expect(subGroup("Slime [BDRip]/RUS Subs/[AniLibria]/надписи/ep01.ass")).toEqual({ group: "AniLibria", signs: true });
    expect(subGroup("Slime [BDRip]/RUS Subs/[YakuSub Studio]/ep01.ass")).toEqual({ group: "YakuSub Studio", signs: false });
  });
  it("без скобок — папка внутри раздачи, не служебная и не корень (название сериала)", () => {
    expect(subGroup("Show/Subs/Kansai/ep01.srt")).toEqual({ group: "Kansai", signs: false });
    expect(subGroup("Tensei Slime 3rd Season/Rus subs/S3 [01].ass")).toEqual({ group: null, signs: false });
    expect(subGroup("ep01.srt")).toEqual({ group: null, signs: false });
  });
  it("метка релизера — последние скобки названия", () => {
    expect(releaseTag("Slime 3 [TV] E24 of 24 [RUS(int), JAP] [2024, WEBRip] [HWP]")).toBe("HWP");
    expect(releaseTag("Slime без меток")).toBeNull();
  });
});
