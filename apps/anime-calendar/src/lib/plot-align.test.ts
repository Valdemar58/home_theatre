import { describe, expect, it } from "vitest";
import { alignPlot, needsMore } from "./plot-align";

// Похожесть «глава × серия»: 0.8 — та самая серия, 0.3 — фон
const matrix = (chapters: number, episodes: number, hit: (j: number) => number | null): number[][] =>
  Array.from({ length: chapters }, (_, j) => Array.from({ length: episodes }, (_, i) => (hit(j) === i ? 0.8 : 0.3)));

describe("выравнивание серий и глав", () => {
  it("по две главы на серию", () => {
    const a = alignPlot(matrix(6, 3, (j) => Math.floor(j / 2)));
    expect(a.episodes).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("главы вне сезона (на все серии похожи одинаково) не достаются никому", () => {
    const m = matrix(8, 4, (j) => (j < 4 ? j : null));
    for (let j = 4; j < 8; j++) m[j] = [0.55, 0.5, 0.55, 0.52]; // следующая арка: те же герои
    expect(alignPlot(m).episodes).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
  });
  it("пустая серия между найденными получает хвост глав предыдущей, если он похож на неё", () => {
    // главы 0–3 похожи на серию 0, но 2–3 — заметно похожи и на серию 1; серия 2 — главы 4–5
    const m = matrix(6, 4, (j) => (j < 4 ? 0 : 2));
    m[2][0] = 0.65; m[2][1] = 0.75; m[3][0] = 0.65; m[3][1] = 0.75;
    expect(alignPlot(m).episodes).toEqual([[0, 1], [2, 3], [4, 5], null]);
  });
  it("пропущенная главa (не экранизирована) и серия-оригинал без глав", () => {
    // главы 0–1 → серия 0, глава 2 — ни к чему, 3–4 → серия 2; серия 1 — оригинал
    const a = alignPlot(matrix(5, 3, (j) => (j < 2 ? 0 : j === 2 ? null : 2)));
    expect(a.episodes).toEqual([[0, 1], null, [3, 4]]);
  });
  it("порядок не нарушается шумом", () => {
    const m = matrix(6, 3, (j) => Math.floor(j / 2));
    m[1][2] = 0.6; // глава 1 заметно похожа и на серию 2
    expect(alignPlot(m).episodes).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("окно кончилось раньше серий — нужно больше глав", () => {
    const a = alignPlot(matrix(4, 4, (j) => j));
    expect(needsMore({ ...a, episodes: [[0, 1], [2, 3], null, null] }, 4)).toBe(true);
    expect(needsMore(alignPlot(matrix(8, 5, (j) => (j < 3 ? 0 : j < 5 ? 1 : null))), 8)).toBe(false);
  });
});
