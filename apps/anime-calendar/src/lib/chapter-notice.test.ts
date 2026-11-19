import { describe, expect, it } from "vitest";
import { summarize, type ChapterRow } from "./books";
import { chapterNotice, chapterSnap, mergeSnap } from "./chapter-notice";

const row = (num: number, lang: string, edition: ChapterRow["edition"] = "main"): ChapterRow => ({
  provider: lang === "ru" ? "mangalib" : "mangadex", ref: "x", edition, lang, team: null, vol: null, num, numText: String(num), title: null, date: null, cref: `${lang}${num}`,
});
const eds = (ru: number, en: number) => summarize([
  ...Array.from({ length: ru }, (_, i) => row(i + 1, "ru")),
  ...Array.from({ length: en }, (_, i) => row(i + 1, "en")),
]);

describe("уведомления о главах", () => {
  it("русская глава", () => {
    expect(chapterNotice(chapterSnap(eds(10, 12)), eds(11, 12))?.title).toBe("Глава 11 вышла на русском");
  });
  it("несколько русских глав", () => {
    expect(chapterNotice(chapterSnap(eds(10, 15)), eds(13, 15))?.title).toBe("3 главы на русском, последняя — глава 13");
  });
  it("английская — только если на русском нет", () => {
    expect(chapterNotice(chapterSnap(eds(10, 12)), eds(10, 13))?.title).toBe("Глава 13 вышла на английском, на русском пока нет");
    expect(chapterNotice(chapterSnap(eds(13, 12)), eds(13, 13))).toBeNull();
  });
  it("ничего нового и новое издание — молчим", () => {
    expect(chapterNotice(chapterSnap(eds(10, 12)), eds(10, 12))).toBeNull();
    expect(chapterNotice({}, eds(10, 12))).toBeNull();
  });
  it("снимок не уменьшается", () => {
    const merged = mergeSnap(chapterSnap(eds(10, 12)), chapterSnap(eds(8, 12)));
    expect(merged.main.ru).toBe(10);
    expect(chapterNotice(merged, eds(10, 12))).toBeNull();
  });
});
