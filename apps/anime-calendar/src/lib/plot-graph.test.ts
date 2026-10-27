import { describe, expect, it } from "vitest";
import { foldGraph, graphForPrompt, identityGroups, linkNames, lookAt, sameName, type GraphDelta } from "./plot-graph";

const delta = (d: Partial<GraphDelta>): GraphDelta => ({
  personas: [], aliases: [], looks: [], identities: [], members: [], relations: [], events: [], links: [], abilities: [],
  group_word_ru: "", power_system: false, ...d,
});
const persona = (key: string, ep: number, name = key) => ({
  key, kind: "персонаж" as const, importance: "второй план" as const, name_ru: name, name_en: name, name_ja: "", description_ru: `${name} на ${ep}`, goal_ru: "", first_ep: ep,
});

describe("foldGraph", () => {
  it("серия дополнения — внутри порции, первое появление не переписывается", () => {
    const g = foldGraph([
      { eps: [1, 2, 3, 4], delta: delta({ personas: [persona("Reiner", 1)] }) },
      { eps: [5, 6, 7, 8], delta: delta({ personas: [persona("reiner", 6), persona("armored", 99)] }) },
    ]);
    expect(g.personas.get("reiner")!.first_ep).toBe(1);
    expect(g.personas.get("armored")!.revealed).toBe(8);
    expect(g.notes.filter((n) => n.key === "reiner").map((n) => n.upTo)).toEqual([4, 8]);
  });

  it("личность: раскрытие с серией, только между известными персонажами", () => {
    const g = foldGraph([
      { eps: [1, 2], delta: delta({ personas: [persona("reiner", 1), persona("armored", 1)] }) },
      { eps: [31, 32], delta: delta({ identities: [{ a: "armored", b: "reiner", ep: 31, note_ru: "" }, { a: "reiner", b: "ghost", ep: 31, note_ru: "" }] }) },
    ]);
    expect(g.identities).toHaveLength(1);
    expect(g.identities[0].revealed).toBe(31);
  });

  it("отношение кончается — у записи серия конца, новое — отдельной записью", () => {
    const g = foldGraph([
      { eps: [9], delta: delta({ personas: [persona("rimuru", 1), persona("benimaru", 9)], relations: [{ a: "benimaru", b: "rimuru", kind: "враг", label_ru: "", from_ep: 9, ended_ep: 0 }] }) },
      { eps: [10], delta: delta({ relations: [{ a: "rimuru", b: "benimaru", kind: "враг", label_ru: "", from_ep: 9, ended_ep: 10 }, { a: "benimaru", b: "rimuru", kind: "служит", label_ru: "", from_ep: 10, ended_ep: 0 }] }) },
    ]);
    expect(g.relations.map((r) => [r.kind, r.from_ep, r.ended_ep])).toEqual([["враг", 9, 10], ["служит", 10, 0]]);
  });

  it("события и причины: связь только между известными событиями", () => {
    const ev = (key: string, ep: number) => ({ key, title_ru: key, summary_ru: "", course_ru: "", kind: "бой" as const, major: true, ep_from: ep, ep_to: ep, arc_ru: "", participants: [{ key: "rimuru", role_ru: "", motive_ru: "" }, { key: "x", role_ru: "", motive_ru: "" }] });
    const g = foldGraph([{ eps: [9, 10], delta: delta({ personas: [persona("rimuru", 1)], events: [ev("fire", 9), ev("attack", 9)], links: [{ from: "fire", to: "attack", kind: "причина", note_ru: "" }, { from: "fire", to: "nope", kind: "повод", note_ru: "" }] }) }]);
    expect(g.events.get("fire")!.participants.map((p) => p.key)).toEqual(["rimuru"]);
    expect(g.links).toHaveLength(1);
    expect(graphForPrompt(g)).toContain("attack | 9 | attack");
  });
});

describe("identityGroups", () => {
  it("склеивает транзитивно и только раскрытое к серии", () => {
    const links = [{ a: 1, b: 2, revealed: 31 }, { a: 2, b: 3, revealed: 40 }];
    expect(identityGroups(links, 30).get(1)).toBeUndefined();
    expect(identityGroups(links, 31).get(1)!.sort()).toEqual([1, 2]);
    expect(identityGroups(links, 40).get(3)!.sort()).toEqual([1, 2, 3]);
  });
});

describe("lookAt", () => {
  const looks = [
    { image: "slime.png", label: "Слизь", kind: "обычный", from: 1 },
    { image: "shizu.png", label: "Облик Сидзу", kind: "форма", from: 8 },
    { image: null, label: "Без картинки", kind: "форма", from: 9 },
  ];
  it("облик на серию — последний к ней, с картинкой", () => {
    expect(lookAt(looks, 3)?.label).toBe("Слизь");
    expect(lookAt(looks, 10)?.label).toBe("Облик Сидзу");
    expect(lookAt(looks, 0)).toBeNull();
  });
});

describe("sameName", () => {
  it("порядок слов и японские точки не важны", () => {
    expect(sameName("Tempest Rimuru", "Rimuru Tempest")).toBe(true);
    expect(sameName("リムル・テンペスト", "リムル テンペスト")).toBe(true);
    expect(sameName("Reiner Braun", "Armored Titan")).toBe(false);
  });
});

describe("linkNames", () => {
  const refs = [{ alias: "Вельдора", entity: 1 }, { alias: "Римуру", entity: 2 }, { alias: "Сатору Миками", entity: 3 }, { alias: "Сатору", entity: 4 }];
  it("склонения, длинные имена раньше коротких", () => {
    const parts = linkNames("Сатору Миками получает от Вельдоры имя Римуру.", refs);
    expect(parts.filter((p) => typeof p !== "string")).toEqual([
      { text: "Сатору Миками", entity: 3 }, { text: "Вельдоры", entity: 1 }, { text: "Римуру", entity: 2 },
    ]);
    expect(parts.map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe("Сатору Миками получает от Вельдоры имя Римуру.");
  });
  it("не внутри слова и не при совпадении у двух персонажей", () => {
    expect(linkNames("Римурушка", refs)).toEqual(["Римурушка"]);
    expect(linkNames("Ранга пришёл", [{ alias: "Ранга", entity: 1 }, { alias: "Ранга", entity: 2 }])).toEqual(["Ранга пришёл"]);
  });
});
