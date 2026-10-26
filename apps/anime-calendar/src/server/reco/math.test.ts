import { describe, expect, it } from "vitest";
import { communityScore, cosine, entryWeight, hybridScore, meanScore, similarityIdf, sparseCosine, tagAffinity, tagScore, tagVector, tasteVector, titleSimilarity, type TasteEntry } from "./math";

describe("entryWeight: «рекомендую»", () => {
  it("явное «рекомендую» поднимает вес, «не рекомендую» — опускает", () => {
    const base = entryWeight(e({ score: 7 }), 7);
    expect(entryWeight(e({ score: 7, recommend: true }), 7)).toBeGreaterThan(base);
    expect(entryWeight(e({ score: 7, recommend: false }), 7)).toBeLessThan(base);
    expect(entryWeight(e({ score: 7, recommend: null }), 7)).toBe(base);
  });
});

const e = (over: Partial<TasteEntry>): TasteEntry => ({ status: "completed", score: 0, episodes: 12, totalEpisodes: 12, tags: [], ...over });

describe("entryWeight", () => {
  it("оценки центрируются по средней пользователя", () => {
    expect(entryWeight(e({ score: 9 }), 7)).toBeCloseTo(0.8);
    expect(entryWeight(e({ score: 5 }), 7)).toBeCloseTo(-0.8);
  });
  it("брошенное рано — сильнее отрицательно, чем брошенное под конец", () => {
    const early = entryWeight(e({ status: "dropped", episodes: 2, totalEpisodes: 24 }), 7);
    const late = entryWeight(e({ status: "dropped", episodes: 20, totalEpisodes: 24 }), 7);
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(0);
  });
  it("«так плохо, что смешно» делает низкую оценку положительным сигналом", () => {
    // «Торговый автомат»: оценка 6 при средней 7, но с личным тегом
    const w = entryWeight(e({ score: 6, tags: ["так плохо, что смешно", "озвучка решает"] }), 7);
    expect(w).toBeGreaterThan(0);
  });
  it("запланированное не влияет", () => {
    expect(entryWeight(e({ status: "planned" }), 7)).toBe(0);
  });
  it("средняя по оценённым, без оценок — 7", () => {
    expect(meanScore([e({ score: 8 }), e({ score: 6 }), e({})])).toBe(7);
    expect(meanScore([e({})])).toBe(7);
  });
});

describe("tasteVector", () => {
  it("тянется к любимому и отталкивается от нелюбимого", () => {
    const liked = [1, 0, 0];
    const disliked = [0, 1, 0];
    const v = tasteVector([{ weight: 1, embedding: liked }, { weight: -1, embedding: disliked }])!;
    expect(cosine(v, liked)).toBeGreaterThan(0.5);
    expect(cosine(v, disliked)).toBeLessThan(0);
  });
  it("без весов — null", () => {
    expect(tasteVector([{ weight: 0, embedding: [1, 2] }])).toBeNull();
  });
});

describe("теги", () => {
  const aff = tagAffinity([
    { weight: 1, tags: [{ name: "Parody", rank: 90 }, { name: "Isekai", rank: 80 }] },
    { weight: -1, tags: [{ name: "Tragedy", rank: 90 }] },
  ]);
  it("пародийный исекай ближе, чем трагедия", () => {
    expect(tagScore([{ name: "Parody", rank: 80 }], aff)).toBeGreaterThan(0);
    expect(tagScore([{ name: "Tragedy", rank: 80 }], aff)).toBeLessThan(0);
  });
});

describe("hybridScore", () => {
  it("0–100 с ограничением", () => {
    expect(hybridScore({ similarity: 1, tags: 1, community: 1, quality: 1 })).toBe(100);
    expect(hybridScore({ similarity: -1, tags: -1, community: 0, quality: 0 })).toBe(0);
    expect(hybridScore({ similarity: 0.8, tags: 0.4, community: 0.5, quality: 0.8 })).toBe(64);
  });
});

describe("похожесть тайтлов", () => {
  const base = [
    { tags: [{ name: "Parody", rank: 90 }, { name: "Isekai", rank: 90 }, { name: "Male Protagonist", rank: 85 }], genres: ["Comedy", "Fantasy"] },
    { tags: [{ name: "Parody", rank: 80 }, { name: "Male Protagonist", rank: 80 }], genres: ["Comedy"] },
    { tags: [{ name: "War", rank: 95 }, { name: "Male Protagonist", rank: 90 }], genres: ["Drama"] },
    ...Array.from({ length: 20 }, () => ({ tags: [{ name: "Male Protagonist", rank: 80 }], genres: ["Action"] })),
  ];
  const s = similarityIdf(base);
  it("общий редкий тег важнее общего частого", () => {
    const [a, b, c] = base.map((x) => tagVector(x.tags, s));
    expect(sparseCosine(a, b)).toBeGreaterThan(sparseCosine(a, c));
  });
  it("откровенные теги не учитываются", () => {
    expect(tagVector([{ name: "Nudity", rank: 90, category: "Sexual Content" }], s).size).toBe(0);
  });
  it("голоса сообщества — логарифм и в обе стороны", () => {
    const recsA = [{ id: 2, rating: 373 }, { id: 3, rating: 22 }];
    expect(communityScore(recsA, 1, null, 3)).toBeGreaterThan(0.5);
    expect(communityScore([], 1, [{ id: 1, rating: 10 }], 4)).toBe(1);
    expect(communityScore([], 1, null, 4)).toBe(0);
  });
  it("итог 0–100 с потолком", () => {
    expect(titleSimilarity({ tags: 1, genres: 1, community: 1 })).toBe(100);
    expect(titleSimilarity({ tags: 0, genres: 0, community: 0 })).toBe(0);
  });
});
