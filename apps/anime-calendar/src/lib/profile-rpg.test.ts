import { describe, expect, it } from "vitest";
import { badgeXp, levelOf, rankOf, rpgStats } from "./profile-rpg";
import type { ListEntryWithMedia, MediaLite } from "./types";

const media = (id: number, p: Partial<MediaLite>): MediaLite => ({
  id, idMal: null, format: "TV", status: "FINISHED", episodes: 12, duration: 24, season: "FALL", seasonYear: 2020,
  countryOfOrigin: "JP", source: null, isAdult: false, averageScore: 75, malScore: null, popularity: 1000, genres: ["Action"],
  title: { romaji: `T${id}`, english: null, native: null, ru: null }, coverImage: { large: null, color: null }, bannerImage: null,
  studios: [], startDate: { year: 2020, month: 1, day: 1 }, endDate: { year: 2020, month: 3, day: 1 }, nextAiringEpisode: null, ...p,
});
const entry = (id: number, p: Partial<ListEntryWithMedia>, m: Partial<MediaLite> = {}): ListEntryWithMedia => ({
  anilistId: id, malId: null, status: "completed", waiting: false, episodes: 12, score: 0, updatedAt: 0, note: null, tags: [],
  voice: null, recommend: null, airedMark: null, private: false, media: media(id, m), ...p,
});

describe("уровень", () => {
  it("кривая опыта", () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(50).level).toBe(2);
    expect(levelOf(5600).level).toBe(20);
  });
  it("опыт наград суммируется по уровням", () => expect(badgeXp([1, 4, 0])).toBe(20 + (20 + 50 + 120 + 300)));
  it("ранги", () => {
    expect(rankOf(3)).toBe("Новичок");
    expect(rankOf(19)).toBe("Опытный зритель");
    expect(rankOf(63)).toBe("Легенда");
  });
});

describe("rpgStats", () => {
  const list = [
    entry(1, { score: 9 }, { genres: ["Fantasy", "Adventure"], episodes: 64, popularity: 5000 }),
    entry(2, { score: 8 }, { genres: ["Fantasy"], seasonYear: 1998, popularity: 400000 }),
    entry(3, { score: 5 }, { genres: ["Romance"] }),
    entry(4, { status: "dropped", episodes: 2 }, { genres: ["Sports"] }),
  ];
  const s = rpgStats(list, { friends: 1, comments: 0, together: 0 }, Date.UTC(2026, 9, 13) / 1000);
  it("класс — по главному жанру, второй — подкласс", () => {
    expect(s.klass?.name).toBe("Маг");
    expect(s.klass?.second).toBe("Adventure");
  });
  it("оценки и рекорды", () => {
    expect(s.scores.hist[8]).toBe(1);
    expect(s.scores.mean).toBe(7.3);
    expect(s.records.find((r) => r.kind === "longest")?.value).toBe("64 серий");
    expect(s.records.find((r) => r.kind === "oldest")?.value).toBe("1998 год");
  });
  it("упорство = досмотрено / (досмотрено + брошено)", () => expect(s.attributes.find((a) => a.key === "grit")?.value).toBe(75));
  it("зал славы — от 8", () => expect(s.hall.map((h) => h.id)).toEqual([1, 2]));
  it("жемчужина — только малоизвестное", () => expect(s.records.find((r) => r.kind === "gem")?.id).toBe(1));
});
