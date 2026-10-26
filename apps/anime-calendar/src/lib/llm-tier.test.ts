import { describe, expect, it } from "vitest";
import { pickBest, shouldRun, tierOf, TIER } from "./llm-tier";

const row = (tier: number, createdAt: number, inputHash: string) => ({ tier, createdAt, inputHash });

describe("лучший результат LLM", () => {
  it("ранг источника", () => {
    const s = { cheap: "flash", smart: "pro" };
    expect([tierOf("ollama", "qwen", s), tierOf("external", "flash", s), tierOf("external", "pro", s), tierOf("tmdb", "", s)])
      .toEqual([TIER.local, TIER.cheap, TIER.smart, TIER.tmdb]);
  });

  it("tier-first: устаревший разбор умной модели важнее свежего локального", () => {
    const rows = [row(3, 1, "old"), row(1, 5, "new")];
    expect(pickBest(rows, { inputHash: "new", policy: "tier-first", staleOk: true })).toEqual({ row: rows[0], fresh: false });
  });

  it("fresh-first: свежий любой ранг, иначе последний хороший; staleOk=false — только свежие", () => {
    const rows = [row(3, 1, "old"), row(1, 5, "new"), row(2, 3, "old")];
    expect(pickBest(rows, { inputHash: "new", policy: "fresh-first", staleOk: true })?.row).toBe(rows[1]);
    expect(pickBest(rows, { inputHash: "x", policy: "fresh-first", staleOk: true })?.row).toBe(rows[1]);
    expect(pickBest(rows, { inputHash: "x", policy: "fresh-first", staleOk: false })).toBeNull();
  });

  it("пустой хэш (перенесённые данные) считается свежим", () => {
    expect(pickBest([row(1, 1, "")], { inputHash: "h", policy: "tier-first", staleOk: false })?.fresh).toBe(true);
  });

  it("когда звать модель", () => {
    const t = { policy: "tier-first" as const, upgrade: false };
    expect(shouldRun(null, 1, t)).toBe(true);
    expect(shouldRun(null, 0, t)).toBe(false);
    // Локальная модель не переделывает устаревший разбор умной
    expect(shouldRun({ tier: 3, fresh: false }, 1, t)).toBe(false);
    expect(shouldRun({ tier: 1, fresh: false }, 1, t)).toBe(true);
    // Улучшение свежего результата — только с флагом и моделью сильнее
    expect(shouldRun({ tier: 1, fresh: true }, 3, t)).toBe(false);
    expect(shouldRun({ tier: 1, fresh: true }, 3, { ...t, upgrade: true })).toBe(true);
    expect(shouldRun({ tier: 3, fresh: true }, 3, { ...t, upgrade: true })).toBe(false);
    // Портрету нужен свежий — переделывается любой доступной моделью
    expect(shouldRun({ tier: 3, fresh: false }, 1, { policy: "fresh-first", upgrade: false })).toBe(true);
  });
});
