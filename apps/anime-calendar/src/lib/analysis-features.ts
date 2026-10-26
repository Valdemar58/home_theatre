// Разбор тайтла от LLM → числовые признаки для алгоритмов без ИИ: склонности пользователя,
// балл «понравится», сходство тайтлов по ощущению (тон, юмор, темп, шкалы), объяснения.
// Модуль чистый: разбор сделан один раз (возможно, умной платной моделью), дальше — только арифметика.

export type AnalysisLike = {
  tone: string; humor: string[]; pacing: string; themes: string[];
  emotional_intensity: number; complexity: number; so_bad_its_good: number; voice_dependence: number;
  audience?: string; ending_type?: string; content_flags?: string[]; pacing_arc?: string; rewatch?: number; commitment?: number;
};
export type Features = Map<string, number>;

export const normTheme = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'.]/g, "").replace(/\s+/g, " ").trim();

// Шкалы 1–5 → [-1, 1] вокруг середины: «3» не сдвигает вкус ни в какую сторону
const scale = (v: number | undefined) => (v === undefined ? undefined : Math.max(-1, Math.min(1, (v - 3) / 2)));

/** Признаки разбора. canon — склейка тем-синонимов («дружба» / «сила дружбы») в одну. */
export function analysisFeatures(a: AnalysisLike, canon?: (theme: string) => string): Features {
  const f: Features = new Map();
  const one = (k: string) => f.set(k, 1);
  one(`tone:${a.tone}`);
  one(`pacing:${a.pacing}`);
  for (const h of a.humor) if (h !== "нет") one(`humor:${h}`);
  if (a.audience) one(`audience:${a.audience}`);
  if (a.ending_type) one(`ending:${a.ending_type}`);
  if (a.pacing_arc) one(`arc:${a.pacing_arc}`);
  for (const x of a.content_flags ?? []) if (x !== "нет") one(`flag:${x}`);
  const scales: [string, number | undefined][] = [
    ["intensity", a.emotional_intensity], ["complexity", a.complexity], ["sobad", a.so_bad_its_good],
    ["voice", a.voice_dependence], ["rewatch", a.rewatch], ["commitment", a.commitment],
  ];
  for (const [k, v] of scales) {
    const x = scale(v);
    if (x !== undefined && x !== 0) f.set(`scale:${k}`, x);
  }
  for (const t of a.themes) {
    const n = normTheme(t);
    if (n) f.set(`theme:${canon ? canon(n) : n}`, 0.5);
  }
  return f;
}

/** Склонности пользователя по признакам: сумма весов тайтлов × значение, нормированная в [-1, 1]. */
export function featureAffinity(items: { weight: number; f: Features | null }[]): Features {
  const aff: Features = new Map();
  for (const { weight, f } of items) {
    if (!f || !weight) continue;
    for (const [k, v] of f) aff.set(k, (aff.get(k) ?? 0) + weight * v);
  }
  const max = Math.max(1e-9, ...[...aff.values()].map(Math.abs));
  for (const [k, v] of aff) aff.set(k, v / max);
  return aff;
}

/** Насколько признаки кандидата совпадают со склонностями, [-1, 1]. */
export function featureScore(f: Features, aff: Features): number {
  let s = 0;
  let w = 0;
  for (const [k, v] of f) {
    s += v * (aff.get(k) ?? 0);
    w += Math.abs(v);
  }
  return w ? s / w : 0;
}

/** Сходство двух тайтлов по ощущению (без тем — свободный текст шумит), 0–1. */
export function vibeSimilarity(a: Features, b: Features): number {
  let num = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) {
    if (k.startsWith("theme:")) continue;
    na += x * x;
    num += x * (b.get(k) ?? 0);
  }
  for (const [k, y] of b) if (!k.startsWith("theme:")) nb += y * y;
  return na && nb ? Math.max(0, num / Math.sqrt(na * nb)) : 0;
}

/**
 * Сходство по ощущению сверх случайного: у случайной пары тайтлов оно уже ~0.42 (тон и темп часто совпадают;
 * замер на 160 разборах, 2026-10-26), у лучшего соседа ~0.92. Без поправки «похожесть» упиралась в 100%.
 */
export const VIBE_BASELINE = 0.42;
export const vibeLift = (v: number) => Math.max(0, Math.min(1, (v - VIBE_BASELINE) / (1 - VIBE_BASELINE)));

const SCALE_LABELS: Record<string, [string, string]> = {
  intensity: ["эмоциональный накал", "спокойная подача"],
  complexity: ["сложный сюжет", "простой сюжет"],
  sobad: ["«так плохо, что смешно»", ""],
  voice: ["подача и озвучка", ""],
  rewatch: ["хочется пересматривать", ""],
  commitment: ["требует погружения", "можно смотреть фоном"],
};

function traitLabel(k: string, v: number): string {
  const [kind, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
  switch (kind) {
    case "tone": return `${value} тон`;
    case "pacing": return `${value} темп`;
    case "humor": return `юмор: ${value}`;
    case "audience": return `аудитория: ${value}`;
    case "ending": return `концовка: ${value}`;
    case "arc": return `темп: ${value}`;
    case "scale": return SCALE_LABELS[value]?.[v > 0 ? 0 : 1] ?? "";
    default: return value; // тема, флаг
  }
}

/**
 * Что в кандидате совпадает со вкусом (sign=1) или против него (sign=-1) — для объяснения «понравится».
 * Учитываются только заметные вклады.
 */
export function topTraits(f: Features, aff: Features, n: number, sign: 1 | -1): string[] {
  return [...f]
    .map(([k, v]) => ({ k, v, c: v * (aff.get(k) ?? 0) * sign }))
    .filter((x) => x.c > 0.08)
    .sort((a, b) => b.c - a.c)
    .map((x) => traitLabel(x.k, x.v))
    .filter((l, i, all) => l && all.indexOf(l) === i)
    .slice(0, n);
}
