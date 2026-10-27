import "server-only";
import { RateLimiter } from "./http";
import { OLLAMA_URL, external } from "./llm-config";
import { schemaPrompt, type JsonSchema } from "@/lib/json-lite";
import type { Usage } from "@/lib/llm-pricing";

// Провайдеры чата: локальная Ollama (одна видеокарта — строго по очереди) и внешний
// OpenAI-совместимый API (DeepSeek) — несколько запросов параллельно.

export type ChatRequest = {
  model: string;
  schema: JsonSchema;
  system: string;
  user: string;
  /** Предыдущий неудачный ответ и ошибки — для повторной попытки «исправь» */
  repair?: { answer: string; errors: string[] };
  timeoutMs: number;
  maxTokens?: number;
  /** Картинки к сообщению (base64) — только Ollama с моделью со зрением */
  images?: string[];
};
export type ChatResponse = { text: string; usage: Usage; truncated: boolean };

export class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const repairMessages = (r: ChatRequest) =>
  r.repair
    ? [
        { role: "assistant", content: r.repair.answer.slice(0, 4000) },
        { role: "user", content: `Ответ не подходит: ${r.repair.errors.slice(0, 8).join("; ")}. Исправь и верни только JSON.` },
      ]
    : [];

// ---------------------------------------------------------------- Ollama

const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 16384;
const ollamaQueue = new RateLimiter(0);
// Сколько запросов к Ollama ждёт или выполняется: ИИ-апскейл картинок в это время уступает видеокарту
let pending = 0;
export const ollamaBusy = () => pending > 0;

export function ollamaRun<T>(fn: () => Promise<T>): Promise<T> {
  pending++;
  return ollamaQueue.run(fn).finally(() => {
    pending--;
  });
}

export function ollamaChat(r: ChatRequest): Promise<ChatResponse> {
  return ollamaRun(async () => {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: r.model,
        stream: false,
        // Без «размышлений»: ответ нужен структурированный и быстрый
        think: false,
        format: r.schema,
        // Контекст — на промпт и ответ вместе: переранжирование 30 тайтлов (~5k + ~3k) в 8k не влезало
        options: { temperature: 0.3, num_ctx: OLLAMA_NUM_CTX },
        messages: [{ role: "system", content: r.system }, { role: "user", content: r.user, ...(r.images?.length ? { images: r.images } : {}) }, ...repairMessages(r)],
      }),
      signal: AbortSignal.timeout(r.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(res.status, `Ollama chat: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = (await res.json()) as { message: { content: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
    return {
      text: data.message.content,
      usage: { prompt: data.prompt_eval_count ?? 0, cacheHit: 0, completion: data.eval_count ?? 0 },
      truncated: data.done_reason === "length",
    };
  });
}

// ---------------------------------------------------------------- внешний API

const REASONING_BUDGET = 8192;

// Семафор: не больше N запросов одновременно
let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= external.concurrency) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

export function externalChat(r: ChatRequest): Promise<ChatResponse> {
  if (!external.apiKey) return Promise.reject(new ProviderError(401, "ключ внешнего API не задан"));
  return slot(async () => {
    const res = await fetch(`${external.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${external.apiKey}` },
      body: JSON.stringify({
        model: r.model,
        // Схема — в конце system: префикс одинаковый от вызова к вызову и попадает в кэш (дешевле)
        messages: [
          { role: "system", content: `${r.system}\n\n${schemaPrompt(r.schema)}` },
          { role: "user", content: r.user },
          ...repairMessages(r),
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        // Умная модель сначала «рассуждает» — эти токены входят в лимит (платятся только потраченные),
        // поэтому к нужному ответу добавляется запас, иначе ответ не успевает начаться
        max_tokens: (r.maxTokens ?? 4096) + REASONING_BUDGET,
        stream: false,
      }),
      signal: AbortSignal.timeout(r.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(res.status, `внешний API: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string | null }; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    };
    const choice = data.choices[0];
    return {
      text: choice?.message.content ?? "",
      usage: {
        prompt: data.usage?.prompt_tokens ?? 0,
        cacheHit: data.usage?.prompt_cache_hit_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
      },
      truncated: choice?.finish_reason === "length",
    };
  });
}
