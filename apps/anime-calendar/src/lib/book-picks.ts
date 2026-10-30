// «Для тебя» в режимах книг (TASKS 5.10): рекомендации читателей AniList к книгам из моего списка, сложенные с весом
// моего отношения к книге. Чистые функции — для тестов.

export type Seed = { id: number; weight: number };

/** Вес книги-источника: оценка (6–10 → 0.2–1, ниже — не берём), без оценки — по статусу. */
export function seedWeight(status: string, score: number): number {
  if (status === "dropped" || status === "planned") return 0;
  if (score > 0) return score > 5 ? (score - 5) / 5 : 0;
  return status === "completed" || status === "rewatching" ? 0.6 : status === "watching" ? 0.5 : 0.3;
}

/**
 * Кандидаты: каждая книга-источник отдаёт свои рекомендации (по порядку AniList) с весом weight / √(место);
 * чем больше источников советуют книгу, тем выше. because — до трёх источников, давших больше всего.
 */
export function rankPicks(seeds: Seed[], recs: Map<number, number[]>, exclude: Set<number>, limit = 30) {
  const acc = new Map<number, { score: number; from: Map<number, number> }>();
  for (const s of seeds) {
    if (s.weight <= 0) continue;
    (recs.get(s.id) ?? []).forEach((id, i) => {
      if (exclude.has(id) || id === s.id) return;
      const add = s.weight / Math.sqrt(i + 1);
      const a = acc.get(id) ?? { score: 0, from: new Map<number, number>() };
      a.score += add;
      a.from.set(s.id, (a.from.get(s.id) ?? 0) + add);
      acc.set(id, a);
    });
  }
  return [...acc].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]).slice(0, limit).map(([id, a]) => ({
    id, score: Math.round(a.score * 100) / 100, because: [...a.from].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([f]) => f),
  }));
}
