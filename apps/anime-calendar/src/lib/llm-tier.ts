// Ранг качества источника результата: больше — лучше. Результат с меньшим рангом
// не вытесняет результат с большим (локальная модель не перезапишет разбор умной внешней).

export const TIER = { none: 0, local: 1, cheap: 2, smart: 3, tmdb: 4, human: 5 } as const;

export function tierOf(provider: string, model: string, s: { cheap: string; smart: string }): number {
  if (provider === "human") return TIER.human;
  if (provider === "tmdb") return TIER.tmdb;
  if (provider === "ollama" || provider === "legacy") return TIER.local;
  if (model === s.smart) return TIER.smart;
  if (model === s.cheap) return TIER.cheap;
  return TIER.cheap; // незнакомая внешняя модель
}

/**
 * tier-first — лучший ранг важнее свежести (разбор умной модели по старому входу лучше свежего локального);
 * fresh-first — нужен результат по текущему входу (портрет, переранжирование), старый — только как запасной.
 */
export type Policy = "tier-first" | "fresh-first";
export type Candidate = { tier: number; createdAt: number; inputHash: string };

/** Пустой хэш — вход неизвестен (перенесённые старые данные): считаем совпадающим, чтобы не пересчитывать. */
export const isFresh = (c: Candidate, inputHash: string | undefined) => inputHash === undefined || c.inputHash === "" || c.inputHash === inputHash;

/** Текущий результат из истории. staleOk=false — несвежие не годятся (только хранятся). */
export function pickBest<C extends Candidate>(rows: C[], opts: { inputHash?: string; policy: Policy; staleOk: boolean }): { row: C; fresh: boolean } | null {
  const scored = rows
    .map((row) => ({ row, fresh: isFresh(row, opts.inputHash) }))
    .filter((x) => x.fresh || opts.staleOk);
  if (!scored.length) return null;
  scored.sort((a, b) => opts.policy === "tier-first"
    ? b.row.tier - a.row.tier || Number(b.fresh) - Number(a.fresh) || b.row.createdAt - a.row.createdAt
    : Number(b.fresh) - Number(a.fresh) || (a.fresh && b.fresh ? b.row.tier - a.row.tier : 0) || b.row.createdAt - a.row.createdAt);
  return scored[0];
}

/**
 * Звать ли модель. routeTier — ранг лучшей доступной сейчас модели (0 — ИИ нет).
 * Локальная модель никогда не переделывает результат умной; улучшение старого — только с флагом.
 */
export function shouldRun(best: { tier: number; fresh: boolean } | null, routeTier: number, opts: { policy: Policy; upgrade: boolean }): boolean {
  if (routeTier <= 0) return false;
  if (!best) return true;
  if (!best.fresh) return opts.policy === "fresh-first" || routeTier >= best.tier;
  return opts.upgrade && routeTier > best.tier;
}
