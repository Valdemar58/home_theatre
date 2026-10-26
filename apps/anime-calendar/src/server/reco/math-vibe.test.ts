import { describe, expect, it } from "vitest";
import { hybridScore, titleSimilarity } from "./math";

describe("ощущение по разбору LLM в формулах", () => {
  it("без разбора — прежние веса", () => {
    expect(hybridScore({ similarity: 0.8, tags: 0.6, community: 0.5, quality: 0.4 })).toBe(Math.round((0.45 * 0.8 + 0.25 * 0.6 + 0.2 * 0.5 + 0.1 * 0.4) * 100));
    expect(titleSimilarity({ tags: 0.4, genres: 0.5, community: 0.2 })).toBe(Math.round(Math.min(1, (0.5 * 0.4 + 0.35 * 0.2 + 0.15 * 0.5) / 0.6) * 100));
  });

  it("с разбором — ощущение двигает балл в нужную сторону и не выводит за 0–100", () => {
    const parts = { similarity: 0.5, tags: 0.5, community: 0.5, quality: 0.5 };
    expect(hybridScore({ ...parts, vibe: 1 })).toBeGreaterThan(hybridScore({ ...parts, vibe: 0 }));
    expect(hybridScore({ similarity: 1, tags: 1, community: 1, quality: 1, vibe: 1 })).toBe(100);
    expect(titleSimilarity({ tags: 0.3, genres: 0.3, community: 0.1, vibe: 0.9 })).toBeGreaterThan(titleSimilarity({ tags: 0.3, genres: 0.3, community: 0.1, vibe: 0.1 }));
  });
});
