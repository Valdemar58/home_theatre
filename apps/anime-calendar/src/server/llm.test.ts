import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "llm-"));
process.env.OLLAMA_URL = "http://ollama.test";
process.env.DEEPSEEK_URL = "http://ext.test";
process.env.DEEPSEEK_API_KEY = "sk-test-1234";
process.env.LLM_EXTERNAL_TASKS = "recap:smart,rerank:cheap";
process.env.LLM_BUDGET_USD = "5";

// Подменный fetch: Ollama и внешний API отвечают по очередям заготовленных ответов
let ollamaUp = true;
const extQueue: (() => Response)[] = [];
const calls: string[] = [];
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const extAnswer = (content: string) => () => ok({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 300 },
});
vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  calls.push(url);
  if (url.endsWith("/api/tags")) return ok({ models: ollamaUp ? [{ name: "qwen3.5:9b" }, { name: "bge-m3:latest" }] : [] });
  if (url.endsWith("/api/chat")) return ok({ message: { content: '{"text":"локально"}' }, prompt_eval_count: 50, eval_count: 10 });
  if (url.endsWith("/chat/completions")) return (extQueue.shift() ?? (() => new Response("пусто", { status: 500 })))();
  throw new Error(`неожиданный запрос ${url}`);
}));

const { db } = await import("./db");
const { runTask, taskRoute, LlmUnavailable } = await import("./llm");
const { saveLlmConfig, resetLlmConfig } = await import("./llm-config");

const req = { schema: { type: "object" as const, properties: { text: { type: "string" as const } }, required: ["text"] }, system: "s", user: "u" };
const usageRows = () => db.prepare<[], { task: string; provider: string; ok: number; cost_usd: number; error: string | null }>(
  "SELECT task, provider, ok, cost_usd, error FROM llm_usage ORDER BY id").all();

beforeEach(() => {
  rmSync(path.join(process.env.DATA_DIR!, "feature-flags", "overrides.json"), { force: true });
  db.exec("DELETE FROM llm_usage");
  resetLlmConfig();
  extQueue.length = 0;
  calls.length = 0;
  ollamaUp = true;
});

describe("маршрутизация задач LLM", () => {
  it("отключение персонального ИИ блокирует провайдера, не затрагивая общие задачи", async () => {
    const directory = path.join(process.env.DATA_DIR!, "feature-flags");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "overrides.json"), JSON.stringify({ version: 1, disabled: ["ai-personal"] }));
    await expect(runTask("portrait", req)).rejects.toThrow("отключён администратором");
    expect(calls).toEqual([]);
    expect(usageRows()).toEqual([]);
    expect(await taskRoute("portrait")).toEqual([]);
    expect(await taskRoute("analysis")).not.toEqual([]);
  });
  it("задача из внешнего пула идёт во внешний API, расход записан", async () => {
    extQueue.push(extAnswer('{"text":"внешне"}'));
    const r = await runTask<{ text: string }>("recap", req);
    expect(r).toMatchObject({ value: { text: "внешне" }, provider: "external", model: "deepseek-v4-pro", tier: 3 });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(usageRows()).toMatchObject([{ task: "recap", provider: "external", ok: 1 }]);
  });

  it("локальная задача — сразу в Ollama, с нулевой ценой", async () => {
    const r = await runTask<{ text: string }>("analysis", req);
    expect(r).toMatchObject({ value: { text: "локально" }, provider: "ollama", tier: 1, costUsd: 0 });
    expect(calls.some((u) => u.includes("ext.test"))).toBe(false);
  });

  it("ошибка внешнего API — запасной вариант локально", async () => {
    extQueue.push(() => new Response("сбой", { status: 503 }));
    const r = await runTask<{ text: string }>("rerank", req);
    expect(r.provider).toBe("ollama");
    expect(usageRows().map((x) => [x.provider, x.ok])).toEqual([["external", 0], ["ollama", 1]]);
  });

  it("ответ не по схеме — одна попытка «исправь» у того же провайдера", async () => {
    extQueue.push(extAnswer('{"wrong":1}'), extAnswer('```json\n{"text":"исправлено"}\n```'));
    const r = await runTask<{ text: string }>("recap", req);
    expect(r).toMatchObject({ value: { text: "исправлено" }, provider: "external" });
    expect(usageRows().map((x) => x.ok)).toEqual([0, 1]);
  });

  it("бюджет исчерпан — задача уходит локально", async () => {
    saveLlmConfig({ budgetUsd: 0 });
    expect((await taskRoute("recap")).map((l) => l.provider)).toEqual(["ollama"]);
  });

  it("режим «без ИИ» и нет Ollama — LlmUnavailable", async () => {
    saveLlmConfig({ mode: "off" });
    await expect(runTask("recap", req)).rejects.toBeInstanceOf(LlmUnavailable);
    resetLlmConfig();
    saveLlmConfig({ mode: "local" });
    ollamaUp = false;
    await new Promise((r) => setTimeout(r, 0));
    // Кэш списка моделей Ollama — минута: проверяем через маршрут без внешнего звена
    expect((await taskRoute("recap")).every((l) => l.provider === "ollama")).toBe(true);
  });

  it("402 от внешнего API включает паузу — дальше только локально", async () => {
    extQueue.push(() => new Response("нет денег", { status: 402 }));
    const r = await runTask<{ text: string }>("recap", req);
    expect(r.provider).toBe("ollama");
    expect((await taskRoute("recap")).map((l) => l.provider)).toEqual(["ollama"]);
  });
});
