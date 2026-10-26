import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_PRICES, isPeak, priceOf } from "./llm-pricing";

const at = (h: number) => new Date(Date.UTC(2026, 9, 26, h, 30));

describe("цены внешней LLM", () => {
  it("пиковые часы по UTC: 01–04 и 06–10", () => {
    expect([0, 1, 3, 4, 5, 6, 9, 10, 23].map((h) => isPeak(at(h)))).toEqual([false, true, true, false, false, true, true, false, false]);
  });

  it("стоимость: вход, кэш, выход; вне пика — половина", () => {
    const prices = { m: { in: 1, hit: 0.1, out: 2 } };
    const u = { prompt: 1_000_000, cacheHit: 400_000, completion: 500_000 };
    // 0.6M × 1 + 0.4M × 0.1 + 0.5M × 2 = 1.64
    expect(costUsd("m", u, at(2), prices)).toBeCloseTo(1.64);
    expect(costUsd("m", u, at(12), prices)).toBeCloseTo(0.82);
  });

  it("незнакомая модель — по самой дорогой цене", () => {
    expect(priceOf("??", DEFAULT_PRICES)).toEqual(DEFAULT_PRICES["deepseek-v4-pro"]);
  });

  it("попаданий в кэш не больше, чем токенов входа", () => {
    expect(costUsd("m", { prompt: 100, cacheHit: 500, completion: 0 }, at(2), { m: { in: 1, hit: 0, out: 0 } })).toBe(0);
  });
});
