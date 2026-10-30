import { describe, expect, it } from "vitest";
import { rankPicks, seedWeight } from "./book-picks";

describe("подборка книг", () => {
  it("вес источника — по оценке, без оценки — по статусу", () => {
    expect(seedWeight("completed", 10)).toBe(1);
    expect(seedWeight("completed", 5)).toBe(0);
    expect(seedWeight("watching", 0)).toBe(0.5);
    expect(seedWeight("dropped", 9)).toBe(0);
  });
  it("книгу, которую советуют несколько источников, — выше; прочитанное — мимо", () => {
    const recs = new Map([[1, [10, 11, 12]], [2, [11, 13]], [3, [10]]]);
    const r = rankPicks([{ id: 1, weight: 1 }, { id: 2, weight: 1 }, { id: 3, weight: 0 }], recs, new Set([12]));
    expect(r.map((x) => x.id)).toEqual([11, 10, 13]);
    expect(r[0].because).toEqual([2, 1]);
  });
});
