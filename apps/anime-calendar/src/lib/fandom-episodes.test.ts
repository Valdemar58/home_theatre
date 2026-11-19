import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { episodeCategory, infoboxInfo, parseDate, plotSections, wikiMatchScore } from "./fandom-episodes";

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
    expect(parseDate("Sep 29, 2023")).toBe("2023-09-29");
    expect(parseDate("Sept. 5, 2024")).toBe("2024-09-05");
    expect(parseDate("2020-12-05")).toBe("2020-12-05");
    expect(parseDate("{{Start date|2018|10|2}}")).toBe("2018-10-02");
    expect(parseDate("April 1st, 2020")).toBe("2020-04-01");
    expect(parseDate("23rd May 2024")).toBe("2024-05-23");
    expect(parseDate("TBA")).toBeNull();
  });
});

describe("infoboxInfo", () => {
  it("поле даты называют по-разному", () => {
    expect(infoboxInfo(boxes.tensura["A Day in a Swimsuit"])).toMatchObject({ date: "2021-04-27", season: "The Slime Diaries", number: "4" });
    expect(infoboxInfo(boxes.frieren["Episode 1"])).toMatchObject({ date: "2023-09-29", titleJa: "{{Ruby|冒|ぼう}}{{Ruby|険|けん}}の{{Ruby|終|お}}わり" });
    expect(infoboxInfo(boxes.rezero["Episode 1"]).titleJa).toBe("始まりの終わりと終わりの始まり");
    expect(infoboxInfo(boxes.vinlandsaga["Episode 1"]).date).toBe("2019-07-07");
  });

  it("японский показ, а не английский", () => {
    expect(infoboxInfo(boxes["spy-x-family"]["Episode 1"])).toMatchObject({ date: "2022-04-09", season: "1" });
    // «Атака титанов»: (JA) и (US) в скобках, американский показ раньше в списке
    expect(infoboxInfo("{{Infobox episode\n| Air date (US) = May 17, 2014\n| Air date (JA) = April 21, 2013\n}}").date).toBe("2013-04-21");
  });

  it("release_date вместо air date («Башня Бога»)", () => {
    expect(infoboxInfo("{{Episode\n|name = BALL\n|season = 1\n|episode = 1\n|release_date = April 1st, 2020\n}}")).toMatchObject({ date: "2020-04-01", season: "1", number: "1" });
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

  it("Short / Detailed Summary («Башня Бога»)", () => {
    const h2 = (id: string, body: string) => `<h2><span class="mw-headline" id="${id}">${id}</span></h2><p>${body}</p>`;
    const { synopsis, plot } = plotSections(h2("Official_Synopsis", "Анонс.") + h2("Short_Summary", "Коротко.") + h2("Detailed_Summary", "Подробный пересказ серии."));
    expect(synopsis).toBe("Анонс.");
    expect(plot).toBe("Подробный пересказ серии.");
  });
});

describe("wikiMatchScore", () => {
  const prince = ["I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability", "Tensei shitara Dainana Ouji Datta node, Kimama ni Majutsu wo Kiwamemasu"];

  it("вика тайтла — по описанию и названию", () => {
    expect(wikiMatchScore(prince, { name: "Tensei Shitara Dai Nana Ōji Wiki", description: 'Fandom Wiki for the "I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability" Series', url: "https://reincarnated-as-the-7th-prince.fandom.com/" })).toBe(1);
    expect(wikiMatchScore(["Tomodachi Game"], { name: "Tomodachi Game Wiki", url: "https://tomodachi-game.fandom.com/" })).toBe(1);
  });

  it("чужая вика с похожим словом — низкий балл", () => {
    expect(wikiMatchScore(["Tomodachi Game"], { name: "Tomodachi Life Wiki", url: "https://tomodachi.fandom.com/" })).toBe(0.5);
    expect(wikiMatchScore(["The Strongest Magician in the Demon Lord's Army was a Human"], { name: "Strongest Necromancer of Heaven's Gate Wiki", url: "https://strongest-necromancer-of-heavens-gate.fandom.com/" })).toBeLessThan(0.3);
  });
});
