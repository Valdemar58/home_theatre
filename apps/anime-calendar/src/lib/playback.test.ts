import { describe, expect, it } from "vitest";
import { episodeStates, lastPlayable, waitText, watchTarget, type EpisodeItem } from "./playback";

const items = (m: Record<number, EpisodeItem[]>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), v]));

describe("episodeStates", () => {
  const st = episodeStates({
    total: 6,
    aired: 5,
    items: items({
      1: [{ itemId: "a", where: "library" }, { itemId: "s1", where: "stream", hash: "h", index: 1 }],
      2: [{ itemId: "s2", where: "stream", hash: "h", index: 2 }],
      3: [{ itemId: "s3", where: "stream", hash: "h", index: 3 }],
    }),
    buffers: new Map([["h:2", { ready: false, etaSec: 40, read: 25, size: 100, done: false }], ["h:3", { ready: true, etaSec: 0, read: 100, size: 100, done: true }]]),
    queue: new Map([[4, { pct: 0.5, etaSec: 120 }]]),
  });

  it("библиотека важнее «Стрима», буфер — у серии «Стрима»", () => {
    expect(st.map((s) => s.state)).toEqual(["library", "stream", "stream", "downloading", "aired", "upcoming"]);
    expect(st[0].itemId).toBe("a");
    expect(st[1]).toMatchObject({ ready: false, preparing: true, pct: 0.25, etaSec: 40 });
    expect(st[2]).toMatchObject({ ready: true, preparing: false });
  });

  it("кнопка «Смотреть» — следующая после просмотренных; всё просмотрено — с первой", () => {
    expect(watchTarget(st, 1)?.ep).toBe(2);
    expect(watchTarget(st, 4)?.ep).toBe(5);
    expect(watchTarget(st, 5)).toBeNull();
    expect(watchTarget(st, 6)?.ep).toBe(1);
  });

  it("дальняя доступная серия и время ожидания", () => {
    expect(lastPlayable(st)).toBe(3);
    expect([waitText(40), waitText(180), waitText(3900)]).toEqual(["40 с", "3 мин", "1 ч 5 мин"]);
  });
});
