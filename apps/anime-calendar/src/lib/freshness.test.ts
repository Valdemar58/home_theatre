import { describe, expect, it } from "vitest";
import { cacheClassOf, endedAt, freshFor, keepAfterExpiry } from "./freshness";

const NOW = Math.floor(Date.UTC(2026, 9, 28) / 1000);
const D = 86400;

describe("freshFor", () => {
  it("онгоинг: серии — 6 ч, остальное — сутки", () => {
    expect(freshFor({ status: "RELEASING" }, "airing", NOW)).toBe(6 * 3600);
    expect(freshFor({ status: "RELEASING" }, "info", NOW)).toBe(D);
  });
  it("анонс — сутки", () => {
    expect(freshFor({ status: "NOT_YET_RELEASED" }, "info", NOW)).toBe(D);
  });
  it("закончился недавно — неделя, давно — 90 дней", () => {
    expect(freshFor({ status: "FINISHED", finaleAt: NOW - 30 * D }, "info", NOW)).toBe(7 * D);
    expect(freshFor({ status: "FINISHED", endDate: { year: 2015, month: 3, day: 1 } }, "airing", NOW)).toBe(90 * D);
    expect(freshFor({ status: "CANCELLED", endDate: { year: 2020, month: null, day: null } }, "info", NOW)).toBe(90 * D);
  });
  it("закончился, дата неизвестна — 30 дней", () => {
    expect(freshFor({ status: "FINISHED" }, "info", NOW)).toBe(30 * D);
  });
  it("неизвестный статус — сутки", () => {
    expect(freshFor({ status: null }, "info", NOW)).toBe(D);
  });
});

describe("endedAt", () => {
  it("финал из расписания важнее даты", () => {
    expect(endedAt({ status: "FINISHED", finaleAt: 123, endDate: { year: 2020, month: 1, day: 1 } })).toBe(123);
  });
  it("неполная дата — конец месяца/года", () => {
    expect(endedAt({ status: "FINISHED", endDate: { year: 2020, month: null, day: null } })).toBe(Date.UTC(2020, 11, 28) / 1000);
  });
});

describe("cacheClassOf", () => {
  it("тайтлы, персонажи, серии — навсегда", () => {
    for (const k of ["media:v2:1", "title-chars:v2:5", "character:v1:9", "shiki-desc:3", "tmdb-season:v2:1:1:ru", "plot-eps:v3:1", "airing:123"]) {
      expect(cacheClassOf(k)).toBe("entity");
    }
  });
  it("выдачи каталога и поиска", () => {
    for (const k of ["browse:{}", "shiki-search:20:1:x", "genres", "atlas-popular:v2:1", "similar:v6:1"]) expect(cacheClassOf(k)).toBe("listing");
  });
  it("состояние сервисов", () => {
    expect(cacheClassOf("ru:sonarr-series")).toBe("volatile");
    expect(cacheClassOf("seerr-users")).toBe("volatile");
  });
  it("сколько держать после срока", () => {
    expect(keepAfterExpiry("entity")).toBeNull();
    expect(keepAfterExpiry("listing")).toBe(30 * D);
    expect(keepAfterExpiry("volatile")).toBe(D);
  });
});
