import { describe, expect, it } from "vitest";
import { deepGlossary, planBatches, stateAt, type DeepState } from "./plot-deep";

const eps = (n: number, chars = 1000) => Array.from({ length: n }, (_, i) => ({ ep: i + 1, chars }));

describe("planBatches", () => {
  it("по 4 серии от первой", () => {
    expect(planBatches(eps(10))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
  });

  it("новая серия онгоинга меняет только последнюю порцию", () => {
    const a = planBatches(eps(9));
    const b = planBatches(eps(10));
    expect(b.slice(0, -1)).toEqual(a.slice(0, -1));
  });

  it("длинные пересказы — меньше серий в порции, очень длинная — одна", () => {
    expect(planBatches([{ ep: 1, chars: 12_000 }, { ep: 2, chars: 12_000 }, { ep: 3, chars: 12_000 }, { ep: 4, chars: 40_000 }, { ep: 5, chars: 500 }]))
      .toEqual([[1, 2], [3], [4], [5]]);
  });

  it("порядок — по номеру серии, пропуски не мешают", () => {
    expect(planBatches([{ ep: 3, chars: 1 }, { ep: 1, chars: 1 }, { ep: 7, chars: 1 }])).toEqual([[1, 3, 7]]);
  });
});

const st = (upTo: number, beats: Record<number, string>): DeepState =>
  ({ upTo, retelling_ru: `до ${upTo}`, ending_state_ru: "", arcs: [], characters: [], glossary: [], beats });

describe("stateAt", () => {
  const states = [st(4, { 1: "a", 2: "b", 3: "c", 4: "d" }), st(8, { 5: "e", 6: "f", 7: "g", 8: "h" })];

  it("состояние — последней целиком просмотренной порции, серии — до курсора", () => {
    const r = stateAt(states, 6);
    expect(r.state?.upTo).toBe(4);
    expect(Object.keys(r.beats).map(Number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("до конца первой порции пересказа нет", () => {
    expect(stateAt(states, 3).state).toBeNull();
    expect(stateAt(states, 0).beats).toEqual({});
  });

  it("весь сезон", () => {
    expect(stateAt(states, Infinity).state?.upTo).toBe(8);
  });
});

describe("deepGlossary", () => {
  it("имена и термины для перевода", () => {
    expect(deepGlossary({
      characters: [{ name_ru: "Субару", name_en: "Subaru Natsuki", name_ja: "ナツキ・スバル", role_ru: "" }],
      glossary: [{ term: "Return by Death", ru: "Возвращение смертью", kind: "навык" }, { term: "", ru: "x", kind: "другое" }],
    })).toEqual([
      { names: ["Subaru Natsuki", "ナツキ・スバル"], ru: "Субару" },
      { names: ["Return by Death"], ru: "Возвращение смертью" },
    ]);
  });
});
