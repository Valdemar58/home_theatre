import "server-only";
import type { MatchInfo, SimilarItem, TasteMatch } from "@/lib/types";
import { gql, mediaByIds } from "../anilist";
import { cached, getCached } from "../cache";
import { getMedia, saveMedia, withShikimori } from "../lists";
import { ironicTaste, loadTaste, vibeOf } from "./engine";
import { featuresOf, featuresOfAnalysis, userFeatureAffinity } from "./features";
import { topTraits, vibeLift, vibeSimilarity } from "@/lib/analysis-features";
import {
  communityScore, cosine, genreVector, hybridScore, sparseCosine, tagAffinity, tagScore, tagVector,
  tasteVector, titleSimilarity, type Vector,
} from "./math";
import { allAnalyses, allEmbedded, allProfileData, ensureProfileData, idfSpace, getProfile, getProfiles, quickEmbed, type Profile, type ProfileData } from "./profile";

// Персональное для карточки тайтла: «насколько мне понравится» и «похожее».
// Без LLM: вектор вкуса, теги и рекомендации сообщества — те же составляющие, что у подборки «Для тебя».
//
// Две поправки к «сырым» числам:
//  • эмбеддинги центрируются (вычитается средний вектор базы): у bge-m3 все векторы сдвинуты в одну
//    сторону, без этого всё «похоже» на всё (и на один и тот же «центральный» тайтл);
//  • процент — это перцентиль: «подходит лучше, чем N% из 500 самых популярных аниме», а не
//    абсолютный балл, который у всех тайтлов лежит в узкой полосе. Выборка нейтральная: база
//    профилей растёт вокруг вкуса пользователя (граф), сравнение с ней занижало бы мейнстрим.

const LIKE = 0.15;
const titleOf = (d: ProfileData) => d.titleRu ?? d.title;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------- пространство эмбеддингов

type Space = { center: Vector; ids: number[]; centered: Map<number, Vector> };
let space: { at: number; value: Space } | null = null;

/** Средний вектор базы и центрированные эмбеддинги (пересчёт раз в час — база растёт). */
function embeddingSpace(): Space {
  if (space && Date.now() - space.at < 3600_000) return space.value;
  const all = allEmbedded().filter((e) => !e.data.isAdult);
  const dim = all[0]?.embedding.length ?? 0;
  const center = new Array<number>(dim).fill(0);
  for (const e of all) e.embedding.forEach((x, i) => (center[i] += x / all.length));
  const centered = new Map(all.map((e) => [e.id, e.embedding.map((x, i) => x - center[i])]));
  space = { at: Date.now(), value: { center, ids: all.map((e) => e.id), centered } };
  return space.value;
}

const centeredOf = (s: Space, id: number, p: Profile | null | undefined): Vector | null =>
  s.centered.get(id) ?? (p?.embedding ? p.embedding.map((x, i) => x - (s.center[i] ?? 0)) : null);

// ---------------------------------------------------------------- нейтральная выборка для перцентиля

const POPULAR_KEY = "reference:popular:v1";
const POPULAR = `query ($page: Int) { Page(page: $page, perPage: 50) {
  media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) { id } } }`;

/** 500 самых популярных аниме: профили и эмбеддинги (фоновая задача, раз в неделю). */
export async function warmReference(): Promise<void> {
  const ids = await cached(POPULAR_KEY, 7 * 86400, async () => {
    const out: number[] = [];
    for (let page = 1; page <= 10; page++) {
      out.push(...(await gql<{ Page: { media: { id: number }[] } }>(POPULAR, { page })).Page.media.map((m) => m.id));
    }
    return out;
  });
  await ensureProfileData(ids);
  await quickEmbed(ids);
}

// ---------------------------------------------------------------- модель вкуса

type Model = {
  taste: Vector | null;
  aff: Map<string, number>;
  /** Склонности по признакам разборов LLM */
  faff: Map<string, number>;
  weights: Map<number, number>;
  profiles: Map<number, Profile>;
  status: Map<number, { status: string; score: number }>;
  /** Рекомендации сообщества: id → сумма весов понравившихся, у которых он в «смотри также» */
  community: Map<number, number>;
  /** Сырые баллы тайтлов базы (не из моего списка), по возрастанию — для перцентиля */
  reference: number[];
  liked: number;
};

const models = new Map<number, { hash: string; at: number; model: Model }>();

async function modelFor(userId: number): Promise<Model> {
  const t = await loadTaste(userId);
  const hit = models.get(userId);
  if (hit?.hash === t.hash && Date.now() - hit.at < 3600_000) return hit.model;
  const s = embeddingSpace();
  const items = [...t.weights];
  const community = new Map<number, number>();
  for (const [id, w] of items) {
    if (w <= LIKE) continue;
    for (const rec of t.profiles.get(id)?.data.recs ?? []) community.set(rec.id, (community.get(rec.id) ?? 0) + w * Math.log1p(rec.rating));
  }
  const model: Model = {
    taste: tasteVector(items.map(([id, weight]) => ({ weight, embedding: centeredOf(s, id, t.profiles.get(id)) ?? [] }))),
    aff: tagAffinity(items.map(([id, weight]) => ({ weight, tags: t.profiles.get(id)?.data.tags ?? [] }))),
    faff: userFeatureAffinity(t.weights, t.profiles, ironicTaste(t.rows)),
    weights: t.weights,
    profiles: t.profiles,
    status: new Map(t.rows.map((r) => [r.anilist_id, { status: r.status, score: r.score }])),
    community,
    reference: [],
    liked: items.filter(([, w]) => w > LIKE).length,
  };
  // Выборка для перцентиля: популярное (если уже прогрето), иначе вся база
  const popular = (getCached<number[]>(POPULAR_KEY, true) ?? []).filter((id) => s.centered.has(id));
  const pool = popular.length >= 100 ? popular : s.ids;
  const refProfiles = getProfiles(pool.filter((id) => !model.status.has(id)));
  model.reference = [...refProfiles].map(([id, p]) => raw(model, s, id, p)).sort((a, b) => a - b);
  models.set(userId, { hash: t.hash, at: Date.now(), model });
  return model;
}

/** Сырой балл 0–100 из составляющих (как в подборке «Для тебя»). */
function raw(m: Model, s: Space, id: number, p: Profile): number {
  const v = centeredOf(s, id, p);
  const c = m.community.get(id) ?? 0;
  return hybridScore({
    similarity: m.taste && v ? clamp01((cosine(m.taste, v) + 0.1) / 0.5) : 0.3,
    tags: (tagScore(p.data.tags, m.aff) + 1) / 2,
    community: c / (c + 3),
    quality: p.data.score ? clamp01((p.data.score - 6) / 3) : 0.3,
    vibe: vibeOf(p, m.faff),
  });
}

/** Перцентиль среди тайтлов базы: «подходит лучше, чем N%». */
function percentile(m: Model, value: number): number {
  const ref = m.reference;
  if (ref.length < 30) return value; // базы мало — честнее показать сырой балл
  let lo = 0;
  let hi = ref.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ref[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / ref.length) * 100);
}

/** Профили с эмбеддингом (эмбеддинг по данным AniList считается на лету, если его ещё нет). */
async function profilesWithEmbedding(ids: number[]): Promise<Map<number, Profile>> {
  await ensureProfileData(ids);
  const missing = ids.filter((id) => !getProfile(id)?.embedding);
  if (missing.length) await quickEmbed(missing).catch(() => undefined);
  return getProfiles(ids);
}

const VERDICTS: [number, string][] = [[85, "скорее всего понравится"], [65, "может зайти"], [40, "50 на 50"], [0, "вряд ли зайдёт"]];

/** «Насколько мне понравится»: перцентиль и объяснение без LLM. */
export async function matchFor(userId: number, id: number): Promise<MatchInfo> {
  const m = await modelFor(userId);
  const p = (await profilesWithEmbedding([id])).get(id);
  if (!p) throw new Error("Нет данных о тайтле");
  const s = embeddingSpace();
  const percent = percentile(m, raw(m, s, id, p));
  const v = centeredOf(s, id, p);

  // Почему: ближайшие по содержанию из понравившегося / из брошенного и нелюбимого
  const near = (liked: boolean) => [...m.weights]
    .filter(([other, w]) => other !== id && (liked ? w > LIKE : w < -LIKE))
    .map(([other]) => {
      const ov = centeredOf(s, other, m.profiles.get(other));
      return { other, sim: v && ov ? cosine(v, ov) : 0 };
    })
    .filter((x) => x.sim > (liked ? 0.12 : 0.25))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3)
    .map(({ other }) => ({ id: other, title: titleOf(m.profiles.get(other)!.data) }));
  const tags = p.data.tags.filter((t) => t.rank >= 50);
  const f = featuresOf(p);
  return {
    percent,
    verdict: VERDICTS.find(([min]) => percent >= min)![1],
    similarTo: near(true),
    dislikedSimilar: near(false),
    likedTags: tags.filter((t) => (m.aff.get(t.name) ?? 0) > 0.25).slice(0, 4).map((t) => t.name),
    dislikedTags: tags.filter((t) => (m.aff.get(t.name) ?? 0) < -0.25).slice(0, 3).map((t) => t.name),
    likedTraits: f ? topTraits(f, m.faff, 4, 1) : [],
    dislikedTraits: f ? topTraits(f, m.faff, 3, -1) : [],
    lowConfidence: m.liked < 5,
  };
}

// ---------------------------------------------------------------- похожее

/** Ниже — не показываем: совпадают разве что общие жанры. */
const MIN_SIMILARITY = 35;

// Первый сезон франшизы: подъём по «предыстории»/«основной истории» (сезоны, части, OVA → корень)
const UP = new Set(["PREQUEL", "PARENT"]);

/** Корень франшизы для каждого тайтла (профили догружаются пачками по уровням). */
async function franchiseRoots(ids: number[]): Promise<Map<number, number>> {
  const root = new Map(ids.map((id) => [id, id]));
  const seen = new Map(ids.map((id) => [id, new Set([id])]));
  let frontier = [...new Set(ids)];
  for (let step = 0; step < 8 && frontier.length; step++) {
    await ensureProfileData(frontier);
    const profiles = getProfiles(frontier);
    const next = new Set<number>();
    for (const id of ids) {
      const cur = root.get(id)!;
      if (!frontier.includes(cur)) continue;
      const up = profiles.get(cur)?.data.relations.find((r) => UP.has(r.type) && !seen.get(id)!.has(r.id));
      if (!up) continue;
      root.set(id, up.id);
      seen.get(id)!.add(up.id);
      next.add(up.id);
    }
    frontier = [...next];
  }
  return root;
}

type SimilarCand = { id: number; similarity: number };

/**
 * Похожие на тайтл (не на пользователя), сутки в кэше. Кандидаты — вся база профилей
 * (каталог вокруг ваших списков + 500 популярных) и все рекомендации сообщества к тайтлу;
 * похожесть — теги, жанры и голоса сообщества в обе стороны (math.ts titleSimilarity).
 */
function similarCandidates(id: number): Promise<SimilarCand[]> {
  // v6 — с ощущением по разбору LLM (тон, юмор, темп), если оба тайтла разобраны
  return cached(`similar:v6:${id}`, 86400, async () => {
    await ensureProfileData([id]);
    const p = getProfile(id);
    if (!p) return [];
    await ensureProfileData(p.data.recs.map((r) => r.id));
    const s = idfSpace();
    const all = new Map(allProfileData().filter((d) => !d.isAdult).map((d) => [d.id, d]));
    // Сиквелы и приквелы уже в «Связанном»
    const related = new Set([id, ...p.data.relations.map((r) => r.id)]);
    const tags = tagVector(p.data.tags, s);
    const genres = genreVector(p.data.genres, s);
    const analyses = allAnalyses();
    const vibe = featuresOf(p);
    const scored = [...all.values()].filter((o) => !related.has(o.id)).map((o) => ({
      id: o.id,
      similarity: titleSimilarity({
        tags: sparseCosine(tags, tagVector(o.tags, s)),
        genres: sparseCosine(genres, genreVector(o.genres, s)),
        community: communityScore(p.data.recs, id, o.recs, o.id),
        vibe: vibe && analyses.has(o.id) ? vibeLift(vibeSimilarity(vibe, featuresOfAnalysis(analyses.get(o.id)!))) : undefined,
      }),
    })).filter((c) => c.similarity >= MIN_SIMILARITY).sort((a, b) => b.similarity - a.similarity).slice(0, 60);
    // Франшизы: свою исключаем целиком, чужие схлопываем в первый сезон (с лучшей похожестью из частей)
    const roots = await franchiseRoots([id, ...scored.map((c) => c.id)]);
    const own = roots.get(id)!;
    const best = new Map<number, number>();
    for (const c of scored) {
      const r = roots.get(c.id)!;
      if (r === own || related.has(r)) continue;
      best.set(r, Math.max(best.get(r) ?? 0, c.similarity));
    }
    await ensureProfileData([...best.keys()]);
    const rootProfiles = getProfiles([...best.keys()]);
    return [...best].filter(([r]) => rootProfiles.get(r) && !rootProfiles.get(r)!.data.isAdult)
      .map(([r, similarity]) => ({ id: r, similarity }))
      .sort((a, b) => b.similarity - a.similarity).slice(0, 24);
  });
}

/** «Похожее» для карточки: сначала непросмотренное, потом просмотренное (с моим статусом). */
export async function similarFor(userId: number, id: number): Promise<SimilarItem[]> {
  const [cands, m] = await Promise.all([similarCandidates(id), modelFor(userId)]);
  const missing = cands.map((c) => c.id).filter((c) => !getMedia(c));
  if (missing.length) saveMedia(await withShikimori(await mediaByIds(missing)));
  const profiles = getProfiles(cands.map((c) => c.id));
  const s = embeddingSpace();
  const items: SimilarItem[] = cands.flatMap((c) => {
    const media = getMedia(c.id);
    const p = profiles.get(c.id);
    if (!media || !p) return [];
    const mine = m.status.get(c.id);
    const watched = Boolean(mine && mine.status !== "planned");
    return [{ media, similarity: c.similarity, match: watched ? null : percentile(m, raw(m, s, c.id, p)), watched }];
  });
  // Просмотренное — только заметно похожее: оно для сравнения «похоже ли на то, что понравилось»
  return [...items.filter((i) => !i.watched).slice(0, 12), ...items.filter((i) => i.watched).slice(0, 6)];
}

// ---------------------------------------------------------------- совпадение вкусов двух пользователей

const MIN_COMMON = 5;
// Модели пересобираются при изменении списка — совпадение по тем же объектам моделей значит «ничего не менялось»
const tasteCache = new Map<string, { models: [Model, Model]; value: TasteMatch }>();

/**
 * Насколько вкусы a и b совпадают. Две составляющие:
 *  • перекрёстный прогноз — понравившееся одному глазами модели вкуса другого (перцентиль, в обе стороны;
 *    если тайтл уже в списке у второго — берётся его реальное отношение);
 *  • согласие оценок по общим тайтлам (если их хватает): средняя разница баллов → 0–100.
 */
export async function tasteMatch(a: number, b: number, privateOf: (userId: number) => Set<number>): Promise<TasteMatch | null> {
  const [ma, mb] = [await modelFor(a), await modelFor(b)];
  if (ma.liked < 3 || mb.liked < 3) return null;
  const key = `${a}:${b}`;
  const hit = tasteCache.get(key);
  if (hit && hit.models[0] === ma && hit.models[1] === mb) return hit.value;
  const s = embeddingSpace();

  const cross = (m: Model, other: Model) => {
    const liked = [...other.weights].filter(([, w]) => w > LIKE).sort((x, y) => y[1] - x[1]).slice(0, 60);
    const vals = liked.map(([id]) => {
      const own = m.weights.get(id);
      if (own !== undefined) return own > LIKE ? 100 : own < -LIKE ? 0 : 50;
      const p = other.profiles.get(id);
      return p ? percentile(m, raw(m, s, id, p)) : null;
    }).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 50;
  };
  const predict = (cross(ma, mb) + cross(mb, ma)) / 2;

  const common = [...ma.status].filter(([id, e]) => e.score > 0 && (mb.status.get(id)?.score ?? 0) > 0);
  const agree = common.length >= MIN_COMMON
    ? Math.round(Math.max(0, 1 - common.reduce((sum, [id, e]) => sum + Math.abs(e.score - mb.status.get(id)!.score), 0) / common.length / 4) * 100)
    : null;
  const percent = Math.round(agree === null ? predict : 0.6 * predict + 0.4 * agree);

  const hidden = new Set([...privateOf(a), ...privateOf(b)]);
  const bothLiked = [...ma.weights]
    .filter(([id, w]) => w > LIKE && (mb.weights.get(id) ?? 0) > LIKE && !hidden.has(id))
    .sort((x, y) => y[1] + (mb.weights.get(y[0]) ?? 0) - x[1] - (mb.weights.get(x[0]) ?? 0))
    .slice(0, 6)
    .map(([id]) => ({ id, title: titleOf(ma.profiles.get(id)!.data) }));

  const value = { percent, common: common.length, agree, bothLiked };
  tasteCache.set(key, { models: [ma, mb], value });
  return value;
}

/** Проценты «насколько понравится» для многих тайтлов сразу — те же, что в плашке на странице тайтла. */
export async function percentsFor(userId: number, ids: number[]): Promise<Map<number, number>> {
  const m = await modelFor(userId);
  const s = embeddingSpace();
  const profiles = await profilesWithEmbedding(ids);
  return new Map([...profiles].map(([id, p]) => [id, percentile(m, raw(m, s, id, p))]));
}
