import { describe, expect, it } from "vitest";
import { franchiseItems, franchiseProgress, franchiseRoot, nextUp, type EntryLite, type FranchiseNode } from "./franchise";
import type { MediaLite } from "./types";

const media = (id: number, format: string, year: number, month = 1, extra: Partial<MediaLite> = {}): MediaLite => ({
  id, idMal: null, format, status: "FINISHED", episodes: 12, duration: 24, season: null, seasonYear: year, countryOfOrigin: "JP", source: null,
  isAdult: false, averageScore: null, malScore: null, popularity: 0, genres: [], title: { romaji: `t${id}`, english: null, native: null, ru: null },
  coverImage: { large: null, color: null }, bannerImage: null, studios: [], startDate: { year, month, day: 1 }, endDate: { year: null, month: null, day: null },
  nextAiringEpisode: null, ...extra,
});

// «Слизь»: S1 (1) → S2 (2) → фильм (3, продолжение S2) → S3 (4); OVA к S1 (5), спин-офф «Дневники» (6),
// пересказ S1 (7), клип (8); 9 — связь есть, но страница не загружена
function slime(): Map<number, FranchiseNode> {
  const n = new Map<number, FranchiseNode>();
  const add = (m: MediaLite, rel: [string, number][] | null) => n.set(m.id, { media: m, rel: rel && rel.map(([type, id]) => ({ type, id })) });
  add(media(1, "TV", 2018, 10), [["SEQUEL", 2], ["SIDE_STORY", 5], ["SPIN_OFF", 6], ["SUMMARY", 7], ["CHARACTER", 99]]);
  add(media(2, "TV", 2021, 1), [["PREQUEL", 1], ["SEQUEL", 3]]);
  add(media(3, "MOVIE", 2022, 11), [["PREQUEL", 2], ["SEQUEL", 4]]);
  add(media(4, "TV", 2024, 4), [["PREQUEL", 3], ["SIDE_STORY", 9]]);
  add(media(5, "OVA", 2019, 3), [["PARENT", 1], ["OTHER", 8]]);
  add(media(6, "TV", 2021, 4), [["SPIN_OFF", 1], ["SEQUEL", 10]]);
  add(media(7, "SPECIAL", 2020, 1), [["SUMMARY", 1]]);
  add(media(8, "MUSIC", 2019, 1), [["OTHER", 5]]);
  add(media(9, "OVA", 2024, 9), null);
  add(media(10, "TV", 2023, 1), [["PREQUEL", 6]]);
  return n;
}

describe("franchiseRoot", () => {
  it("вверх по предыстории, от дополнения — к основной истории", () => {
    const n = slime();
    expect(franchiseRoot(4, n)).toBe(1);
    expect(franchiseRoot(5, n)).toBe(1);
    expect(franchiseRoot(1, n)).toBe(1);
  });

  it("сериал-предыстория важнее фильма-предыстории", () => {
    const n = new Map<number, FranchiseNode>([
      [1, { media: media(1, "MOVIE", 2015), rel: [] }],
      [2, { media: media(2, "TV", 2016), rel: [] }],
      [3, { media: media(3, "TV", 2017), rel: [{ type: "PREQUEL", id: 1 }, { type: "PREQUEL", id: 2 }] }],
    ]);
    expect(franchiseRoot(3, n)).toBe(2);
  });
});

describe("franchiseItems", () => {
  it("вид по связи и порядок по выходу", () => {
    const items = franchiseItems(1, slime());
    expect(items.map((i) => [i.media.id, i.kind])).toEqual([
      [1, "main"], [5, "side"], [7, "recap"], [2, "main"], [6, "spinoff"], [3, "main"], [10, "spinoff"], [4, "main"], [9, "side"],
    ]);
  });

  it("клипы и несюжетные связи — не франшиза", () => {
    const ids = franchiseItems(1, slime()).map((i) => i.media.id);
    expect(ids).not.toContain(8);
    expect(ids).not.toContain(99);
  });

  it("основная цепочка — даже если дополнение нашлось раньше по обходу", () => {
    const n = new Map<number, FranchiseNode>([
      [1, { media: media(1, "TV", 2015), rel: [{ type: "SIDE_STORY", id: 2 }, { type: "SEQUEL", id: 3 }] }],
      [2, { media: media(2, "OVA", 2016), rel: [{ type: "SEQUEL", id: 3 }] }],
      [3, { media: media(3, "TV", 2017), rel: [{ type: "PREQUEL", id: 1 }] }],
    ]);
    expect(franchiseItems(1, n).find((i) => i.media.id === 3)?.kind).toBe("main");
  });
});

describe("nextUp и прогресс", () => {
  const items = franchiseItems(1, slime());
  it("первый недосмотренный вышедший тайтл основной истории или дополнение", () => {
    const e = new Map<number, EntryLite>([[1, { status: "completed", episodes: 12 }], [5, { status: "dropped", episodes: 0 }]]);
    expect(nextUp(items, e)).toBe(2);
    expect(nextUp(items, new Map())).toBe(1);
  });

  it("серии основной истории и дополнений", () => {
    const e = new Map<number, EntryLite>([[1, { status: "completed", episodes: 0 }], [2, { status: "watching", episodes: 5 }]]);
    // 1, 2, 3, 4, 5, 9 — по 12 серий; спин-оффы и пересказ не считаются
    expect(franchiseProgress(items, e)).toEqual({ watched: 17, total: 72 });
  });
});
