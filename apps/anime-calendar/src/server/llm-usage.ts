import "server-only";
import { db, stmt } from "./db";
import type { LlmUsageRow } from "@/lib/llm-tasks";

// Журнал вызовов LLM: токены, стоимость, ошибки — для бюджета и таблицы расходов в настройках.

export type UsageRecord = {
  task: string; provider: string; model: string;
  prompt: number; cacheHit: number; completion: number; costUsd: number; ms: number;
  ok: boolean; error?: string;
};

const insertStmt = stmt<[number, string, string, string, number, number, number, number, number, number, string | null]>(
  `INSERT INTO llm_usage (at, task, provider, model, prompt_tokens, cache_hit_tokens, completion_tokens, cost_usd, ms, ok, error)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Начало текущего месяца по UTC, секунды. */
const monthStart = (d = new Date()) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);

// Траты за месяц держим в памяти и прибавляем при каждой записи — бюджет проверяется на каждом вызове
let spent: { month: number; usd: number } | null = null;

export function monthSpend(): number {
  const m = monthStart();
  if (!spent || spent.month !== m) {
    const row = db.prepare<[number], { usd: number | null }>("SELECT SUM(cost_usd) AS usd FROM llm_usage WHERE at >= ?").get(m);
    spent = { month: m, usd: row?.usd ?? 0 };
  }
  return spent.usd;
}

/** Записать вызов; возвращает id строки (для связи с сохранённым результатом). */
export function logUsage(r: UsageRecord): number {
  const res = insertStmt().run(Math.floor(Date.now() / 1000), r.task, r.provider, r.model, r.prompt, r.cacheHit, r.completion,
    r.costUsd, Math.round(r.ms), r.ok ? 1 : 0, r.error?.slice(0, 500) ?? null);
  monthSpend();
  if (spent) spent.usd += r.costUsd;
  return Number(res.lastInsertRowid);
}

/** Расход за месяц ('YYYY-MM', по умолчанию текущий) по задаче × провайдеру × модели. */
export function usageByTask(month?: string): LlmUsageRow[] {
  const from = month && /^\d{4}-\d{2}$/.test(month) ? monthStart(new Date(`${month}-01T00:00:00Z`)) : monthStart();
  const d = new Date(from * 1000);
  const to = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
  return db.prepare<[number, number], LlmUsageRow>(
    `SELECT task, provider, model, COUNT(*) AS calls, SUM(ok = 0) AS errors,
            SUM(prompt_tokens) AS prompt, SUM(cache_hit_tokens) AS cacheHit, SUM(completion_tokens) AS completion,
            SUM(cost_usd) AS cost
     FROM llm_usage WHERE at >= ? AND at < ? GROUP BY task, provider, model ORDER BY cost DESC, calls DESC`).all(from, to);
}
