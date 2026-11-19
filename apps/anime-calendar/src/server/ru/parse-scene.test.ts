import { describe, expect, it } from "vitest";
import { parseScene } from "./parse-scene";

describe("parseScene", () => {
  it("еженедельная серия SubsPlease", () => {
    const r = parseScene("[SubsPlease] Tensei Shitara Slime Datta Ken S3 - 05 (1080p) [A1B2C3D4].mkv")!;
    expect(r).toMatchObject({ group: "SubsPlease", season: 3, episodes: { from: 5, to: 5 }, resolution: "1080p", complete: false });
    expect(r.names).toContain("Tensei Shitara Slime Datta Ken");
    expect(r.subs).toEqual(["ENG"]);
    expect(r.audio.langs).toEqual(["JAP"]);
  });

  it("пачка серий Erai-raws с мультисабом — русские есть", () => {
    const r = parseScene("[Erai-raws] Kusuriya no Hitorigoto 2nd Season - 01 ~ 12 [1080p CR WEB-DL AVC AAC][MultiSub][ENG][POR-BR][RUS]")!;
    expect(r).toMatchObject({ group: "Erai-raws", season: 2, episodes: { from: 1, to: 12 }, source: "WEB-DL" });
    expect(r.names[0]).toBe("Kusuriya no Hitorigoto 2nd Season");
    expect(r.subs).toEqual(expect.arrayContaining(["MULTI", "ENG", "RUS"]));
  });

  it("BD-рип без номеров серий", () => {
    const r = parseScene("[Moozzi2] Tensei Shitara Slime Datta Ken [BDRip HEVC FLAC]")!;
    expect(r).toMatchObject({ group: "Moozzi2", source: "BDRip", episodes: null, season: null });
    expect(r.names).toEqual(["Tensei Shitara Slime Datta Ken"]);
  });

  it("сценовое имя с сезоном, двумя дорожками и группой в конце", () => {
    const r = parseScene("Frieren Beyond Journey's End S01 1080p BluRay x265 Dual Audio [Group]")!;
    expect(r).toMatchObject({ season: 1, resolution: "1080p", source: "BDRip", group: null });
    expect(r.audio.langs).toEqual(["JAP", "ENG"]);
    expect(r.names).toContain("Frieren Beyond Journey's End");
  });

  it("S01E05 и пачка Batch", () => {
    expect(parseScene("Dandadan S02E05 1080p WEB-DL AAC")).toMatchObject({ season: 2, episodes: { from: 5, to: 5 } });
    expect(parseScene("[Judas] Vinland Saga (Season 2) [1080p][HEVC x265 10bit][Multi-Subs] (Batch)")).toMatchObject({ season: 2, complete: true });
  });

  it("сезон в скобках с добавками, спецвыпуски и OVA", () => {
    expect(parseScene("[EMBER] That Time I Got Reincarnated as a Slime (2024) (Season 3 + Special) [1080p] [Dual Audio HEVC WEBRip]")).toMatchObject({ season: 3 });
    expect(parseScene("[EMBER] That Time I Got Reincarnated as a Slime (2021) (Season 2 Part 02 + Special) [BDRip 1080p]")).toMatchObject({ season: 2, part: 2 });
    expect(parseScene("[Mehul] That Time I Got Reincarnated as a Slime S00E10-E12 (Visions of Coleus OVA 2023) (BD 1080p)")).toMatchObject({ season: 0 });
    expect(parseScene("[Erai-raws] Tensei shitara Slime Datta Ken - 01 ~ 05 (OAD) [1080p][BATCH]")).toMatchObject({ kind: "OVA" });
    // Пачка «S01+OADs» — это сериал с добавками, не OVA
    expect(parseScene("[Trix] Tensei Shitara Slime Datta Ken - S01+02+OADs+Tensura Nikki [Dual Audio] (BD 1080p AV1)")?.kind).not.toBe("OVA");
  });

  it("музыка и манга — не видео", () => {
    expect(parseScene("[Hi-Res] Tensei Shitara Slime Datta Ken OST [FLAC 24bit]")).toBeNull();
    expect(parseScene("Tensei Shitara Slime Datta Ken Manga Vol 1-20")).toBeNull();
  });
});
