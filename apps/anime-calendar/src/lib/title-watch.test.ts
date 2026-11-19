import { describe, expect, it } from "vitest";
import { titleWatchTarget } from "./title-watch";
const releasing = { status: "RELEASING" as const, episodes: 12, nextAiringEpisode: { episode: 6, airingAt: 200 }, schedule: [] };
describe("title watch entry", () => {
  it("offers a released first episode without needing any downloaded file", () => {
    expect(titleWatchTarget(releasing, 0, 100).target).toBe(1);
  });
  it("waits when five episodes are watched and only five have aired", () => {
    expect(titleWatchTarget(releasing, 5, 100)).toEqual({ aired: 5, complete: false, target: null });
    expect(titleWatchTarget(releasing, 5, 200).target).toBe(6);
  });
  it("allows a rewatch only when the complete season has aired", () => {
    expect(titleWatchTarget(releasing, 12, 100).target).toBeNull();
    expect(titleWatchTarget({ ...releasing, status: "FINISHED" }, 12, 100).target).toBe(1);
  });
  it("does not invent release dates for an announced title", () => {
    expect(titleWatchTarget({ ...releasing, status: "NOT_YET_RELEASED", nextAiringEpisode: null }, 0, 100).target).toBeNull();
  });
});
