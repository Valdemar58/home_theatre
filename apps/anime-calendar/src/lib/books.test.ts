import { describe, expect, it } from "vitest";
import { bookKind, docToBlocks, htmlToBlocks, keyRanges, parseNum, summarize, titleMatch, type ChapterRow } from "./books";

const row = (o: Partial<ChapterRow>): ChapterRow => ({
  provider: "p", ref: "b", edition: "main", lang: "ru", team: null, vol: null, num: 1, numText: "1", title: null, date: null, cref: "c", ...o,
});

describe("bookKind", () => {
  it("формат и страна", () => {
    expect(bookKind("NOVEL", "JP")).toBe("novel");
    expect(bookKind("MANGA", "KR")).toBe("manhwa");
    expect(bookKind("MANGA", "CN")).toBe("manhua");
    expect(bookKind("ONE_SHOT", "JP")).toBe("oneshot");
    expect(bookKind("MANGA", "JP")).toBe("manga");
  });
});

describe("summarize", () => {
  it("главы по языкам, команды, пропуски русского диапазонами", () => {
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((n) => row({ lang: "en", num: n, numText: String(n), team: "Tempest", provider: "mangadex" })),
      ...[1, 2, 5].map((n) => row({ lang: "ru", num: n, numText: String(n), team: "Команда", provider: "mangalib" })),
      row({ lang: "ru", num: 2, numText: "2", team: "Другая", provider: "mangalib" }),
      row({ lang: "ja", num: 7, numText: "7", provider: "raw" }),
    ];
    const [s] = summarize(rows);
    expect(s.chapters.map((c) => c.key)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(s.missingRu).toEqual(["3–4", "6–7"]);
    const ru = s.langs.find((l) => l.lang === "ru")!;
    expect(ru.count).toBe(3);
    expect(ru.teams[0]).toMatchObject({ team: "Команда", count: 3 });
    expect(s.langs.map((l) => l.lang)).toEqual(["orig", "ru", "en"]);
    expect(s.chapters[1].langs.ru).toHaveLength(2);
  });

  it("книжное издание — главы считаются по томам, веб — отдельно", () => {
    const rows = [
      row({ edition: "book", vol: 1, num: 1, numText: "1" }),
      row({ edition: "book", vol: 2, num: 1, numText: "1" }),
      row({ edition: "web", num: 1, numText: "1", lang: "ja" }),
    ];
    const s = summarize(rows);
    expect(s.map((e) => e.edition)).toEqual(["web", "book"]);
    expect(s[1].chapters.map((c) => c.key)).toEqual(["1-1", "2-1"]);
    expect(s[0].missingRu).toEqual(["1"]);
  });

  it("перевод ИИ не закрывает пропуск, но и сам пропуском не считается", () => {
    const [s] = summarize([row({ lang: "ai", num: 1 }), row({ lang: "en", num: 2, numText: "2" }), row({ lang: "ai", num: 2, numText: "2" })]);
    expect(s.missingRu).toEqual(["2"]);
  });
});

describe("keyRanges и номера", () => {
  it("диапазоны рвёт только глава с переводом", () => {
    expect(keyRanges(["1", "2", "4"], ["1", "2", "3", "4"])).toEqual(["1–2", "4"]);
    expect(keyRanges([], ["1"])).toEqual([]);
  });
  it("номер из текста", () => {
    expect(parseNum("Глава 12.5")).toBe(12.5);
    expect(parseNum("12,5")).toBe(12.5);
    expect(parseNum("Экстра")).toBeNull();
  });
});

describe("titleMatch", () => {
  const ours = ["Mushoku Tensei: Isekai Ittara Honki Dasu", "Mushoku Tensei: Jobless Reincarnation", "無職転生 ～異世界行ったら本気だす～"];
  it("точное совпадение одного из названий (без пунктуации и регистра)", () => {
    expect(titleMatch(ours, ["mushoku tensei isekai ittara honki dasu"])).toBe(1);
  });
  it("подзаголовок — частичное, другая книга — нет, другой год — нет", () => {
    expect(titleMatch(["Tensei Shitara Slime Datta Ken"], ["Tensei Shitara Slime Datta Ken: Mabutsu no Kuni no Arukikata"])).toBe(0.6);
    expect(titleMatch(ours, ["Mushoku Tensei shoruto storisu"])).toBe(0);
    expect(titleMatch(["Berserk"], ["Berserk"], { ours: 1989, theirs: 2016 })).toBe(0);
  });
});

describe("текст главы", () => {
  it("HTML: абзацы, переносы, сущности, картинки", () => {
    const b = htmlToBlocks(`<p data-paragraph-index="1">Мужчина&nbsp;может &laquo;бродить&raquo;</p><p></p><p>Две<br>строки</p><img src="/x.jpg"><hr>`, (s) => `https://h${s}`);
    expect(b).toEqual([
      { t: "p", text: "Мужчина может «бродить»" }, { t: "p", text: "Две" }, { t: "p", text: "строки" },
      { t: "img", url: "https://h/x.jpg" }, { t: "hr" },
    ]);
  });
  it("ProseMirror: абзацы и жёсткие переносы", () => {
    const doc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Раз " }, { type: "text", text: "два" }] },
      { type: "paragraph", content: [{ type: "text", text: "три" }, { type: "hardBreak" }, { type: "text", text: "четыре" }] },
      { type: "image", attrs: { images: [{ image: "a.png" }] } },
    ] };
    expect(docToBlocks(doc)).toEqual([{ t: "p", text: "Раз два" }, { t: "p", text: "три" }, { t: "p", text: "четыре" }, { t: "img", url: "a.png" }]);
  });
});

import { pickTranslation as pick } from "./books";
describe("pickTranslation", () => {
  const [s] = summarize([
    row({ lang: "en", provider: "mangadex", team: "T" }), row({ lang: "ru", provider: "mangalib", team: "А" }),
    row({ lang: "ru", provider: "mangalib", team: "Б" }), row({ lang: "ja", provider: "syosetu" }),
  ]);
  it("выбранная команда, иначе тот же провайдер, иначе русский", () => {
    expect(pick(s.chapters[0], { provider: "mangalib", team: "Б" })?.team).toBe("Б");
    expect(pick(s.chapters[0], { provider: "mangalib", team: "нет такой" })?.team).toBe("А");
    expect(pick(s.chapters[0], { provider: "mangadex", team: "T" })?.lang).toBe("en");
    expect(pick(s.chapters[0])?.lang).toBe("ru");
  });
});
