import "server-only";
import { RateLimiter } from "./http";

// Клиент локальной LLM (Ollama): структурированные ответы по JSON-схеме и эмбеддинги.
// Все запросы идут по одному — видеокарта одна, параллельные запросы только мешают друг другу.

const OLLAMA = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.5:9b";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";

const limiter = new RateLimiter(0);
// Сколько запросов к LLM ждёт или выполняется: ИИ-апскейл картинок в это время уступает видеокарту
let pending = 0;
const queue = { run: <T>(fn: () => Promise<T>): Promise<T> => { pending++; return limiter.run(fn).finally(() => { pending--; }); } };
export const llmBusy = () => pending > 0;

let available: { ok: boolean; at: number } | null = null;

/** Ollama доступна и обе модели скачаны (проверка кэшируется на минуту). */
export async function llmAvailable(): Promise<boolean> {
  if (available && Date.now() - available.at < 60_000) return available.ok;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models: { name: string }[] };
    const names = data.models.map((m) => m.name);
    const has = (m: string) => names.some((n) => n === m || n === `${m}:latest`);
    available = { ok: has(LLM_MODEL) && has(EMBED_MODEL), at: Date.now() };
  } catch {
    available = { ok: false, at: Date.now() };
  }
  return available.ok;
}

/** Ответ модели строго по JSON-схеме (structured outputs Ollama). */
export async function chatJSON<T>(schema: object, system: string, user: string, timeoutMs = 300_000): Promise<T> {
  return queue.run(async () => {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        // Без «размышлений»: ответ нужен структурированный и быстрый
        think: false,
        format: schema,
        options: { temperature: 0.3, num_ctx: 8192 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama chat: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const data = (await res.json()) as { message: { content: string } };
    return JSON.parse(data.message.content) as T;
  });
}

/** Эмбеддинги текстов (нормированные векторы). */
export async function embed(texts: string[]): Promise<number[][]> {
  return queue.run(async () => {
    const res = await fetch(`${OLLAMA}/api/embed`, {
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
