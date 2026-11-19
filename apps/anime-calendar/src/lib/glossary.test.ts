import { describe, expect, it } from "vitest";
import { glossaryEntries, mergeTerms, withFallback, type Term } from "./glossary";

const t = (x: Partial<Term> & Pick<Term, "ru">): Term => ({ kind: "name", ja: null, en: null, alts: [], note: null, source: "shikimori", locked: false, proposed: false, ...x });

describe("глоссарий", () => {
  it("одно лицо из разных источников склеивается, русский — у главного источника", () => {
    const { terms, added } = mergeTerms([], [
      { kind: "name", en: "Rudeus Greyrat", ja: "ルーデウス・グレイラット", ru: "Рудеус Грейрат", alts: [], source: "deep" },
      { kind: "name", en: "Rudeus Greyrat", ja: null, ru: "Рудэус Грейрат", alts: ["Rudy"], source: "shikimori" },
    ]);
    expect(added).toBe(1);
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ ru: "Рудэус Грейрат", source: "shikimori", ja: "ルーデウス・グレイラット", alts: ["Rudy"] });
  });
  it("склейка по японскому написанию и варианту", () => {
    const { terms } = mergeTerms([t({ en: "Roxy Migurdia", ru: "Рокси" })], [{ kind: "name", en: "Roxy", ja: null, ru: "Рокси Мигурдия", alts: ["Roxy Migurdia"], source: "plot" }]);
    expect(terms).toHaveLength(1);
    expect(terms[0].ru).toBe("Рокси");
  });
  it("закреплённое не меняется, ручное главнее", () => {
    const cur = [t({ en: "Eris", ru: "Эрис", source: "manual", locked: true })];
    const { terms, changed } = mergeTerms(cur, [{ kind: "name", en: "Eris", ja: "エリス", ru: "Эрида", alts: [], source: "shikimori" }]);
    expect(changed).toBe(0);
    expect(terms[0]).toMatchObject({ ru: "Эрис", ja: null });
  });
  it("предложенное ИИ не идёт в перевод; закреплённое — первым", () => {
    const e = glossaryEntries([t({ en: "Mana", ru: "мана", source: "ai", proposed: true }), t({ en: "Sylphy", ru: "Сильфи" }), t({ en: "Paul", ru: "Пол", locked: true, source: "manual" })]);
    expect(e.map((x) => x.ru)).toEqual(["Пол", "Сильфи"]);
  });
  it("прежний словарь — без того, что есть в глоссарии", () => {
    const out = withFallback([{ names: ["Paul Greyrat"], ru: "Пол" }], [{ names: ["Paul Greyrat", "ポール"], ru: "Пауль" }, { names: ["Zenith"], ru: "Зенит" }]);
    expect(out.map((x) => x.ru)).toEqual(["Пол", "Зенит"]);
  });
});
