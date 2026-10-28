import { describe, expect, it } from "vitest";
import { deviceProfile, pickAudio, pickSub, trackLabel, type PlaySub, type PlayTrack } from "./player";

const t = (index: number, lang: string | null, title: string | null = null): PlayTrack => ({ index, lang, title, codec: "aac", label: "" });
const s = (index: number, lang: string | null, title: string | null = null, forced = false): PlaySub =>
  ({ ...t(index, lang, title), url: "", ass: true, forced, signs: forced || /надпис/i.test(title ?? ""), external: false });

describe("дорожки по умолчанию", () => {
  const audio = [t(1, "jpn"), t(2, "rus", "AniLibria"), t(3, "rus", "Dream Cast")];

  it("озвучка: студия из списка, иначе первая русская, без русской — первая", () => {
    expect(pickAudio(audio, "dream cast")).toBe(3);
    expect(pickAudio(audio, null)).toBe(2);
    expect(pickAudio([t(1, "jpn"), t(4, "eng")], null)).toBe(1);
    expect(pickAudio([], null)).toBeNull();
  });

  it("субтитры: с русской озвучкой — только надписи, с японской — русские полные", () => {
    const subs = [s(5, "eng"), s(6, "rus", "Надписи"), s(7, "rus", "Полные")];
    expect(pickSub(subs, audio[1])).toBe(6);
    expect(pickSub([s(5, "eng"), s(7, "rus")], audio[1])).toBeNull();
    expect(pickSub(subs, audio[0])).toBe(7);
    expect(pickSub([s(5, "eng")], audio[0])).toBe(5);
  });

  it("подпись дорожки по-русски, название без повтора языка", () => {
    expect(trackLabel("rus", "AniLibria", "aac")).toBe("Русский · AniLibria");
    expect(trackLabel("jpn", null, "flac")).toBe("Японский · FLAC");
    expect(trackLabel("rus", "Русский", "ac3")).toBe("Русский · AC3");
  });
});

describe("профиль устройства", () => {
  it("HEVC — только если браузер умеет; звук перекодируется в AAC", () => {
    const p = deviceProfile({ hevc: false, av1: false, maxBitrate: 8e6 });
    expect(p.TranscodingProfiles[0]).toMatchObject({ VideoCodec: "h264", AudioCodec: "aac", Protocol: "hls" });
    expect(deviceProfile({ hevc: true, av1: false, maxBitrate: 8e6 }).TranscodingProfiles[0].VideoCodec).toBe("h264,hevc");
  });
});
