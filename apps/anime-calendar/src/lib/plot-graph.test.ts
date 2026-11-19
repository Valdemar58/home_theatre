import { describe, expect, it } from "vitest";
import { aliasLook, foldGraph, graphForPrompt, identityGroups, isProperName, linkNames, lookAt, sameName, type GraphDelta } from "./plot-graph";

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
      { text: "Сатору Миками", entity: 3, alias: "сатору миками" }, { text: "Вельдоры", entity: 1, alias: "вельдора" }, { text: "Римуру", entity: 2, alias: "римуру" },
    ]);
    expect(parts.map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe("Сатору Миками получает от Вельдоры имя Римуру.");
  });
  it("не внутри слова и не при совпадении у двух персонажей", () => {
    expect(linkNames("Римурушка", refs)).toEqual(["Римурушка"]);
    expect(linkNames("Ранга пришёл", [{ alias: "Ранга", entity: 1 }, { alias: "Ранга", entity: 2 }])).toEqual(["Ранга пришёл"]);
  });
});

describe("aliasLook", () => {
  const looks = [{ look: "slime", label: "Слизень" }, { look: "human-satoru", label: "Сатору Миками (прошлая жизнь)" }, { look: "human-shizu", label: "Человеческий облик" }];
  it("имя прошлой жизни и название облика — к своему облику, обычное имя — ни к какому", () => {
    expect(aliasLook("Сатору Миками", null, looks)).toBe("human-satoru");
    expect(aliasLook("слизень", null, looks)).toBe("slime");
    expect(aliasLook("Римуру Темпест", null, looks)).toBeNull();
    expect(aliasLook("Римуру", "human-shizu", looks)).toBe("human-shizu");
  });
});

describe("linkNames: находки пользователя", () => {
  const links = (text: string, refs: { alias: string; entity: number }[]) =>
    linkNames(text, refs).filter((p) => typeof p !== "string").map((p) => (p as { text: string; entity: number }).text);
  it("разное написание японского имени: си/ши, дз/з, е/э, удвоенные согласные", () => {
    const refs = [{ alias: "Сидзуэ Идзава", entity: 1 }, { alias: "Клэйман", entity: 2 }, { alias: "Карион", entity: 3 }, { alias: "Фрей", entity: 4 }];
    expect(links("привела призванная в этот мир Шизуэ Изава", refs)).toEqual(["Шизуэ Изава"]);
    expect(links("Клейман, Каррион, Фрей", refs)).toEqual(["Клейман", "Каррион", "Фрей"]);
  });
  it("слово внутри составного названия — не имя", () => {
    expect(links("Федерация Джура-Темпест растёт", [{ alias: "Темпест", entity: 1 }])).toEqual([]);
  });
  it("первое упоминание в абзаце, в новом абзаце — снова", () => {
    const refs = [{ alias: "Римуру", entity: 1 }];
    expect(links("Римуру ушёл. Римуру вернулся.\n\nРимуру спит.", refs)).toEqual(["Римуру", "Римуру"]);
  });
  it("два имени одного персонажа подряд — одна ссылка", () => {
    expect(links("Дриада Трейни пришла", [{ alias: "Дриада", entity: 7 }, { alias: "Трейни", entity: 7 }])).toEqual(["Дриада Трейни"]);
  });
  it("собственное имя — с большой буквы", () => {
    expect(isProperName("слизень")).toBe(false);
    expect(isProperName("дракон бури")).toBe(false);
    expect(isProperName("Орк-лорд")).toBe(true);
  });
});

describe("ringLayout", () => {
  it("ближний круг, союзники, враги; не связанные — скрыты", async () => {
    const { ringLayout } = await import("./relation-layout");
    const nodes = [1, 2, 3, 4, 5, 6].map((id) => ({ id, groups: [] }));
    const edges = [
      { a: 2, b: 1, kind: "служит", endedEp: null }, { a: 1, b: 3, kind: "союзник", endedEp: null },
      { a: 1, b: 4, kind: "враг", endedEp: null }, { a: 2, b: 5, kind: "друг", endedEp: null },
    ];
    const r = ringLayout(1, nodes, edges);
    expect([1, 2, 3, 4, 5, 6].map((id) => r.get(id)!.ring)).toEqual([0, 1, 2, 3, 2, null]);
  });
});

describe("laneLayout и chainLayout", () => {
  const ev = (key: string, ep: number, ids: number[], causes: string[] = []) => ({
    key, epFrom: ep, epTo: ep, participants: ids.map((id) => ({ id, name: `p${id}` })), causes: causes.map((k) => ({ key: k })), consequences: [] as { key: string }[],
  });
  it("событие — на дорожку самого узкого участника, совпавшие по серии — в разные ряды", async () => {
    const { laneLayout } = await import("./event-layout");
    const { lanes, items } = laneLayout([ev("a", 1, [1]), ev("b", 1, [1, 2]), ev("c", 2, [1]), ev("d", 2, [1, 2]), ev("e", 3, [1])]);
    expect(lanes.map((l) => l.id)).toEqual([1, 2]);
    expect(items.find((i) => i.key === "b")!.lane).toBe(1);
    expect(items.find((i) => i.key === "a")!.lane).toBe(0);
  });
  it("цепочка: причины слева по шагам", async () => {
    const { chainLayout } = await import("./event-layout");
    const cells = chainLayout([ev("a", 1, []), ev("b", 2, [], ["a"]), ev("c", 3, [], ["b"])], "c");
    expect(cells.map((c) => [c.key, c.col])).toEqual([["a", -2], ["b", -1], ["c", 0]]);
  });
});

describe("linkNames: регистр", () => {
  it("имя с большой буквы не ловит нарицательное слово в тексте", () => {
    const parts = linkNames("Римуру зовёт официантку. Официантка улыбается.", [{ alias: "Официантка", entity: 1 }]);
    expect(parts.filter((p) => typeof p !== "string").map((p) => (p as { text: string }).text)).toEqual(["Официантка"]);
  });
});

describe("метки говорящих", () => {
  it("толпа и безымянные — не персонажи", async () => {
    const { isCrowdLabel } = await import("./speakers");
    expect(["部下", "オークたち", "エルフＡ", "男", "村人2"].every(isCrowdLabel)).toBe(true);
    expect(["三上", "リムル", "ガゼル", "通り魔"].some(isCrowdLabel)).toBe(false);
  });
  it("строкой по японскому имени, проверка по сериям", async () => {
    const { matchByName, consistent } = await import("./speakers");
    const people = [{ id: 1, names: ["リムル＝テンペスト"], firstEp: 1 }, { id: 29, names: ["ガゼル・ドワルゴ"], firstEp: 5 }, { id: 35, names: ["ケンヤ"], firstEp: 20 }];
    expect(matchByName("ガゼル", people)).toEqual([29]);
    expect(matchByName("リムル", people)).toEqual([1]);
    expect(matchByName("三上", people)).toEqual([]);
    expect(consistent(1, people[2])).toBe(false);
  });
});

// Эталон из «Слизи»: два Гельда (отец съеден Римуру, сын получил имя в его память), безымянный генерал, «Орк-лорд»
describe("Гельды: тёзки, имя позже первого появления", () => {
  it("лента имён: генерал орков до серии, где ему дали имя", () => {
    const g = foldGraph([
      { eps: [13, 14, 15], delta: delta({
        personas: [{ ...persona("orc-general", 13, "Гельд"), name_before_ru: "Генерал орков" }],
        aliases: [{ key: "orc-general", alias: "Гельд", kind: "имя", who_ru: "", ep: 15 }],
      }) },
    ]);
    expect(g.names).toEqual([
      { key: "orc-general", name_ru: "Генерал орков", from: 13, title: 0 },
      { key: "orc-general", name_ru: "Гельд", from: 15, title: 0 },
    ]);
  });
  it("полное имя узнано, когда прозвучало его начало; прошлое имя — не серия раскрытия", () => {
    const g = foldGraph([
      { eps: [1, 2, 3, 4], delta: delta({
        personas: [{ ...persona("rimuru", 1, "Римуру Темпест"), name_before_ru: "Сатору Миками" }],
        aliases: [{ key: "rimuru", alias: "Римуру", kind: "имя", who_ru: "", ep: 2 }, { key: "rimuru", alias: "Сатору Миками", kind: "имя", who_ru: "", ep: 1 }],
      }) },
    ]);
    expect(g.names.map((n) => [n.name_ru, n.from])).toEqual([["Сатору Миками", 1], ["Римуру Темпест", 2]]);
  });
  it("серия имени от модели — раньше конца порции (Ригурд назван в 3 серии)", () => {
    const g = foldGraph([
      { eps: [1, 2, 3, 4], delta: delta({ personas: [{ ...persona("rigurd", 2, "Ригурд"), name_before_ru: "староста гоблинов", name_ep: 3 }] }) },
    ]);
    expect(g.names.map((n) => [n.name_ru, n.from])).toEqual([["староста гоблинов", 2], ["Ригурд", 3]]);
  });
  it("смена имени в следующей порции без серии в aliases — с конца порции; то же имя — без новой строки", () => {
    const g = foldGraph([
      { eps: [10, 11], delta: delta({ personas: [persona("orc-lord", 10, "Орк-лорд")] }) },
      { eps: [12, 13, 14], delta: delta({ personas: [persona("orc-lord", 10, "Гельд")] }) },
      { eps: [15], delta: delta({ personas: [persona("orc-lord", 10, "Гельд")] }) },
    ]);
    expect(g.names.map((n) => [n.name_ru, n.from])).toEqual([["Орк-лорд", 10], ["Гельд", 14]]);
  });
  it("двое «Geld» в AniList — спорно, однозначные — сразу", async () => {
    const { anilistCandidates } = await import("./plot-graph");
    const chars = [
      { id: 133522, name: "Geld", native: "ゲルド", nameRu: "Гельд" },
      { id: 302556, name: "Geld", native: "ゲルド", nameRu: "Гельд" },
      { id: 1, name: "Rimuru Tempest", native: null, nameRu: "Римуру Темпест" },
    ];
    const { sure, open } = anilistCandidates([persona("geld", 8, "Geld"), persona("orc-general", 13, "Geld"), persona("rimuru", 1, "Rimuru Tempest")], chars);
    expect([...sure]).toEqual([["rimuru", 1]]);
    expect([...open.keys()]).toEqual(["geld", "orc-general"]);
    expect(open.get("geld")!.map((c) => c.id)).toEqual([133522, 302556]);
  });
  it("один персонаж AniList на двоих в графе — тоже спорно", async () => {
    const { anilistCandidates } = await import("./plot-graph");
    const { sure, open } = anilistCandidates([persona("geld", 8, "Geld"), persona("geld-son", 13, "Geld")], [{ id: 133522, name: "Geld", native: null, nameRu: null }]);
    expect(sure.size).toBe(0);
    expect(open.size).toBe(2);
  });
});

describe("места", () => {
  it("ключи мест отдельно от персонажей, вложенность, переименование, место события и связи", () => {
    const g = foldGraph([
      { eps: [1, 2, 3], delta: delta({
        personas: [persona("tempest", 1, "Темпест")],
        places: [
          { key: "jura-forest", name_ru: "Лес Джура", name_en: "Great Jura Forest", kind: "лес", inside: "", first_ep: 1, description_ru: "Огромный лес" },
          { key: "goblin-village", name_ru: "Деревня гоблинов", name_en: "Goblin village", kind: "деревня", inside: "jura-forest", first_ep: 2, description_ru: "" },
        ],
        place_links: [{ a: "dwargon", b: "jura-forest", kind: "к северу от", distance_ru: "", ep: 3 }],
        events: [{ key: "wolves", title_ru: "Волки нападают", summary_ru: "", course_ru: "", kind: "бой", major: true, ep_from: 3, ep_to: 3, arc_ru: "", participants: [], where: "goblin-village" }],
      }) },
      { eps: [4, 5, 6], delta: delta({
        places: [
          { key: "goblin-village", name_ru: "Темпест", name_en: "Tempest", kind: "город", inside: "jura-forest", first_ep: 2, description_ru: "Город монстров", name_ep: 5 },
          { key: "dwargon", name_ru: "Дварфарго", name_en: "Dwargon", kind: "страна", inside: "", first_ep: 4, description_ru: "" },
        ],
        place_links: [{ a: "dwargon", b: "jura-forest", kind: "к северу от", distance_ru: "три дня", ep: 4 }],
      }) },
    ]);
    expect([...g.places.keys()].sort()).toEqual(["place-dwargon", "place-goblin-village", "place-jura-forest"]);
    expect(g.personas.has("tempest")).toBe(true);
    expect(g.places.get("place-goblin-village")).toMatchObject({ inside: "place-jura-forest", first_ep: 2 });
    expect(g.names.filter((n) => n.key === "place-goblin-village").map((n) => [n.name_ru, n.from])).toEqual([["Деревня гоблинов", 2], ["Темпест", 5]]);
    expect(g.events.get("wolves")?.where).toBe("place-goblin-village");
    // Связь на ещё не известное место (Дварфарго в 3 серии) не записывается; потом — один раз
    expect(g.placeLinks).toHaveLength(1);
    expect(g.placeLinks[0]).toMatchObject({ a: "place-dwargon", b: "place-jura-forest", revealed: 4 });
  });
});
