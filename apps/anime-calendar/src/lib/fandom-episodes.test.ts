import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { episodeCategory, infoboxInfo, parseDate, plotSections } from "./fandom-episodes";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf-8");
const boxes = JSON.parse(fixture("fandom-infoboxes.json")) as Record<string, Record<string, string>>;

describe("episodeCategory", () => {
  it("основная категория серий", () => {
    expect(episodeCategory(["Anime episodes", "Episode 10 Images", "Episode 11 Images"])).toBe("Anime episodes");
    expect(episodeCategory(["Episodes", "Mini Episodes"])).toBe("Episodes");
    expect(episodeCategory(["Culling Game Arc Episodes", "Episode 10 Images", "Episodes"])).toBe("Episodes");
    expect(episodeCategory(["Episode 10 Images"])).toBeNull();
  });
});

describe("parseDate", () => {
  it("форматы дат", () => {
    expect(parseDate("October 2, 2018")).toBe("2018-10-02");
    expect(parseDate("2 October 2018")).toBe("2018-10-02");
    expect(parseDate("2020-12-05")).toBe("2020-12-05");
    expect(parseDate("{{Start date|2018|10|2}}")).toBe("2018-10-02");
    expect(parseDate("TBA")).toBeNull();
  });
});

describe("infoboxInfo", () => {
  it("поле даты называют по-разному", () => {
    expect(infoboxInfo(boxes.tensura["A Day in a Swimsuit"])).toMatchObject({ date: "2021-04-27", season: "The Slime Diaries", number: "4" });
    expect(infoboxInfo(boxes.frieren["Episode 1"]).date).toBe("2023-09-29");
    expect(infoboxInfo(boxes.vinlandsaga["Episode 1"]).date).toBe("2019-07-07");
  });

  it("японский показ, а не английский", () => {
    expect(infoboxInfo(boxes["spy-x-family"]["Episode 1"])).toMatchObject({ date: "2022-04-09", season: "1" });
  });

  it("без предпоказа и режиссёрской версии", () => {
    expect(infoboxInfo(boxes["jujutsu-kaisen"]["Episode 1"]).date).toBe("2020-10-03");
    expect(infoboxInfo(boxes.rezero["Episode 1"]).date).toBe("2016-04-03");
  });
});

describe("plotSections", () => {
  it("анонс и подробный пересказ серии", () => {
    const { synopsis, plot } = plotSections(fixture("fandom-frieren-ep1.html"));
    expect(synopsis?.length).toBeGreaterThan(50);
    expect(plot?.length).toBeGreaterThan(3000);
    expect(plot).not.toMatch(/<|\[\d+\]|Sign in to edit/);
  });
});
