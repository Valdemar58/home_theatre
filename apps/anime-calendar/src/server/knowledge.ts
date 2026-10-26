import "server-only";
import { createHash } from "node:crypto";
import { db, now, stmt } from "./db";
import { bestRouteTier, LlmUnavailable, runTask, type LlmResult } from "./llm";
import { getLlmConfig } from "./llm-config";
import { pickBest, shouldRun, type Policy } from "@/lib/llm-tier";
import type { JsonSchema } from "@/lib/json-lite";
import type { LlmTask } from "@/lib/llm-tasks";

// Знания от LLM без срока жизни: каждый результат пишется в журнал llm_output и не удаляется;
// текущим считается лучший по рангу модели и свежести входа (pickBest). Платный ответ умной модели
// не затирается ответом локальной и не выбрасывается при смене версии промпта — им пользуются
// и малые модели (как входом), и алгоритмы без ИИ.

export type Provenance = { id: number; provider: string; model: string; tier: number; createdAt: number; inputHash: string; schemaV: number };
export type Known<T> = { value: T; prov: Provenance; fresh: boolean };

type Row = { id: number; schema_v: number; input_hash: string; provider: string; model: string; tier: number; value: string; created_at: number };

const rowsStmt = stmt<[string, string], Row>(
  "SELECT id, schema_v, input_hash, provider, model, tier, value, created_at FROM llm_output WHERE task = ? AND subject = ? ORDER BY id DESC");
const insertStmt = stmt<[string, string, number, number, string, string, string, number, string, number | null, number]>(
  `INSERT INTO llm_output (task, subject, schema_v, prompt_v, input_hash, provider, model, tier, value, usage_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export const hashOf = (x: unknown) => createHash("sha1").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex").slice(0, 16);

export type Meta = { schemaV: number; promptV: number; inputHash: string };

/** Записать результат (любой — и худший: он останется в истории). Возвращает id строки. */
export function recordOutput(task: LlmTask, subject: string, src: { provider: string; model: string; tier: number; usageId?: number | null }, value: unknown, meta: Meta): number {
  return Number(insertStmt().run(task, subject, meta.schemaV, meta.promptV, meta.inputHash, src.provider, src.model, src.tier,
    JSON.stringify(value), src.usageId ?? null, now()).lastInsertRowid);
}

export type BestOpts<T> = {
  inputHash?: string;
  policy: Policy;
  staleOk: boolean;
  /** Привести старую форму к текущей (null — непригодно) */
  adapt?: (raw: unknown, schemaV: number) => T | null;
};

function toKnown<T>(r: Row, fresh: boolean, adapt?: BestOpts<T>["adapt"]): Known<T> | null {
  const raw = JSON.parse(r.value) as unknown;
  const value = adapt ? adapt(raw, r.schema_v) : (raw as T);
  if (value === null) return null;
  return { value, fresh, prov: { id: r.id, provider: r.provider, model: r.model, tier: r.tier, createdAt: r.created_at, inputHash: r.input_hash, schemaV: r.schema_v } };
}

/** Все результаты по субъекту — от лучшего к худшему (для выбора с условием, напр. уникальное название). */
export function allOutputs<T>(task: LlmTask, subject: string, opts: BestOpts<T>): Known<T>[] {
  const rows = rowsStmt().all(task, subject);
  const out: Known<T>[] = [];
  let rest = rows.map((r) => ({ ...r, createdAt: r.created_at, inputHash: r.input_hash }));
  while (rest.length) {
    const best = pickBest(rest, opts);
    if (!best) break;
    const k = toKnown(best.row, best.fresh, opts.adapt);
    if (k) out.push(k);
    rest = rest.filter((x) => x !== best.row);
  }
  return out;
}

export function bestOutput<T>(task: LlmTask, subject: string, opts: BestOpts<T>): Known<T> | null {
  const rows = rowsStmt().all(task, subject).map((r) => ({ ...r, createdAt: r.created_at, inputHash: r.input_hash }));
  // Непригодные после adapt пропускаем и берём следующий
  while (rows.length) {
    const best = pickBest(rows, opts);
    if (!best) return null;
    const k = toKnown<T>(best.row, best.fresh, opts.adapt);
    if (k) return k;
    rows.splice(rows.indexOf(best.row), 1);
  }
  return null;
}

/** Лучшие результаты задачи по всем субъектам с префиксом (напр. все переводы тегов) — одним запросом. */
export function bestByPrefix<T>(task: LlmTask, prefix: string, opts: Omit<BestOpts<T>, "inputHash">): Map<string, Known<T>> {
  const rows = db.prepare<[string, string], Row & { subject: string }>(
    "SELECT id, subject, schema_v, input_hash, provider, model, tier, value, created_at FROM llm_output WHERE task = ? AND subject LIKE ? ORDER BY id DESC",
  ).all(task, `${prefix}%`);
  const groups = new Map<string, (Row & { subject: string; createdAt: number; inputHash: string })[]>();
  for (const r of rows) {
    const g = groups.get(r.subject) ?? [];
    g.push({ ...r, createdAt: r.created_at, inputHash: r.input_hash });
    groups.set(r.subject, g);
  }
  const out = new Map<string, Known<T>>();
  for (const [subject, g] of groups) {
    const best = pickBest(g, opts);
    const k = best && toKnown<T>(best.row, best.fresh, opts.adapt);
    if (k) out.set(subject, k);
  }
  return out;
}

export type ProduceSpec<T> = Meta & BestOpts<T> & {
  schema: JsonSchema;
  system: string;
  /** Промпт строится только если модель действительно нужна (может ходить в сеть) */
  user: () => string | Promise<string>;
  maxTokens?: number;
  /** Перевести ответ модели в хранимое значение */
  shape?: (answer: unknown) => T;
  /** Текущее значение сменилось — обновить денормализованную копию (колонку в таблице) */
  onPromote?: (k: Known<T>) => void;
};

/**
 * Лучшее известное значение; модель зовётся, только если результата нет, вход изменился
 * (и доступна модель не хуже) или включено улучшение более сильной моделью.
 * ИИ недоступен — возвращается лучшее, что есть (null — ничего).
 */
export async function produce<T>(task: LlmTask, subject: string, spec: ProduceSpec<T>): Promise<Known<T> | null> {
  const best = bestOutput<T>(task, subject, spec);
  const routeTier = await bestRouteTier(task);
  const upgrade = Boolean(getLlmConfig().upgrade[task]);
  if (!shouldRun(best && { tier: best.prov.tier, fresh: best.fresh }, routeTier, { policy: spec.policy, upgrade })) return best;
  let res: LlmResult<unknown>;
  try {
    res = await runTask<unknown>(task, {
      schema: spec.schema, system: spec.system, user: await spec.user(), maxTokens: spec.maxTokens,
      // Не тратить время на модель хуже той, что уже сделала результат
      minTier: best && spec.policy === "tier-first" ? best.prov.tier : 0,
    });
  } catch (e) {
    if (e instanceof LlmUnavailable) return best;
    throw e;
  }
  const value = spec.shape ? spec.shape(res.value) : (res.value as T);
  const id = recordOutput(task, subject, { provider: res.provider, model: res.model, tier: res.tier, usageId: res.usageId }, value, spec);
  const next = bestOutput<T>(task, subject, spec);
  if (next && next.prov.id === id) spec.onPromote?.(next);
  return next;
}
