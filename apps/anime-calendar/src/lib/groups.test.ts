import { describe, expect, it } from "vitest";
import { groupProgress, pollWinner, sessionDue, sessionEps } from "./groups";

describe("группа просмотра", () => {
  it("прогресс — до какой серии досмотрели все", () => {
    expect(groupProgress([
      { status: "watching", episodes: 7, hidden: false },
      { status: "watching", episodes: 5, hidden: false },
      { status: "watching", episodes: 1, hidden: true },
    ], 12)).toBe(5);
    expect(groupProgress([{ status: "completed", episodes: 3, hidden: false }, { status: "watching", episodes: 12, hidden: false }], 12)).toBe(12);
    expect(groupProgress([{ status: null, episodes: 0, hidden: false }, { status: "watching", episodes: 4, hidden: false }], 12)).toBe(0);
    expect(groupProgress([], 12)).toBe(0);
  });
  it("голосование: больше голосов, при равенстве — первый вариант, без голосов — никто", () => {
    expect(pollWinner([{ anilistId: 1, votes: [1] }, { anilistId: 2, votes: [2, 3] }])).toBe(2);
    expect(pollWinner([{ anilistId: 1, votes: [1] }, { anilistId: 2, votes: [2] }])).toBe(1);
    expect(pollWinner([{ anilistId: 1, votes: [] }])).toBeNull();
  });
  it("сеанс: подготовка за час, напоминание за 15 минут, начало, пропуск через 3 часа", () => {
    const s = { startsAt: 10_000, status: "planned" as const, prepared: false, reminded: false };
    expect(sessionDue(s, 10_000 - 3700)).toEqual([]);
    expect(sessionDue(s, 10_000 - 3000)).toEqual(["prepare"]);
    expect(sessionDue({ ...s, prepared: true }, 10_000 - 600)).toEqual(["remind"]);
    expect(sessionDue({ ...s, prepared: true, reminded: true }, 10_000)).toEqual(["start"]);
    // Сервер лежал всё время до начала — и подготовить, и начать
    expect(sessionDue(s, 10_001)).toEqual(["prepare", "start"]);
    expect(sessionDue(s, 10_000 + 3 * 3600)).toEqual(["expire"]);
    expect(sessionDue({ ...s, status: "live" }, 10_000)).toEqual([]);
  });
  it("серии сеанса подписью", () => {
    expect(sessionEps({ ep: 5, count: 1 })).toBe("5 серия");
    expect(sessionEps({ ep: 5, count: 3 })).toBe("5–7 серии");
  });
});
