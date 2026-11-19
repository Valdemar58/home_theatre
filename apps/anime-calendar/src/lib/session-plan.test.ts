import { describe, it, expect } from "vitest";
import { episodeAvailability, localTimeCandidates, sessionTimeline, type SessionBlock } from "./session-plan";
import type { MediaLite } from "./types";
describe("session planning", () => {
  const block: SessionBlock = { anilistId: 1, episodes: [1, 3, 7], breakMinutes: 10, durationMinutes: 24, durationSource: "catalog" };
  it("sums selected episodes, respects order, skips only intermediate breaks", () => {
    const rows = sessionTimeline([block, { ...block, anilistId: 2, episodes: [2], breakMinutes: 240 }], 0, true);
    expect(rows).toEqual([{ start: 0, end: 63 * 60, next: 73 * 60, deduction: 3 }, { start: 73 * 60, end: 94 * 60, next: 94 * 60, deduction: 3 }]);
    expect(sessionTimeline([{ ...block, durationMinutes: 2 }], 0, true)[0].end).toBe(360);
  });
  it("rejects DST gaps and exposes both fold occurrences", () => {
    expect(localTimeCandidates("2027-03-28T02:30", "Europe/Berlin")).toEqual([]);
    const fold = localTimeCandidates("2027-10-31T02:30", "Europe/Berlin");
    expect(fold).toHaveLength(2); expect(fold[1] - fold[0]).toBe(3600);
    expect(localTimeCandidates("2027-02-30T10:00", "UTC")).toEqual([]);
    expect(localTimeCandidates("2027-03-10T10:00", "wrong")).toEqual([]);
  });
  it("does not extrapolate unknown releases", () => {
    const m = { episodes: 12, status: "RELEASING", nextAiringEpisode: { episode: 6, airingAt: 200 } } as MediaLite;
    expect(episodeAvailability(m, 5, 100).selectable).toBe(true);
    expect(episodeAvailability(m, 6, 100).selectable).toBe(false);
    expect(episodeAvailability(m, 6, 200).selectable).toBe(true);
    expect(episodeAvailability(m, 7, 10000).selectable).toBe(false);
    expect(episodeAvailability({ ...m, status: "FINISHED" }, 13, 10000).selectable).toBe(false);
  });
});
