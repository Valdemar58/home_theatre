import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeName, parseRelease, seasonFromName } from "./parse";

const p = (t: string) => {
  const r = parseRelease(t);
  if (!r) throw new Error(`не разобрано: ${t}`);
  return r;
};

describe("parseRelease: реальные названия RuTracker", () => {
  it("сезон в скобках, нормализованные серии, встроенная озвучка", () => {
    const r = p("О моём перерождении в слизь (S4, часть 1) / Tensei shitara Slime Datta Ken 4th Season / That Time I Got Reincarnated as a Slime 4th Season / TenSura [TV] E24 of 24 [RUS(int), JAP] [2026, фэнтези, WEB-DL] [1080p] [Локализованный видеоряд]");
    expect(r.names).toEqual(["О моём перерождении в слизь", "Tensei shitara Slime Datta Ken 4th Season", "That Time I Got Reincarnated as a Slime 4th Season", "TenSura"]);
    expect(r).toMatchObject({ season: 4, part: 1, kind: "TV", episodes: { from: 1, to: 24 }, total: 24, complete: true });
    expect(r.audio).toEqual({ rus: "int", langs: ["RUS", "JAP"], kinds: [] });
    expect(r).toMatchObject({ year: 2026, source: "WEB-DL", resolution: "1080p" });
  });

  it("TV+Special со спешлами и внешней озвучкой", () => {
    const r = p("О моём перерождении в слизь (S3) / Tensei shitara Slime Datta Ken 3rd Season / That Time I Got Reincarnated as a Slime 3rd Season / TenSura [TV+Special] E24+2 of 24+2 [RUS(ext), JAP] [2024, приключения, комедия, фэнтези, BDRip] [1080p]");
    expect(r).toMatchObject({ season: 3, kind: "TV", episodes: { from: 1, to: 24 }, total: 24, complete: true, source: "BDRip" });
    expect(r.audio.rus).toBe("ext");
  });

  it("часть сезона: Dai 2 Bu / Part 2", () => {
    const r = p("О моём перерождении в слизь (S2, часть 2) / Tensei shitara Slime Datta Ken 2nd Season Dai 2 Bu / That Time I Got Reincarnated as a Slime 2nd Season Part 2 / TenSura [TV+Special] E12+1 of 12+1 [RUS(ext), JAP] [2021, приключения, комедия, фэнтези, BDRip] [1080p]");
    expect(r).toMatchObject({ season: 2, part: 2, episodes: { from: 1, to: 12 }, total: 12 });
  });

  it("незаконченная раздача онгоинга в формате [01-11 из 14]", () => {
    const r = p("Реинкарнация безработного: История о приключениях в другом мире (S3, часть 1) / Mushoku Tensei III: Isekai Ittara Honki Dasu [TV] [01-11 из 14] [RUS(int), JAP] [2026, приключения, комедия, фэнтези, этти, WEB-DL] [1080p]");
    expect(r).toMatchObject({ season: 3, part: 1, episodes: { from: 1, to: 11 }, total: 14, complete: false });
  });

  it("длинный сериал со сквозной нумерацией", () => {
    const r = p("Большой Куш / One Piece / Ван-Пис [TV] [1156-1180 из 1000+] [RUS(ext), JAP] [1999, приключения, комедия, фэнтези, сёнэн, WEB-DL] [1080p]");
    expect(r).toMatchObject({ season: null, episodes: { from: 1156, to: 1180 }, total: null, complete: false });
    expect(r.names).toContain("One Piece");
  });

  it("ТВ-N, тип перевода и [N из N]", () => {
    const r = p("Re:Zero - жизнь с нуля в другом мире (ТВ-3) / Re:Zero kara Hajimeru Isekai Seikatsu 3 / Re: Zero - Starting Life in Another World 3rd Season / С нуля: пособие по выживанию в альтернативном мире 3 [TV] [16 из 16] [RUS(Dub)] [2024, фэнтези, WEB-DL] [1080p]");
    expect(r).toMatchObject({ season: 3, episodes: { from: 1, to: 16 }, complete: true });
    expect(r.audio).toMatchObject({ rus: "yes", kinds: ["Dub"] });
  });

  it("студия озвучки в конце названия", () => {
    const r = p("Атака Титанов (S3) / Shingeki no Kyojin Season 3 / Attack on Titan 3rd Season [TV] E22 of 22 [2018, 2019, приключения, триллер, фантастика, BDRip 1080p, 60 FPS] AniLibria");
    expect(r).toMatchObject({ season: 3, source: "BDRip", resolution: "1080p" });
    expect(r.voices).toEqual(["AniLibria"]);
    expect(r.audio.rus).toBe("yes");
  });

  it("серии с разной озвучкой: берём покрытие русской дорожки", () => {
    const r = p("Фрирен, провожающая в последний путь (S2) / Sousou no Frieren 2nd Season / Frieren: Beyond Journey's End Season 2 [TV+Special] E10+11 of 10+11 [JAP] & E10+0 of 10+11 [RUS(ext)] [2026, приключения, драма, фэнтези, BDRip] [1080p]");
    expect(r).toMatchObject({ season: 2, episodes: { from: 1, to: 10 }, total: 10 });
    expect(r.audio.rus).toBe("ext");
  });

  it("[24+0 из 24+2]: 24 серии из 24 (спешлы отдельно)", () => {
    const r = p("О моём перерождении в слизь (ТВ-3) / Tensei Shitara Slime Datta Ken 3 [TV+Special] [24+2 из 24+2] [JAP+Sub] & [24+0 из 24+2] [RUS(ext)] [2024, приключения, WEB-DL] [1080p]");
    expect(r).toMatchObject({ season: 3, episodes: { from: 1, to: 24 }, total: 24, complete: true });
    expect(r.audio.rus).toBe("ext");
  });

  it("фильм с HDR", () => {
    const r = p("Атака Титанов: Последняя атака / Shingeki no Kyojin: The Last Attack / Attack on Titan - The Last Attack [Movie] [RUS(int), KAZ, UZB, ENG, JAP] [2024, приключения, фэнтези, драма, BDRemux, HDR10, Dolby Vision] [2160p]");
    expect(r).toMatchObject({ kind: "Movie", complete: true, source: "BDRemux", resolution: "2160p", hdr: true });
  });

  it("не видео: OST, книги, игры", () => {
    expect(parseRelease("(OST) [CD / WEB] Ван Пис / One Piece - 1999-2026, FLAC (tracks), lossless [100 CD]")).toBeNull();
    expect(parseRelease("[Nintendo Switch] One Piece Pirate Warriors 4 + 25 DLC [NSZ][ENG]")).toBeNull();
    expect(parseRelease("[английский] NAGATSUKI Tappei - Re:Zero / Re:Zero kara Hajimeru Isekai Seikatsu [тома 1-29] [2014, EPUB, ENG]")).toBeNull();
  });
});

describe("seasonFromName", () => {
  it.each([
    ["Tensei shitara Slime Datta Ken 3rd Season", 3, null],
    ["Frieren: Beyond Journey's End Season 2", 2, null],
    ["Mushoku Tensei III: Isekai Ittara Honki Dasu", 3, null],
    ["Re:Zero kara Hajimeru Isekai Seikatsu 4", 4, null],
    ["Tensei shitara Slime Datta Ken 2nd Season Dai 2 Bu", 2, 2],
    ["Sorcery Fight: The Culling Game Part 1", null, 1],
    ["Sousou no Frieren", null, null],
  ])("%s", (name, season, part) => {
    expect(seasonFromName(name)).toEqual({ season, part });
  });
});

describe("normalizeName", () => {
  it("регистр, пунктуация, ё", () => {
    expect(normalizeName("Frieren: Beyond Journey's End")).toBe("frieren beyond journeys end");
    expect(normalizeName("Ёлки-палки")).toBe("елки палки");
  });
});

describe("корпус реальных названий", () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "rutracker-titles.json"), "utf-8")) as {
    title: string; categories: number[];
  }[];
  // Аниме-раздачи с полным заголовком (часть названий Prowlarr обрезает, их добираем со страницы темы)
  const anime = corpus.filter((r) => r.categories.includes(5070) && r.title.includes(" / ") && /\[(TV|Movie|OVA|ONA|Special)/.test(r.title));

  it("разбирается почти всё аниме", () => {
    const parsed = anime.map((r) => parseRelease(r.title));
    const ok = parsed.filter((x) => x && x.names.length >= 2).length;
    expect(ok / anime.length).toBeGreaterThan(0.95);
  });

  it("у сериалов почти всегда находятся серии", () => {
    const tv = anime.map((r) => parseRelease(r.title)).filter((x) => x?.kind === "TV");
    const withEpisodes = tv.filter((x) => x!.episodes).length;
    expect(withEpisodes / tv.length).toBeGreaterThan(0.9);
  });
});
