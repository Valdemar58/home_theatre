import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "knowledge-"));

// Модель подменяется: какой ранг доступен сейчас и что она ответит
const route = { tier: 1 };
const answers: { value: unknown; tier: number; model: string }[] = [];
vi.mock("./llm", () => {
  class LlmUnavailable extends Error {}
  return {
    LlmUnavailable,
    bestRouteTier: async () => route.tier,
    runTask: vi.fn(async (_task: string, req: { minTier?: number }) => {
      if (!route.tier || route.tier < (req.minTier ?? 0)) throw new LlmUnavailable("нет");
      const a = answers.shift()!;
      return { ...a, provider: a.tier > 1 ? "external" : "ollama", usage: { prompt: 1, cacheHit: 0, completion: 1 }, costUsd: 0, usageId: null };
    }),
  };
});

const { db, migrateLlmOutputs } = await import("./db");
const { bestOutput, produce } = await import("./knowledge");
const { saveLlmConfig, resetLlmConfig } = await import("./llm-config");

const spec = (inputHash: string) => ({
  inputHash, policy: "tier-first" as const, staleOk: true, schemaV: 1, promptV: 1,
  schema: { type: "object" as const }, system: "s", user: () => "u",
});

beforeEach(() => {
  db.exec("DELETE FROM llm_output");
  resetLlmConfig();
  answers.length = 0;
});

describe("знания от LLM", () => {
  it("первый результат сохраняется; повторно по тому же входу модель не зовётся", async () => {
    route.tier = 1;
    answers.push({ value: { x: "local" }, tier: 1, model: "qwen" });
    expect((await produce<{ x: string }>("analysis", "anime:1", spec("h1")))?.value).toEqual({ x: "local" });
    expect((await produce<{ x: string }>("analysis", "anime:1", spec("h1")))?.value).toEqual({ x: "local" });
    expect(answers.length).toBe(0);
  });

  it("результат умной модели не переделывается локальной, даже когда вход изменился", async () => {
    route.tier = 3;
    answers.push({ value: { x: "pro" }, tier: 3, model: "pro" });
    await produce("analysis", "anime:2", spec("old"));
    route.tier = 1;
    const k = await produce<{ x: string }>("analysis", "anime:2", spec("new"));
    expect(k).toMatchObject({ value: { x: "pro" }, fresh: false });
  });

  it("улучшение — только с флагом; худший ответ остаётся в истории, но текущим не становится", async () => {
    route.tier = 1;
    answers.push({ value: { x: "local" }, tier: 1, model: "qwen" });
    await produce("analysis", "anime:3", spec("h"));
    route.tier = 3;
    expect((await produce<{ x: string }>("analysis", "anime:3", spec("h")))?.value).toEqual({ x: "local" });
    saveLlmConfig({ upgrade: { analysis: true } });
    answers.push({ value: { x: "pro" }, tier: 3, model: "pro" });
    expect((await produce<{ x: string }>("analysis", "anime:3", spec("h")))?.value).toEqual({ x: "pro" });
    const n = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM llm_output WHERE subject = 'anime:3'").get()!.n;
    expect(n).toBe(2);
  });

  it("ИИ недоступен — отдаётся лучшее известное", async () => {
    route.tier = 1;
    answers.push({ value: { x: "local" }, tier: 1, model: "qwen" });
    await produce("analysis", "anime:4", spec("h"));
    route.tier = 0;
    expect((await produce<{ x: string }>("analysis", "anime:4", spec("other")))?.value).toEqual({ x: "local" });
    expect(bestOutput("analysis", "anime:5", { policy: "tier-first", staleOk: true })).toBeNull();
  });

  it("перенос старых разборов в журнал — один раз, с провенансом и сохранением эмбеддинга", () => {
    db.prepare(`INSERT INTO anime_profile (anilist_id, data, analysis, analysis_v, embedding, embed_v, updated_at)
      VALUES (77, '{}', '{"summary_ru":"s","tone":"лёгкий"}', 1, NULL, 'bge-m3:1', 1)`).run();
    migrateLlmOutputs(db);
    migrateLlmOutputs(db);
    const rows = db.prepare<[], { id: number; provider: string }>("SELECT id, provider FROM llm_output WHERE task = 'analysis' AND subject = 'anime:77'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("legacy");
    const p = db.prepare<[], { analysis_src: number; embed_v: string }>("SELECT analysis_src, embed_v FROM anime_profile WHERE anilist_id = 77").get()!;
    expect(p).toEqual({ analysis_src: rows[0].id, embed_v: `bge-m3:a${rows[0].id}` });
  });
});
