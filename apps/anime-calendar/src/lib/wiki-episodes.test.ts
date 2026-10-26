import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignToTimeline, decodeEntities, htmlText, jstDate, parseEpisodeTables, pickSeason } from "./wiki-episodes";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf-8");

describe("parseEpisodeTables", () => {
  const rows = parseEpisodeTables(fixture("wiki-rezero-s1.html"), "rezero");

  it("строка серии: номер, название, дата, пересказ", () => {
    expect(rows).toHaveLength(25);
    const first = rows[0];
    expect(first).toMatchObject({ overall: "1", title: "The End of the Beginning and the Beginning of the End", date: "2016-04-04" });
    expect(first.text).toMatch(/^On the way home from a convenience store, Subaru Natsuki/);
    // без сносок и разметки
    expect(first.text).not.toMatch(/\[\d+\]|<|&#/);
    expect(rows.every((r) => r.text.length > 300)).toBe(true);
  });

  it("в общем списке серий описаний нет — только строки", () => {
    const list = parseEpisodeTables(fixture("wiki-slime-list.html"), "list");
    expect(list.filter((r) => r.date?.startsWith("2018")).length).toBeGreaterThan(5);
    expect(list.filter((r) => r.table === "list#0").every((r) => !r.text)).toBe(true);
  });
});

describe("pickSeason", () => {
  it("сезон по датам: 25 серий Re:Zero", () => {
    const eps = pickSeason(parseEpisodeTables(fixture("wiki-rezero-s1.html")), { start: "2016-04-04", end: "2016-09-19", count: 25 });
    expect(eps.map((e) => e.ep)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("описания из статьи сезона дополняют общий список", () => {
    const rows = [...parseEpisodeTables(fixture("wiki-slime-list.html"), "list"), ...parseEpisodeTables(fixture("wiki-slime-s1.html"), "s1")];
    const eps = pickSeason(rows, { start: "2018-10-02", end: "2019-03-19", count: 24 });
    expect(eps).toHaveLength(24);
    expect(eps.filter((e) => e.text.length > 300).length).toBeGreaterThanOrEqual(23);
    expect(eps[0].date).toBe("2018-10-02");
  });

  it("мини-сериал в те же даты не смешивается; серии одного дня — по номеру", () => {
    const eps = pickSeason(parseEpisodeTables(fixture("wiki-frieren-list.html"), "list"), { start: "2023-09-29", end: "2024-03-22", count: 28 });
    expect(eps).toHaveLength(28);
    expect(new Set(eps.map((e) => e.table)).size).toBe(1);
    expect(eps.slice(0, 4).map((e) => e.overall)).toEqual(["1", "2", "3", "4"]);
  });

  it("онгоинг: до сегодняшнего дня, без объявленного числа", () => {
    const eps = pickSeason(parseEpisodeTables(fixture("wiki-rezero-s1.html")), { start: "2016-04-04", end: null, count: null }, "2016-05-01");
    expect(eps.length).toBe(4);
  });

  it("без даты начала — ничего", () => {
    expect(pickSeason(parseEpisodeTables(fixture("wiki-rezero-s1.html")), { start: null, end: null, count: null })).toEqual([]);
  });
});

describe("htmlText", () => {
  it("сущности и сноски", () => {
    expect(decodeEntities("A&#160;&amp;&#x2014;B &quot;x&quot;")).toBe("A &—B \"x\"");
    expect(decodeEntities("七崩賢&ldquo;断頭台のアウラ&rdquo;&hellip;")).toBe("七崩賢“断頭台のアウラ”…");
    expect(htmlText('<p>Hi <a href="#">there</a><sup class="reference"><a>[1]</a></sup>.</p>')).toBe("Hi there.");
  });
});

describe("alignToTimeline", () => {
  const timeline = [
    { ep: 1, date: "2022-07-09" }, { ep: 2, date: "2022-07-16" }, { ep: 3, date: "2022-07-23" }, { ep: 4, date: "2022-07-30" },
  ];

  it("пропущенная серия в источнике не сдвигает остальные", () => {
    const rows = [{ date: "2022-07-16", title: "Episode 2" }, { date: "2022-07-23", title: "Episode 3" }, { date: "2022-07-30", title: "Episode 4" }];
    expect(alignToTimeline(rows, timeline).map((r) => [r.ep, r.title])).toEqual([[2, "Episode 2"], [3, "Episode 3"], [4, "Episode 4"]]);
  });

  it("дата ±1 день (показ после полуночи), серии одного дня — по порядку", () => {
    const tl = [{ ep: 1, date: "2023-09-29" }, { ep: 2, date: "2023-09-29" }, { ep: 3, date: "2023-10-06" }];
    const rows = [{ date: "2023-09-29", overall: "2" }, { date: "2023-09-30", overall: "1" }, { date: "2023-10-05", overall: "3" }];
    expect(alignToTimeline(rows, tl).map((r) => [r.ep, r.overall])).toEqual([[1, "2"], [2, "1"], [3, "3"]]);
  });

  it("чужой сезон — пар нет", () => {
    expect(alignToTimeline([{ date: "2023-01-11" }, { date: "2023-01-18" }], timeline)).toEqual([]);
  });

  it("jstDate: полночь по Японии — уже следующий день", () => {
    expect(jstDate(Date.UTC(2024, 0, 5, 15, 30) / 1000)).toBe("2024-01-06");
  });
});
