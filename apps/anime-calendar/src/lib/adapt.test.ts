import { describe, expect, it } from "vitest";
import { adaptLabel, continueAfter, parseAdaptation, seasonRange } from "./adapt";

const box = (field: string) => `{{Infobox episode\n|season = 1\n|episode = 2\n${field}\n|airdate = October 9, 2018\n}}\nТекст`;

describe("адаптация по инфобоксу", () => {
  it("том из поля adaptation, ссылки вики убраны", () => {
    expect(parseAdaptation(box("|adaptation = Volume 1: [[Empowerment]]"))).toEqual({ form: null, vols: [1], chs: [] });
  });
  it("главы манги диапазоном", () => {
    expect(parseAdaptation(box("|manga chapters = Chapters 5-7"))).toEqual({ form: "manga", vols: [], chs: [5, 6, 7] });
  });
  it("без полей адаптации — null", () => {
    expect(parseAdaptation(box("|opening = Nameless story"))).toBeNull();
  });
  it("сезон: тома 1–4, форма — по первоисточнику", () => {
    const eps = [box("|adaptation = Volume 1"), box("|adaptation = Volume 2"), box("|adaptation = Volumes 3–4"), box("|opening = x")].map(parseAdaptation);
    const r = seasonRange(eps, "novel");
    expect(r).toEqual({ form: "novel", unit: "vol", from: 1, to: 4 });
    expect(adaptLabel(r!)).toBe("ранобэ, тома 1–4");
  });
  it("дальше аниме — со следующего тома", () => {
    expect(continueAfter([{ form: "novel", unit: "vol", to: 4 }, { form: "novel", unit: "vol", to: 7 }], "novel")).toEqual({ unit: "vol", from: 8 });
    expect(continueAfter([{ form: "manga", unit: "ch", to: 38 }], "novel")).toBeNull();
  });
});
