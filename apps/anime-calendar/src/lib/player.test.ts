import { describe, expect, it } from "vitest";
import { chapterLabel, piecesToRanges, srtToVtt, deviceProfile, pickAudio, pickSub, rememberedSub, subChoiceOf, trackLabel, videoTrackOf, type PlaySub, type PlayTrack } from "./player";

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

  it("запомненные субтитры: та же дорожка, потом источник и язык, дорожка без языка не теряется", () => {
    const lab = (x: PlaySub, label: string, extra: Partial<PlaySub> = {}) => ({ ...x, label, ...extra });
    const subs = [lab(s(5, "eng"), "Английский"), lab(s(6, "rus"), "Русский · Crunchyroll"), lab(s(7, "rus"), "Русский · Полные"),
      lab(s(200_001, null), "Rus Subs", { torrent: true }), lab(s(100_000, "jpn"), "Японский · Jimaku", { jimaku: true })];
    // Вторая русская дорожка — она же, а не первая русская
    expect(rememberedSub(subs, subChoiceOf(subs[2]), 6)).toBe(7);
    // Дорожка из раздачи без языка — раньше запоминалась как «выключены»
    expect(rememberedSub(subs, subChoiceOf(subs[3]), 6)).toBe(200_001);
    expect(rememberedSub(subs, subChoiceOf(subs[4]), 6)).toBe(100_000);
    expect(rememberedSub(subs, { off: true }, 6)).toBeNull();
    // В другой серии названия другие: тот же источник и язык, иначе язык, иначе — предложение сервера
    expect(rememberedSub(subs, { from: "file", lang: "rus", label: "Русский · другая" }, 5)).toBe(6);
    expect(rememberedSub(subs, { from: "external", lang: "eng", label: "x" }, 6)).toBe(5);
    expect(rememberedSub(subs, { from: "file", lang: "fre", label: "x" }, 6)).toBe(6);
    expect(rememberedSub(subs, null, 6)).toBe(6);
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

describe("главы по-русски", () => {
  it("обычные названия глав и неизвестные — как есть", () => {
    expect(["Intro", "OP", "Part A", "Part B", "ED", "Next Episode", "Chapter 03", "Eyecatch", "Avant", "Something"].map(chapterLabel))
      .toEqual(["Вступление", "Опенинг", "Часть A", "Часть B", "Эндинг", "Анонс", "Глава 3", "Перебивка", "Вступление", "Something"]);
    expect(["A part", "B-Part", "Aパート", "C part", "Yokoku"].map(chapterLabel)).toEqual(["Часть A", "Часть B", "Часть A", "После титров", "Анонс"]);
  });
});

describe("скачанное TorrServer", () => {
  it("куски файла → доли, подряд идущие слиты, чужие файлы отброшены", () => {
    // Файл — байты 100..500 раздачи, куски по 100: 0 (до файла), 1–2 подряд, 4 (последний)
    expect(piecesToRanges([4, 0, 1, 2], 100, 100, 400)).toEqual([[0, 0.5], [0.75, 1]]);
    expect(piecesToRanges([], 100, 0, 400)).toEqual([]);
  });
});

describe("SRT → WebVTT", () => {
  it("заголовок, точки в миллисекундах, без номеров реплик", () => {
    const srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\n（ヴェルドラ）\r\n\r\n2\r\n00:01:02,000 --> 00:01:04,250\r\n♪〜\r\n";
    expect(srtToVtt(srt)).toBe("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\n（ヴェルドラ）\n\n00:01:02.000 --> 00:01:04.250\n♪〜\n");
  });
});

describe("videoTrackOf", () => {
  // Коробка MP4: размер, тип, содержимое
  const box = (type: string, ...parts: Uint8Array[]) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, "ascii");
    return new Uint8Array(Buffer.concat([head, body]));
  };
  const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return new Uint8Array(b); };
  const trak = (id: number, handler: string, timescale: number) => box("trak",
    box("tkhd", u32(0, 0, 0, id)),
    box("mdia", box("mdhd", u32(0, 0, 0, timescale)), box("hdlr", u32(0, 0), new Uint8Array(Buffer.from(handler)))));

  it("видеодорожка — номер и единица времени, звук пропускается", () => {
    const init = Buffer.concat([box("ftyp", u32(0)), box("moov", box("mvhd", u32(0)), trak(2, "soun", 48000), trak(1, "vide", 16000))]);
    expect(videoTrackOf(init.buffer.slice(init.byteOffset, init.byteOffset + init.byteLength))).toEqual({ trackId: 1, timescale: 16000 });
  });
  it("нет видео или не MP4 — null", () => {
    const audio = Buffer.concat([box("moov", trak(1, "soun", 48000))]);
    expect(videoTrackOf(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength))).toBeNull();
    expect(videoTrackOf(new ArrayBuffer(3))).toBeNull();
  });
});
