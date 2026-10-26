// Стоимость вызова внешней LLM по счётчикам токенов из ответа API.

/** Цены, $ за 1M токенов по тарифу «пик»: вход, вход из кэша префикса, выход. */
export type Price = { in: number; hit: number; out: number };
export type Usage = { prompt: number; cacheHit: number; completion: number };

// Тарифы DeepSeek на 2026-10 (агрегаторы; цена кэша — консервативно как вход, уточнить по ответам API)
export const DEFAULT_PRICES: Record<string, Price> = {
  "deepseek-flash": { in: 0.3, hit: 0.3, out: 1.2 },
  "deepseek-v4-pro": { in: 1.32, hit: 1.32, out: 3.96 },
};

/** Пиковые часы DeepSeek по UTC [с, до); вне пика — половина цены. */
export const PEAK_UTC: [number, number][] = [[1, 4], [6, 10]];
export const OFF_PEAK_FACTOR = 0.5;

export function isPeak(at: Date, windows = PEAK_UTC): boolean {
  const h = at.getUTCHours();
  return windows.some(([from, to]) => h >= from && h < to);
}

/** Цена модели; незнакомая считается по самой дорогой — бюджет не должен недооцениваться. */
export function priceOf(model: string, prices: Record<string, Price>): Price {
  const p = prices[model];
  if (p) return p;
  const all = Object.values(prices);
  return all.length
    ? { in: Math.max(...all.map((x) => x.in)), hit: Math.max(...all.map((x) => x.hit)), out: Math.max(...all.map((x) => x.out)) }
    : { in: 0, hit: 0, out: 0 };
}

export function costUsd(model: string, u: Usage, at: Date, prices: Record<string, Price> = DEFAULT_PRICES): number {
  const p = priceOf(model, prices);
  const hit = Math.min(u.cacheHit, u.prompt);
  const base = ((u.prompt - hit) * p.in + hit * p.hit + u.completion * p.out) / 1e6;
  return base * (isPeak(at) ? 1 : OFF_PEAK_FACTOR);
}
