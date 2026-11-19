import { describe, expect, it } from "vitest";
import { applyEdits, editProblem, type PlotEdit } from "./plot-edits";
import { emptyGraph, type GPersona, type Graph } from "./plot-graph";

const persona = (key: string, name: string, first = 1): GPersona & { revealed: number; title: number } => ({
  key, kind: "персонаж", importance: "второй план", name_ru: name, name_en: "", name_ja: "", description_ru: "", goal_ru: "", first_ep: first, revealed: first, title: 10,
});

function graph(): Graph {
  const g = emptyGraph();
  g.upTo = 12;
  for (const p of [persona("geld", "Гельд"), persona("orc-general", "Генерал орков", 3), persona("gobta", "Гобта")]) g.personas.set(p.key, p);
  g.names.push({ key: "orc-general", name_ru: "Генерал орков", from: 3, title: 10 }, { key: "orc-general", name_ru: "Гельд", from: 9, title: 10 });
  g.notes.push(
    { key: "gobta", from: 1, upTo: 4, description_ru: "гоблин", goal_ru: "", title: 10 },
    { key: "gobta", from: 5, upTo: 8, description_ru: "хобгоблин", goal_ru: "", title: 10 },
  );
  g.identities.push({ a: "geld", b: "gobta", ep: 6, note_ru: "", revealed: 6, title: 10 });
  return g;
}

const edit = <E extends PlotEdit>(e: Omit<E, "anilistId"> & { anilistId?: number }) => ({ anilistId: 10, ...e }) as E;

describe("applyEdits", () => {
  it("одно лицо и разделение — и в графе, и в склейках сверки", () => {
    const g = graph();
    const same = [{ a: "orc-general", b: "gobta", ep: 9, note_ru: "", revealed: 9, title: 10 }];
    const r = applyEdits(g, [
      edit({ id: 1, key: "geld", kind: "split", data: { other: "gobta" }, fromEp: 0 }),
      edit({ id: 2, key: "gobta", kind: "split", data: { other: "orc-general" }, fromEp: 0 }),
      edit({ id: 3, key: "orc-general", kind: "same", data: { other: "geld" }, fromEp: 9 }),
    ], same, new Map());
    expect(g.identities.map((i) => [i.a, i.b, i.revealed])).toEqual([["orc-general", "geld", 9]]);
    expect(r.same).toEqual([]);
  });

  it("неизвестный ключ и склейка с самим собой — пропуск", () => {
    const g = graph();
    applyEdits(g, [edit({ id: 1, key: "nobody", kind: "name", data: { name: "X" }, fromEp: 1 }), edit({ id: 2, key: "geld", kind: "same", data: { other: "geld" }, fromEp: 1 })], [], new Map());
    expect(g.identities).toHaveLength(1);
    expect(g.names).toHaveLength(2);
  });

  it("имя с серии: та же серия заменяется, последнее — основное имя", () => {
    const g = graph();
    applyEdits(g, [edit({ id: 1, key: "orc-general", kind: "name", data: { name: "Гельд-сын" }, fromEp: 9 })], [], new Map());
    expect(g.names.filter((n) => n.key === "orc-general").map((n) => [n.name_ru, n.from])).toEqual([["Генерал орков", 3], ["Гельд-сын", 9]]);
    expect(g.personas.get("orc-general")!.name_ru).toBe("Гельд-сын");
    // Имя раньше последней смены — основное имя не трогает
    applyEdits(g, [edit({ id: 2, key: "orc-general", kind: "name", data: { name: "Орк" }, fromEp: 3 })], [], new Map());
    expect(g.personas.get("orc-general")!.name_ru).toBe("Гельд-сын");
  });

  it("описание с серии вытесняет описания модели с этой серии", () => {
    const g = graph();
    applyEdits(g, [edit({ id: 1, key: "gobta", kind: "note", data: { description: "наездник волка" }, fromEp: 6 })], [], new Map());
    expect(g.notes.filter((n) => n.key === "gobta").map((n) => [n.description_ru, n.upTo])).toEqual([["гоблин", 4], ["наездник волка", 6]]);
  });

  it("AniList: поздняя правка главнее, 0 — не связан", () => {
    const r = applyEdits(graph(), [
      edit({ id: 2, key: "geld", kind: "anilist", data: { charId: 0 }, fromEp: 0 }),
      edit({ id: 1, key: "geld", kind: "anilist", data: { charId: 555 }, fromEp: 0 }),
    ], [], new Map([["gobta", 7]]));
    expect([...r.anilist]).toEqual([["gobta", 7], ["geld", 0]]);
  });
});

describe("editProblem", () => {
  it("проверка ввода", () => {
    expect(editProblem("name", { name: "Римуру" }, 3)).toBeNull();
    expect(editProblem("name", { name: " " }, 3)).toMatch(/имя/);
    expect(editProblem("image", { url: "http://x" }, 1)).toMatch(/https/);
    expect(editProblem("anilist", { charId: 0 }, 0)).toBeNull();
    expect(editProblem("note", { description: "x" }, -1)).toMatch(/Серия/);
    expect(editProblem("drop", {}, 0)).toMatch(/вид/);
  });
});
