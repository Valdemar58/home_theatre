import "server-only";
import { EMBED_MODEL, LLM_MODEL, OLLAMA_URL, external, getLlmConfig } from "./llm-config";
import { externalChat, ollamaBusy, ollamaChat, ollamaRun, ProviderError, type ChatRequest, type ChatResponse } from "./llm-providers";
import { logUsage, monthSpend } from "./llm-usage";
import { extractJson, validate, type JsonSchema } from "@/lib/json-lite";
import { costUsd, type Usage } from "@/lib/llm-pricing";
import { tierOf } from "@/lib/llm-tier";
import type { LlmTask } from "@/lib/llm-tasks";

// Вызовы LLM по задачам: внешний API (если задача в его пуле, есть ключ и бюджет) →
// локальная Ollama → «без ИИ» (LlmUnavailable — функция работает упрощённо, как без Ollama).
// Эмбеддинги — всегда локально (у внешнего API их нет).

export { EMBED_MODEL, LLM_MODEL };
export const llmBusy = ollamaBusy;

export class LlmUnavailable extends Error {
  constructor(task: string) {
    super(`ИИ недоступен для задачи «${task}»`);
  }
}

export type Provider = "ollama" | "external";
export type LlmResult<T> = { value: T; provider: Provider; model: string; tier: number; usage: Usage; costUsd: number; usageId: number };
type Link = { provider: Provider; model: string; tier: number };

// ---------------------------------------------------------------- доступность Ollama

let tags: { names: string[]; at: number } | null = null;

async function ollamaModels(): Promise<string[]> {
  if (tags && Date.now() - tags.at < 60_000) return tags.names;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models: { name: string }[] };
    tags = { names: data.models.map((m) => m.name), at: Date.now() };
  } catch {
    tags = { names: [], at: Date.now() };
  }
  return tags.names;
}
const has = (names: string[], m: string) => names.some((n) => n === m || n === `${m}:latest`);

/** Локальная чат-модель скачана и Ollama отвечает (проверка кэшируется на минуту). */
export async function ollamaAvailable(): Promise<boolean> {
  return getLlmConfig().mode !== "off" && has(await ollamaModels(), LLM_MODEL);
}
/** Модель эмбеддингов доступна (нужна «похожему», карте и рекомендациям по смыслу). */
export async function embedAvailable(): Promise<boolean> {
  return has(await ollamaModels(), EMBED_MODEL);
}

// ---------------------------------------------------------------- предохранитель внешнего API

let breaker: { until: number; reason: string } | null = null;
let failures = 0;

export function breakerState(): string | null {
  return breaker && breaker.until > Date.now() ? breaker.reason : null;
}
function tripOn(e: unknown) {
  const status = e instanceof ProviderError ? e.status : 0;
  if (status === 401 || status === 402 || status === 403) {
    breaker = { until: Date.now() + 3600_000, reason: status === 402 ? "закончились деньги на счёте" : "ключ не принят" };
  } else if (++failures >= 3) {
    breaker = { until: Date.now() + 600_000, reason: "внешний API не отвечает" };
    failures = 0;
  }
}

// ---------------------------------------------------------------- маршрут

/** Звенья цепочки для задачи (пусто — ИИ недоступен). */
export async function taskRoute(task: LlmTask): Promise<Link[]> {
  const s = getLlmConfig();
  if (s.mode === "off") return [];
  const links: Link[] = [];
  const pool = s.mode === "external" && s.tasks[task] === "local" ? "cheap" : s.tasks[task];
  const wantsExternal = s.mode === "external" || (s.mode === "auto" && pool !== "local");
  if (wantsExternal && external.apiKey && !breakerState() && monthSpend() < s.budgetUsd) {
    const model = pool === "smart" ? s.smart : s.cheap;
    links.push({ provider: "external", model, tier: tierOf("external", model, s) });
  }
  if (await ollamaAvailable()) links.push({ provider: "ollama", model: LLM_MODEL, tier: tierOf("ollama", LLM_MODEL, s) });
  return links;
}

export async function taskAvailable(task: LlmTask): Promise<boolean> {
  return (await taskRoute(task)).length > 0;
}

/** Лучший ранг, который сейчас даст задача (0 — без ИИ). */
export async function bestRouteTier(task: LlmTask): Promise<number> {
  return (await taskRoute(task))[0]?.tier ?? 0;
}

// ---------------------------------------------------------------- вызов

export type TaskRequest = {
  schema: JsonSchema;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Не звать модели хуже этого ранга (улучшение старых результатов) */
  minTier?: number;
};

async function attempt(link: Link, r: ChatRequest): Promise<ChatResponse> {
  return link.provider === "external" ? externalChat(r) : ollamaChat(r);
}

/** Ответ по JSON-схеме для задачи — с запасными вариантами и записью расхода. */
export async function runTask<T>(task: LlmTask, req: TaskRequest): Promise<LlmResult<T>> {
  const links = (await taskRoute(task)).filter((l) => l.tier >= (req.minTier ?? 0));
  if (!links.length) throw new LlmUnavailable(task);
  const prices = getLlmConfig().prices;
  let lastError: unknown = null;
  for (const link of links) {
    let repair: ChatRequest["repair"];
    let retried = false;
    // Две попытки на звено: вторая — «исправь» с перечнем ошибок, если ответ не по схеме
    for (let n = 0; n < 2; n++) {
      const started = Date.now();
      const base = { task, provider: link.provider, model: link.model };
      try {
        const out = await attempt(link, {
          model: link.model, schema: req.schema, system: req.system, user: req.user, repair,
          timeoutMs: req.timeoutMs ?? 300_000, maxTokens: req.maxTokens,
        });
        const cost = link.provider === "external" ? costUsd(link.model, out.usage, new Date(), prices) : 0;
        let parsed: unknown;
        let errors: string[] = [];
        try {
          parsed = extractJson(out.text);
        } catch {
          errors = [out.truncated ? "ответ оборван (лимит токенов)" : "ответ не JSON"];
        }
        const v = errors.length ? null : validate<T>(req.schema, parsed);
        if (v?.ok) {
          const usageId = logUsage({ ...base, ...out.usage, costUsd: cost, ms: Date.now() - started, ok: true });
          if (link.provider === "external") failures = 0;
          return { value: v.value, provider: link.provider, model: link.model, tier: link.tier, usage: out.usage, costUsd: cost, usageId };
        }
        errors = v && !v.ok ? v.errors : errors;
        logUsage({ ...base, ...out.usage, costUsd: cost, ms: Date.now() - started, ok: false, error: errors.join("; ") });
        lastError = new Error(`${task}: ${errors.join("; ")}`);
        // Оборванный ответ «исправлять» бесполезно: промпт станет ещё длиннее. Обрыв обычно — модель зациклилась
        // в рассуждениях (случайно): один раз пробуем заново с чистого листа, второй обрыв — к следующему звену
        if (out.truncated) {
          if (n > 0 || retried) break;
          retried = true;
          repair = undefined;
          continue;
        }
        repair = { answer: out.text, errors };
      } catch (e) {
        logUsage({ ...base, prompt: 0, cacheHit: 0, completion: 0, costUsd: 0, ms: Date.now() - started, ok: false, error: String(e) });
        if (link.provider === "external") tripOn(e);
        lastError = e;
        break; // сетевая ошибка — сразу к следующему звену
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type TestResult = { ok: boolean; provider: Provider; model: string; ms: number; usage: Usage | null; costUsd: number; error: string | null };

/** Пробный вызов пула в обход маршрутизации и бюджета — проверить ключ, модель и счётчики токенов. */
export async function testPool(pool: "local" | "cheap" | "smart"): Promise<TestResult> {
  const s = getLlmConfig();
  const link: Link = pool === "local"
    ? { provider: "ollama", model: LLM_MODEL, tier: 1 }
    : { provider: "external", model: pool === "smart" ? s.smart : s.cheap, tier: 0 };
  const started = Date.now();
  const schema: JsonSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
  try {
    const out = await attempt(link, { model: link.model, schema, system: "Отвечай кратко.", user: "Назови одно известное аниме 2016 года.", timeoutMs: 60_000, maxTokens: 200 });
    const cost = link.provider === "external" ? costUsd(link.model, out.usage, new Date(), s.prices) : 0;
    const v = validate(schema, extractJson(out.text));
    logUsage({ task: "test", provider: link.provider, model: link.model, ...out.usage, costUsd: cost, ms: Date.now() - started, ok: v.ok, error: v.ok ? undefined : v.errors.join("; ") });
    return { ok: v.ok, provider: link.provider, model: link.model, ms: Date.now() - started, usage: out.usage, costUsd: cost, error: v.ok ? null : v.errors.join("; ") };
  } catch (e) {
    return { ok: false, provider: link.provider, model: link.model, ms: Date.now() - started, usage: null, costUsd: 0, error: String(e instanceof Error ? e.message : e) };
  }
}

/** Эмбеддинги текстов (нормированные векторы) — локально. */
export async function embed(texts: string[]): Promise<number[][]> {
  return ollamaRun(async () => {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, truncate: true }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama embed: HTTP ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  });
}
