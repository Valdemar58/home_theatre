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
