import { describe, expect, it } from "vitest";
import { coverageState, mergeCoverage } from "./watch-coverage";

describe("actual viewing coverage", () => {
  it("uses 10% and 80% of the entire duration", () => {
    for (const duration of [60, 180, 720, 1440, 3600]) {
      expect(coverageState([[0, duration * .0999]], duration).started).toBe(false);
      expect(coverageState([[0, duration * .1]], duration).started).toBe(true);
      expect(coverageState([[0, duration * .7999]], duration).watched).toBe(false);
      expect(coverageState([[0, duration * .8]], duration).watched).toBe(true);
    }
  });
  it("does not fill seek gaps or double-count replayed intervals", () => {
    const state = coverageState([[0, 30], [970, 1000], [0, 30], [10, 20]], 1000);
    expect(state.seconds).toBe(60);
    expect(state.started).toBe(false);
    expect(state.watched).toBe(false);
  });
  it("keeps pauses, overlaps and out-of-order reports idempotent", () => {
    expect(mergeCoverage([[30, 60], [0, 20], [10, 40], [70, 80]], 100))
      .toEqual([[0, 60], [70, 80]]);
  });
  it("ignores malformed intervals and clips to the actual media", () => {
    expect(mergeCoverage([[NaN, 20], [1, Infinity], [30, 20], ["0", 50], [-5, 20], [90, 150]], 100))
      .toEqual([[0, 20], [90, 100]]);
    expect(coverageState([[0, 100]], 0).watched).toBe(false);
  });
  it("does not assume a fixed opening/ending length for short episodes", () => {
    expect(coverageState([[90, 1350]], 1440).watched).toBe(true);
    expect(coverageState([[90, 630]], 720).watched).toBe(false);
    expect(coverageState([[30, 150]], 180).watched).toBe(false);
  });
});
