import { describe, expect, it } from "vitest";
import { applyProgress, episodeProgress, type EntryState } from "./entry-rules";

const finished = { episodes: 12, status: "FINISHED", nextAiringEpisode: null };
const airing = (next: number) => ({ episodes: 12, status: "RELEASING", nextAiringEpisode: { episode: next, airingAt: 0, timeUntilAiring: 0 } });
const st = (o: Partial<EntryState>): EntryState => ({ status: "watching", waiting: false, episodes: 0, airedMark: null, ...o });

describe("автостатус", () => {
  it("серия у «Запланировано» / «Отложено» / нет в списке → «Смотрю»", () => {
    expect(applyProgress(st({ status: "planned" }), { episodes: 1 }, finished).status).toBe("watching");
    expect(applyProgress(st({ status: "on_hold", episodes: 3 }), { episodes: 4 }, finished).status).toBe("watching");
    expect(applyProgress(null, { episodes: 1 }, finished).status).toBe("watching");
  });
  it("серия у «Просмотрено» → «Пересматриваю», досмотрел — снова «Просмотрено»", () => {
    const re = applyProgress(st({ status: "completed", episodes: 12 }), { episodes: 1 }, finished);
    expect(re.status).toBe("rewatching");
    expect(applyProgress(re, { episodes: 12 }, finished).status).toBe("completed");
  });
  it("последняя серия онгоинга — ещё не «Просмотрено»", () => {
    expect(applyProgress(st({}), { episodes: 4 }, { ...airing(5), episodes: 4 }).status).toBe("watching");
  });
  it("явный статус важнее автостатуса", () => {
    expect(applyProgress(st({ status: "completed", episodes: 12 }), { status: "dropped", episodes: 3 }, finished).status).toBe("dropped");
  });
});

describe("«+N новых» и «осталось»", () => {
  it("начал смотреть онгоинг на 4-й серии — новыми считаются вышедшие после", () => {
    const e = applyProgress(st({ status: "planned" }), { episodes: 4 }, airing(5)); // вышло 4
    expect(e.airedMark).toBe(4);
    expect(episodeProgress(e, airing(13))).toEqual({ fresh: 8, remaining: 8 });
  });
  it("начал, когда вышло 10, посмотрел 2 — это бэклог, а не «новые»", () => {
    const e = applyProgress(st({ status: "planned" }), { episodes: 2 }, airing(11));
    expect(episodeProgress(e, airing(11))).toEqual({ fresh: 0, remaining: 8 });
    expect(episodeProgress(e, airing(12))).toEqual({ fresh: 1, remaining: 9 });
  });
  it("пересмотр и старые записи без отметки — без «новых»", () => {
    expect(episodeProgress(st({ status: "rewatching", episodes: 2, airedMark: 1 }), finished).fresh).toBe(0);
    expect(episodeProgress(st({ episodes: 2 }), airing(6))).toEqual({ fresh: 0, remaining: 3 });
  });
});
