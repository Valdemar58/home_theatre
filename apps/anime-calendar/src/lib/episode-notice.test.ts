import { describe, expect, it } from "vitest";
import { airedNow, episodeNotice } from "./episode-notice";

const airing = (episode: number, airingAt: number) => ({ episodes: 12, status: "RELEASING", nextAiringEpisode: { episode, airingAt } });

describe("airedNow", () => {
  it("по снимку", () => expect(airedNow(airing(5, 2000), 1000)).toBe(4));
  it("время следующей прошло — она тоже вышла", () => expect(airedNow(airing(5, 2000), 3000)).toBe(5));
  it("вышедший тайтл", () => expect(airedNow({ episodes: 12, status: "FINISHED", nextAiringEpisode: null }, 0)).toBe(12));
});

describe("episodeNotice", () => {
  const m = airing(6, 0);
  it("смотрю: одна серия", () => expect(episodeNotice({ waiting: false, episodes: 4 }, m, 4, 5)).toEqual({ kind: "episode", title: "Вышла 5 серия", body: null }));
  it("смотрю: несколько сразу, отставание", () =>
    expect(episodeNotice({ waiting: false, episodes: 2 }, m, 3, 5)).toEqual({ kind: "episode", title: "Вышли серии 4–5", body: "Не просмотрено: 3" }));
  it("смотрю: финал", () => expect(episodeNotice({ waiting: false, episodes: 11 }, m, 11, 12)?.title).toBe("Вышла 12 серия — финал"));
  it("жду: промежуточные серии — молчим", () => expect(episodeNotice({ waiting: true, episodes: 0 }, m, 4, 5)).toBeNull());
  it("жду: вышла последняя", () => expect(episodeNotice({ waiting: true, episodes: 0 }, m, 11, 12)?.kind).toBe("finale"));
  it("ничего нового", () => expect(episodeNotice({ waiting: false, episodes: 5 }, m, 5, 5)).toBeNull());
});
