import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filtersToParams, matchesAiring, matchesMedia, parseFilters, rating } from "./filters";
import { airingKind, dayKey, fetchRange, finaleOf, groupByDay, monthGrid, weekDays } from "./schedule";
import type { MediaLite } from "./types";

function media(over: Partial<MediaLite> = {}): MediaLite {
  return {
    id: 1, idMal: 1, format: "TV", status: "RELEASING", episodes: 12, duration: 24, season: "FALL",
    seasonYear: 2026, countryOfOrigin: "JP", source: "MANGA", isAdult: false, averageScore: 80, malScore: null,
    popularity: 1000, genres: ["Action"],
    title: { romaji: "Test", english: null, native: null, ru: "Тест" },
    coverImage: { large: null, color: null }, bannerImage: null, studios: [],
    startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: null, month: null, day: null },
    nextAiringEpisode: null,
    ...over,
  };
}

describe("airingKind", () => {
  it("финал — серия с номером, равным числу серий", () => {
    expect(airingKind({ episode: 12 }, { episodes: 12 })).toBe("finale");
    expect(airingKind({ episode: 11 }, { episodes: 12 })).toBe("episode");
  });
  it("без числа серий финала нет", () => {
    expect(airingKind({ episode: 12 }, { episodes: null })).toBe("episode");
  });
  it("первая серия — премьера, но односерийник считается финалом", () => {
    expect(airingKind({ episode: 1 }, { episodes: 12 })).toBe("premiere");
    expect(airingKind({ episode: 1 }, { episodes: 1 })).toBe("finale");
  });
  it("сериал на 2 кура в одной записи: финал на 24-й", () => {
    expect(airingKind({ episode: 12 }, { episodes: 24 })).toBe("episode");
    expect(airingKind({ episode: 24 }, { episodes: 24 })).toBe("finale");
  });
});

describe("dayKey", () => {
  // 2026-10-03 23:30 JST = 2026-10-03 14:30 UTC = 17:30 MSK → тот же день
  // 2026-10-04 01:30 JST = 2026-10-03 16:30 UTC → по Москве ещё 3-е
  const lateNightJst = Date.UTC(2026, 9, 3, 16, 30) / 1000;
  it("серия, вышедшая ночью по Японии, по Москве попадает на предыдущий день", () => {
    expect(dayKey(lateNightJst, "Asia/Tokyo")).toBe("2026-10-04");
    expect(dayKey(lateNightJst, "Europe/Moscow")).toBe("2026-10-03");
  });
});

describe("monthGrid", () => {
  it("октябрь 2026: начинается с понедельника 28 сентября, 5 недель (или 6 с full)", () => {
    expect(monthGrid(2026, 9)).toHaveLength(35);
    expect(monthGrid(2026, 9).at(-1)?.key).toBe("2026-11-01");
    // Февраль 2027 начинается в понедельник — ровно 4 недели
    expect(monthGrid(2027, 1)).toHaveLength(28);
    const grid = monthGrid(2026, 9, true);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ key: "2026-09-28", day: 28, inMonth: false });
    expect(grid[3]).toEqual({ key: "2026-10-01", day: 1, inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
  });
  it("weekDays возвращает пн–вс недели", () => {
    const week = weekDays("2026-10-02"); // пятница
    expect(week[0].key).toBe("2026-09-28");
    expect(week[6].key).toBe("2026-10-04");
  });
  it("fetchRange берёт запас в сутки с обеих сторон", () => {
    const r = fetchRange("2026-09-28", "2026-11-08");
    expect(new Date(r.from * 1000).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(new Date(r.to * 1000).toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});

describe("finaleOf", () => {
  const schedule = [1, 2, 3].map((e) => ({ episode: e, airingAt: 1000 * e }));
  it("точный финал", () => {
    expect(finaleOf(media({ episodes: 3 }), schedule)).toEqual({ airingAt: 3000, episode: 3, tentative: false });
  });
  it("число серий неизвестно — последняя известная серия, предварительно", () => {
    expect(finaleOf(media({ episodes: null }), schedule)).toEqual({ airingAt: 3000, episode: 3, tentative: true });
  });
  it("перенос: финал берётся из расписания, а не из даты окончания", () => {
    const moved = [{ episode: 1, airingAt: 1 }, { episode: 2, airingAt: 999 }];
    expect(finaleOf(media({ episodes: 2 }), moved)?.airingAt).toBe(999);
  });
  it("вышедший фильм без расписания — нет финала", () => {
    expect(finaleOf(media({ format: "MOVIE", status: "FINISHED", episodes: 1 }), [])).toBeNull();
  });
});

describe("groupByDay", () => {
  it("финалы идут первыми", () => {
    const a = media({ id: 1, popularity: 10, episodes: 12 });
    const b = media({ id: 2, popularity: 9999, episodes: 24 });
    const t = Date.UTC(2026, 9, 3, 12) / 1000;
    const days = groupByDay(
      [{ mediaId: 2, episode: 5, airingAt: t }, { mediaId: 1, episode: 12, airingAt: t }],
      { 1: a, 2: b },
      "Europe/Moscow",
    );
    expect(days.get("2026-10-03")!.map((d) => d.kind)).toEqual(["finale", "episode"]);
  });
});

describe("filters", () => {
  it("URL туда и обратно", () => {
    const f = { ...DEFAULT_FILTERS, mode: "all" as const, formats: ["TV", "ONA"], genresEx: ["Ecchi"], minScore: 70, list: "waiting" as const };
    expect(parseFilters(filtersToParams(f))).toEqual(f);
  });
  it("режим финалов, жанры, 18+, списки", () => {
    const m = media({ genres: ["Action", "Ecchi"] });
    expect(matchesAiring("episode", m, DEFAULT_FILTERS)).toBe(false);
    expect(matchesAiring("finale", m, DEFAULT_FILTERS)).toBe(true);
    expect(matchesAiring("finale", m, { ...DEFAULT_FILTERS, genresEx: ["Ecchi"] })).toBe(false);
    expect(matchesAiring("finale", media({ isAdult: true }), DEFAULT_FILTERS)).toBe(false);
    expect(matchesAiring("finale", m, { ...DEFAULT_FILTERS, list: "mine" })).toBe(false);
    expect(matchesAiring("finale", m, { ...DEFAULT_FILTERS, list: "waiting" }, { status: "planned", waiting: true })).toBe(true);
    expect(matchesAiring("finale", m, { ...DEFAULT_FILTERS, q: "тест" })).toBe(true);
  });
});

describe("оценка", () => {
  it("берётся MAL, а без неё — AniList", () => {
    expect(rating(media({ malScore: 8.71, averageScore: 80 }))).toBe(8.71);
    expect(rating(media({ malScore: null, averageScore: 80 }))).toBe(8);
    expect(rating(media({ malScore: null, averageScore: null }))).toBe(0);
  });
  it("фильтр «Оценка от» смотрит на MAL", () => {
    const f = { ...DEFAULT_FILTERS, minScore: 85 };
    expect(matchesMedia(media({ malScore: 8.6, averageScore: 80 }), f)).toBe(true);
    expect(matchesMedia(media({ malScore: 8.4, averageScore: 90 }), f)).toBe(false);
    expect(matchesMedia(media({ malScore: null, averageScore: 86 }), f)).toBe(true);
  });
});
