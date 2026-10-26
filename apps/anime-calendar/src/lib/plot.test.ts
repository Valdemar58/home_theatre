import { describe, expect, it } from "vitest";
import { episodeDigest, fillEpisodes, isGenericEpisodeTitle, isStubDescription, seasonEpisodes, type RawEpisode } from "./plot";

const raw = (number: number, title: string | null, overview: string | null): RawEpisode => ({ number, title, overview, airDate: null, still: null });

describe("сюжет", () => {
  it("заглушки описаний", () => {
    expect(isStubDescription("Третий сезон аниме Аватар короля.")).toBe(true);
    expect(isStubDescription(null)).toBe(true);
    expect(isStubDescription("Дэндзи — юный охотник на демонов. ".repeat(6))).toBe(false);
  });

  it("пустые названия серий", () => {
    expect(isGenericEpisodeTitle("Эпизод 5")).toBe(true);
    expect(isGenericEpisodeTitle("Episode 12")).toBe(true);
    expect(isGenericEpisodeTitle("Пёс и бензопила")).toBe(false);
  });

  it("вторая часть сезона: сдвиг и число серий, английское — где нет русского", () => {
    const ru = Array.from({ length: 24 }, (_, i) => raw(i + 1, i === 13 ? "Эпизод 14" : `Серия-${i + 1}`, i === 14 ? null : `ру ${i + 1}`));
    const en = Array.from({ length: 24 }, (_, i) => raw(i + 1, `Ep-${i + 1}`, `en ${i + 1}`));
    const eps = seasonEpisodes(ru, en, 12, 12);
    expect(eps).toHaveLength(12);
    expect(eps[0]).toMatchObject({ number: 1, title: "Серия-13", overview: "ру 13", lang: "ru" });
    expect(eps[1]).toMatchObject({ number: 2, title: "Ep-14" });
    expect(eps[2]).toMatchObject({ number: 3, overview: "en 15", lang: "en" });
  });

  it("запасной источник дополняет пустое", () => {
    const base = seasonEpisodes([raw(1, null, null), raw(2, "Б", "есть")], [], 0, null);
    const kitsu = seasonEpisodes([raw(1, "A", "kitsu 1"), raw(2, "B", "kitsu 2")], [], 0, null).map((e) => ({ ...e, lang: "en" as const }));
    const eps = fillEpisodes(base, kitsu);
    expect(eps[0]).toMatchObject({ title: "A", overview: "kitsu 1", lang: "en" });
    expect(eps[1]).toMatchObject({ title: "Б", overview: "есть", lang: "ru" });
  });

  it("выжимка серий укладывается в бюджет", () => {
    const eps = seasonEpisodes(Array.from({ length: 30 }, (_, i) => raw(i + 1, null, "x".repeat(400))), [], 0, null);
    const d = episodeDigest(eps, 1000);
    expect(d.length).toBeLessThanOrEqual(1000);
    expect(d.split("\n")[0]).toMatch(/^1\. x+…$/);
  });
});
