import "server-only";
import { db, now, stmt } from "./db";
import { DEFAULT_PRICES, type Price } from "@/lib/llm-pricing";
import { LLM_TASKS, parseTaskPools, type LlmMode, type LlmSettings, type LlmTask, type Pool } from "@/lib/llm-tasks";

// Настройки LLM: значения по умолчанию ← .env ← правки в интерфейсе (app_settings 'llm').
// Ключ внешнего API — только из .env: в базу и в ответы API он не попадает.

export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.5:9b";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";

export const external = {
  url: (process.env.DEEPSEEK_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  apiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
  concurrency: Number(process.env.DEEPSEEK_CONCURRENCY) || 3,
};

const MODES: LlmMode[] = ["auto", "local", "external", "off"];

function parsePrices(s: string | undefined): Record<string, Price> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, Price>;
  } catch {
    console.warn("[llm] LLM_PRICES — не JSON, беру цены по умолчанию");
    return {};
  }
}

function fromEnv(): LlmSettings {
  const mode = process.env.LLM_MODE as LlmMode;
  return {
    mode: MODES.includes(mode) ? mode : "auto",
    cheap: process.env.DEEPSEEK_MODEL_CHEAP || "deepseek-flash",
    smart: process.env.DEEPSEEK_MODEL_SMART || "deepseek-v4-pro",
    tasks: parseTaskPools(process.env.LLM_EXTERNAL_TASKS),
    upgrade: {},
    budgetUsd: Number(process.env.LLM_BUDGET_USD) || 3,
    prices: { ...DEFAULT_PRICES, ...parsePrices(process.env.LLM_PRICES) },
  };
}

const readStmt = stmt<[], { value: string }>("SELECT value FROM app_settings WHERE key = 'llm'");
let cache: LlmSettings | null = null;

export function getLlmConfig(): LlmSettings {
  if (cache) return cache;
  const base = fromEnv();
  const saved = readStmt().get();
  const patch = saved ? (JSON.parse(saved.value) as Partial<LlmSettings>) : {};
  cache = {
    ...base,
    ...patch,
    tasks: { ...base.tasks, ...patch.tasks },
    upgrade: { ...base.upgrade, ...patch.upgrade },
    prices: { ...base.prices, ...patch.prices },
  };
  return cache;
}

/** Проверить и сохранить правку из интерфейса; возвращает итоговые настройки. */
export function saveLlmConfig(input: Partial<LlmSettings>): LlmSettings {
  const saved = readStmt().get();
  const patch = saved ? (JSON.parse(saved.value) as Partial<LlmSettings>) : {};
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode)) throw new Error("неизвестный режим");
    patch.mode = input.mode;
  }
  for (const k of ["cheap", "smart"] as const) {
    const v = input[k];
    if (v !== undefined) {
      if (typeof v !== "string" || !/^[\w.:-]{1,80}$/.test(v)) throw new Error(`неверное имя модели (${k})`);
      patch[k] = v;
    }
  }
  if (input.budgetUsd !== undefined) {
    const b = Number(input.budgetUsd);
    if (!Number.isFinite(b) || b < 0 || b > 1000) throw new Error("бюджет — от 0 до 1000 $");
    patch.budgetUsd = b;
  }
  if (input.tasks) {
    patch.tasks = { ...patch.tasks } as Record<LlmTask, Pool>;
    for (const [t, p] of Object.entries(input.tasks)) {
      if (!(LLM_TASKS as readonly string[]).includes(t) || !["local", "cheap", "smart"].includes(p)) throw new Error(`неверный пул для ${t}`);
      patch.tasks[t as LlmTask] = p;
    }
  }
  if (input.upgrade) {
    patch.upgrade = { ...patch.upgrade };
    for (const [t, v] of Object.entries(input.upgrade)) {
      if (!(LLM_TASKS as readonly string[]).includes(t)) throw new Error(`неизвестная задача ${t}`);
      patch.upgrade[t as LlmTask] = Boolean(v);
    }
  }
  if (input.prices) {
    for (const [m, p] of Object.entries(input.prices)) {
      if (![p.in, p.hit, p.out].every((x) => Number.isFinite(x) && x >= 0)) throw new Error(`неверная цена для ${m}`);
    }
    patch.prices = { ...patch.prices, ...input.prices };
  }
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('llm', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(patch), now());
  cache = null;
  return getLlmConfig();
}

/** Сбросить правки интерфейса к значениям из .env. */
export function resetLlmConfig(): LlmSettings {
  db.prepare("DELETE FROM app_settings WHERE key = 'llm'").run();
  cache = null;
  return getLlmConfig();
}
