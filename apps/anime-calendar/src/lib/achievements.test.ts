import { describe as group, expect, it } from "vitest";
import { ACHIEVEMENTS, achievementDef, describe, progressToNext, seasonEvent, seasonOf, tierOf } from "./achievements";

group("tierOf", () => {
  it("уровни по порогам", () => {
    expect(tierOf(0, [10, 25, 60, 150])).toBe(0);
    expect(tierOf(10, [10, 25, 60, 150])).toBe(1);
    expect(tierOf(59, [10, 25, 60, 150])).toBe(2);
    expect(tierOf(500, [10, 25, 60, 150])).toBe(4);
  });
});

group("progressToNext", () => {
  it("доля пути от текущего порога к следующему", () => expect(progressToNext(40, [10, 25, 60, 150])).toEqual({ next: 60, ratio: (40 - 25) / 35 }));
  it("на платине — всё", () => expect(progressToNext(200, [10, 25, 60, 150])).toEqual({ next: null, ratio: 1 }));
});

group("ACHIEVEMENTS", () => {
  it("пороги строго растут, id уникальны", () => {
    for (const a of ACHIEVEMENTS) expect([...a.thresholds].sort((x, y) => x - y)).toEqual(a.thresholds);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });
  it("описание с порогом и склонением", () => {
    expect(describe(ACHIEVEMENTS.find((a) => a.id === "hours")!, 250)).toBe("Провести за просмотром 250 часов");
    expect(describe(ACHIEVEMENTS.find((a) => a.id === "marathon")!, 1)).toBe("Досмотреть 1 сериал от 50 серий");
    expect(describe(ACHIEVEMENTS.find((a) => a.id === "critic")!, 22)).toBe("Написать 22 комментария");
  });
  it("у всех описаний есть порог", () => {
    for (const a of ACHIEVEMENTS) expect(describe(a, 5)).not.toContain("{");
  });
});

group("сезонные события", () => {
  it("сезон по дате", () => {
    expect(seasonOf(Date.UTC(2026, 9, 13) / 1000)).toEqual({ season: "FALL", year: 2026 });
    expect(seasonOf(Date.UTC(2026, 1, 1) / 1000)).toEqual({ season: "WINTER", year: 2026 });
  });
  it("награда сезона и её описание", () => {
    const e = seasonEvent("FALL", 2026);
    expect(e.name).toBe("Осень 2026");
    expect(describe(e, 3)).toBe("Посмотреть 3 тайтла сезона «Осень 2026»");
    expect(achievementDef("season:2026:FALL")?.group).toBe("event");
  });
});
