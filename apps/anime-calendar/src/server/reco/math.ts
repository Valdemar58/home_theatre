// Математика рекомендаций: веса тайтлов по оценкам, вектор вкуса, сходство, гибридный балл.
// Модуль чистый, чтобы его можно было тестировать.

export type Vector = number[];

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vector): Vector {
  const n = norm(a);
  return n ? a.map((x) => x / n) : a;
}

export function cosine(a: Vector, b: Vector): number {
  const n = norm(a) * norm(b);
  return n ? dot(a, b) / n : 0;
}

export type TasteEntry = {
  status: string;
  score: number; // 0 — без оценки, 1–10
  episodes: number;
  totalEpisodes: number | null;
  tags: string[];
  /** «Рекомендую»: явный сигнал сильнее оценки (да / нет / не выбрано) */
  recommend?: boolean | null;
};

/** Теги, которые означают «понравилось», даже если формально «плохо». */
export const POSITIVE_TAGS = ["так плохо, что смешно", "guilty pleasure", "шедевр", "пересмотрю", "озвучка решает", "смешно", "до слёз"];
export const NEGATIVE_TAGS = ["затянуто", "не зашло", "скучно", "раздражает"];

/**
 * Вес тайтла во вкусе пользователя: > 0 — понравилось, < 0 — нет.
 * Оценки центрируются по средней пользователя: у кого-то «7» — это плохо, у кого-то — хорошо.
 * Брошенное без оценки — отрицательно (сильнее, если бросил рано). Личные теги корректируют вес.
 */
export function entryWeight(e: TasteEntry, meanScore: number): number {
  let w: number;
  if (e.score > 0) {
    w = (e.score - meanScore) / 2.5;
  } else if (e.status === "dropped") {
    const progress = e.totalEpisodes ? e.episodes / e.totalEpisodes : 0.3;
    w = -1 + progress * 0.5;
  } else if (e.status === "completed" || e.status === "rewatching") {
    w = 0.4;
  } else if (e.status === "watching") {
    w = 0.3;
  } else {
    w = 0; // запланировано / отложено — сигнала о вкусе нет
  }
  if (e.status === "rewatching") w += 0.5;
  if (e.recommend === true) w += 0.6;
  if (e.recommend === false) w -= 0.6;
  for (const t of e.tags) {
    if (POSITIVE_TAGS.includes(t)) w += 0.4;
    if (NEGATIVE_TAGS.includes(t)) w -= 0.4;
  }
  return Math.max(-2, Math.min(2, w));
}

export function meanScore(entries: TasteEntry[]): number {
  const scored = entries.filter((e) => e.score > 0);
  return scored.length ? scored.reduce((s, e) => s + e.score, 0) / scored.length : 7;
}

/** Вектор вкуса: взвешенная сумма эмбеддингов (нелюбимое вычитается). */
export function tasteVector(items: { weight: number; embedding: Vector }[]): Vector | null {
  const dim = items.find((i) => i.embedding.length)?.embedding.length;
  if (!dim) return null;
  const v = new Array<number>(dim).fill(0);
  let total = 0;
  for (const { weight, embedding } of items) {
    if (!weight || embedding.length !== dim) continue;
    for (let i = 0; i < dim; i++) v[i] += weight * embedding[i];
    total += Math.abs(weight);
  }
  return total ? normalize(v) : null;
}

/** Предпочтения по тегам AniList: сумма весов тайтлов × ранг тега (0–1). */
export function tagAffinity(items: { weight: number; tags: { name: string; rank: number }[] }[]): Map<string, number> {
  const aff = new Map<string, number>();
  for (const { weight, tags } of items) {
    for (const t of tags) aff.set(t.name, (aff.get(t.name) ?? 0) + weight * (t.rank / 100));
  }
  // Нормируем в [-1, 1]
  const max = Math.max(1e-9, ...[...aff.values()].map(Math.abs));
  for (const [k, v] of aff) aff.set(k, v / max);
  return aff;
}

/** Насколько теги кандидата совпадают с предпочтениями ([-1, 1]). */
export function tagScore(tags: { name: string; rank: number }[], aff: Map<string, number>): number {
  let s = 0;
  let w = 0;
  for (const t of tags) {
    const r = t.rank / 100;
    s += r * (aff.get(t.name) ?? 0);
    w += r;
  }
  return w ? s / w : 0;
}

/** vibe — совпадение со вкусом по разбору LLM (тон, юмор, темп, шкалы); нет разбора — undefined. */
export type HybridParts = { similarity: number; tags: number; community: number; quality: number; vibe?: number };

/** Итоговый балл кандидата 0–100 из составляющих (каждая примерно в [0, 1]). */
export function hybridScore(p: HybridParts): number {
  const s = p.vibe === undefined
    ? 0.45 * p.similarity + 0.25 * p.tags + 0.2 * p.community + 0.1 * p.quality
    : 0.4 * p.similarity + 0.2 * p.tags + 0.15 * p.vibe + 0.15 * p.community + 0.1 * p.quality;
  return Math.round(Math.max(0, Math.min(1, s)) * 100);
}

// ---------------------------------------------------------------- похожесть тайтлов друг на друга
//
// Не эмбеддинги описаний: они ловят слова сюжета («война», «солдаты»), а не жанр и подачу —
// пародия про злодеев-комбатантов выходила ближе к «Киберпанку», чем к «Коносубе».
// Вместо них — теги и жанры AniList с весом редкости (TF-IDF) и голоса сообщества в обе стороны.

type Tag = { name: string; rank: number; category?: string };
export type SimilarityIdf = { tags: Map<string, number>; genres: Map<string, number>; total: number };

/** Частоты тегов и жанров по базе — редкий тег («Пародия») весит больше частого («Главный герой — парень»). */
export function similarityIdf(items: { tags: Tag[]; genres: string[] }[]): SimilarityIdf {
  const tags = new Map<string, number>();
  const genres = new Map<string, number>();
  for (const it of items) {
    for (const t of it.tags) tags.set(t.name, (tags.get(t.name) ?? 0) + 1);
    for (const g of it.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
  }
  return { tags, genres, total: items.length };
}

const idf = (df: number | undefined, total: number) => Math.log((total + 1) / (1 + (df ?? 0)));

/** Разреженный вектор тегов: ранг × редкость; слабые (ранг < 40) и откровенные теги не учитываем. */
export function tagVector(tags: Tag[], s: SimilarityIdf): Map<string, number> {
  return new Map(tags.filter((t) => t.rank >= 40 && t.category !== "Sexual Content")
    .map((t) => [t.name, (t.rank / 100) * idf(s.tags.get(t.name), s.total)]));
}

export function genreVector(genres: string[], s: SimilarityIdf): Map<string, number> {
  return new Map(genres.map((g) => [g, idf(s.genres.get(g), s.total)]));
}

export function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  let num = 0;
  for (const [k, x] of a) num += x * (b.get(k) ?? 0);
  const na = Math.hypot(...a.values());
  const nb = Math.hypot(...b.values());
  return na && nb ? num / (na * nb) : 0;
}

/**
 * Голоса сообщества AniList «если понравилось A — посмотри B», 0–1.
 * Логарифм: 22 голоса при максимуме 373 — это всё ещё заметная связь (линейно было бы 0.06).
 * В обе стороны: у A может не быть B в топе, а у B — A есть.
 */
export function communityScore(recsA: { id: number; rating: number }[], idA: number,
  recsB: { id: number; rating: number }[] | null, idB: number): number {
  const one = (recs: { id: number; rating: number }[], to: number) => {
    const r = recs.find((x) => x.id === to)?.rating ?? 0;
    const max = Math.max(1, ...recs.map((x) => x.rating));
    return r > 0 ? Math.log1p(r) / Math.log1p(max) : 0;
  };
  return Math.max(one(recsA, idB), recsB ? one(recsB, idA) : 0);
}

/** Сумма весов, при которой похожесть считается 100% (лучшие пары в базе дают ~0.55–0.6). */
const SIMILARITY_FULL = 0.6;

/**
 * Похожесть 0–100: теги 50%, сообщество 35%, жанры 15%. Если оба тайтла разобраны LLM —
 * ещё и ощущение (тон, юмор, темп): теги 40%, сообщество 30%, ощущение 20%, жанры 10%.
 */
export function titleSimilarity(p: { tags: number; genres: number; community: number; vibe?: number }): number {
  const s = p.vibe === undefined
    ? 0.5 * p.tags + 0.35 * p.community + 0.15 * p.genres
    : 0.4 * p.tags + 0.3 * p.community + 0.1 * p.genres + 0.2 * p.vibe;
  return Math.round(Math.min(1, s / SIMILARITY_FULL) * 100);
}

export type SharedTraits = { tags: string[]; genres: string[]; votes: number };

/**
 * Что общего у двух тайтлов — для объяснения «почему»: общие теги (сильные у обоих, редкие — выше),
 * общие жанры (редкие — выше) и голоса зрителей AniList «если понравилось одно — посмотри другое».
 */
export function sharedTraits(
  a: { id: number; tags: Tag[]; genres: string[]; recs: { id: number; rating: number }[] },
  b: { id: number; tags: Tag[]; genres: string[]; recs: { id: number; rating: number }[] },
  s: SimilarityIdf,
): SharedTraits {
  const tb = new Map(b.tags.map((t) => [t.name, t.rank]));
  const tags = a.tags
    // технические теги (CGI, 4-koma) — не «общее по смыслу»
    .filter((t) => t.category !== "Sexual Content" && t.category !== "Technical" && t.rank >= 50 && (tb.get(t.name) ?? 0) >= 50)
    .map((t) => ({ name: t.name, w: Math.min(t.rank, tb.get(t.name)!) * idf(s.tags.get(t.name), s.total) }))
    .sort((x, y) => y.w - x.w).slice(0, 3).map((t) => t.name);
  const genres = a.genres.filter((g) => b.genres.includes(g))
    .sort((x, y) => idf(s.genres.get(y), s.total) - idf(s.genres.get(x), s.total)).slice(0, 3);
  const votes = Math.max(a.recs.find((r) => r.id === b.id)?.rating ?? 0, b.recs.find((r) => r.id === a.id)?.rating ?? 0);
  return { tags, genres, votes };
}
