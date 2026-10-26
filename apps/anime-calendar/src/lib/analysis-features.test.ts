import { describe, expect, it } from "vitest";
import { analysisFeatures, featureAffinity, featureScore, topTraits, vibeSimilarity, type AnalysisLike } from "./analysis-features";

const base: AnalysisLike = {
  tone: "комедийный", humor: ["пародия", "абсурдный"], pacing: "быстрый", themes: ["Дружба", "исекай"],
  emotional_intensity: 2, complexity: 2, so_bad_its_good: 3, voice_dependence: 4,
};
const parody = analysisFeatures(base);
const comedy = analysisFeatures({ ...base, humor: ["абсурдный", "ситуационный"], themes: ["школа"] });
const drama = analysisFeatures({ ...base, tone: "мрачный", humor: ["нет"], pacing: "медленный", emotional_intensity: 5, complexity: 5, themes: ["война"] });

describe("признаки разбора LLM", () => {
  it("категории — по одному признаку, шкалы — вокруг середины, «нет» и тройки не учитываются", () => {
    expect(parody.get("tone:комедийный")).toBe(1);
    expect(parody.get("humor:пародия")).toBe(1);
    expect(drama.has("humor:нет")).toBe(false);
    expect(parody.get("scale:complexity")).toBe(-0.5);
    expect(parody.has("scale:sobad")).toBe(false);
    expect(parody.get("theme:дружба")).toBe(0.5);
  });

  it("склейка тем-синонимов", () => {
    const f = analysisFeatures({ ...base, themes: ["Сила дружбы"] }, (t) => (t === "сила дружбы" ? "дружба" : t));
    expect(f.has("theme:дружба")).toBe(true);
  });

  it("пародия ближе к комедии, чем к мрачной драме", () => {
    expect(vibeSimilarity(parody, comedy)).toBeGreaterThan(vibeSimilarity(parody, drama));
    expect(vibeSimilarity(parody, parody)).toBeCloseTo(1);
  });

  it("склонности: любит комедии, бросает мрачное → комедия выше драмы", () => {
    const aff = featureAffinity([{ weight: 1.5, f: parody }, { weight: -1, f: drama }, { weight: 0.5, f: null }]);
    expect(featureScore(comedy, aff)).toBeGreaterThan(0);
    expect(featureScore(drama, aff)).toBeLessThan(0);
    expect(topTraits(comedy, aff, 3, 1)).toContain("комедийный тон");
    expect(topTraits(drama, aff, 3, -1)).toContain("мрачный тон");
  });
});
