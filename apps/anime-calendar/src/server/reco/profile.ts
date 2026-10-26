import "server-only";
import { gql } from "../anilist";
import { db, now, stmt } from "../db";
import { embed, embedAvailable, EMBED_MODEL, LLM_MODEL, runTask, taskAvailable, taskRoute } from "../llm";
import type { JsonSchema } from "@/lib/json-lite";
import { isStubDescription } from "@/lib/plot";
import { ensureSynopsis } from "../plot";
import { shikiInfo, ruDescription } from "../shikimori";
import { similarityIdf, type SimilarityIdf } from "./math";

// Профиль тайтла для рекомендаций и графа: данные AniList + анализ локальной LLM + эмбеддинг.

export type ProfileData = {
  id: number;
  idMal: number | null;
  title: string;
  titleRu: string | null;
  format: string | null;
  episodes: number | null;
  year: number | null;
  source: string | null;
  country: string | null;
  isAdult: boolean;
  score: number | null;
  popularity: number;
  genres: string[];
  tags: { name: string; rank: number; category: string }[];
  studios: string[];
  staff: { role: string; name: string }[];
  synopsis: string | null;
  cover: string | null;
  color: string | null;
  /** Рекомендации сообщества AniList: «если понравилось это — посмотри то» */
  recs: { id: number; rating: number }[];
  relations: { id: number; type: string }[];
};

export type Analysis = {
  summary_ru: string;
  themes: string[];
  tone: string;
  humor: string[];
  pacing: string;
  setting: string;
  protagonist: string;
  emotional_intensity: number;
  complexity: number;
  so_bad_its_good: number;
  voice_dependence: number;
  vibes: string[];
};

export type Profile = { data: ProfileData; analysis: Analysis | null; embedding: number[] | null };

// Версии: при смене промпта или модели профили пересчитываются
const ANALYSIS_V = 1;
/** Эмбеддинг по полному профилю (с анализом LLM) */
const EMBED_V = () => `${EMBED_MODEL}:${ANALYSIS_V}`;
/** Эмбеддинг только по данным AniList (пока анализа нет) */
const EMBED_DATA_V = () => `${EMBED_MODEL}:data`;
/** Оба варианта в одном пространстве модели, поэтому сравнимы между собой */
const usableEmbedding = (v: string | null) => v === EMBED_V() || v === EMBED_DATA_V();
const DATA_TTL = 14 * 86400;

const PROFILE_QUERY = `
query ($ids: [Int], $page: Int) {
  Page(page: $page, perPage: 25) {
    media(id_in: $ids, type: ANIME) {
      id idMal format episodes source seasonYear countryOfOrigin isAdult averageScore popularity genres
      title { romaji english }
      description(asHtml: false)
      coverImage { large color }
      tags { name rank category isMediaSpoiler }
      studios(isMain: true) { nodes { name } }
      staff(perPage: 6, sort: RELEVANCE) { edges { role node { name { full } } } }
      recommendations(perPage: 20, sort: RATING_DESC) { nodes { rating mediaRecommendation { id type } } }
      relations { edges { relationType node { id type } } }
    }
  }
}`;

type RawProfile = {
  id: number; idMal: number | null; format: string | null; episodes: number | null; source: string | null;
  seasonYear: number | null; countryOfOrigin: string | null; isAdult: boolean; averageScore: number | null;
  popularity: number; genres: string[]; title: { romaji: string | null; english: string | null };
  description: string | null; coverImage: { large: string | null; color: string | null };
  tags: { name: string; rank: number; category: string; isMediaSpoiler: boolean }[];
  studios: { nodes: { name: string }[] };
  staff: { edges: { role: string; node: { name: { full: string } } }[] };
  recommendations: { nodes: { rating: number; mediaRecommendation: { id: number; type: string } | null }[] };
  relations: { edges: { relationType: string; node: { id: number; type: string } }[] };
};

type Row = { anilist_id: number; data: string; analysis: string | null; analysis_v: number | null; embedding: Buffer | null; embed_v: string | null; updated_at: number };

const getRowStmt = stmt<[number], Row>("SELECT * FROM anime_profile WHERE anilist_id = ?");

const toVector = (b: Buffer | null) => (b ? Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)) : null);
const fromVector = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

export function getProfile(id: number): Profile | null {
  const r = getRowStmt().get(id);
  if (!r) return null;
  return {
    data: JSON.parse(r.data) as ProfileData,
    analysis: r.analysis && r.analysis_v === ANALYSIS_V ? (JSON.parse(r.analysis) as Analysis) : null,
    embedding: usableEmbedding(r.embed_v) ? toVector(r.embedding) : null,
  };
}

export function getProfiles(ids: number[]): Map<number, Profile> {
  const out = new Map<number, Profile>();
  for (const id of ids) {
    const p = getProfile(id);
    if (p) out.set(id, p);
  }
  return out;
}

let idfCache: { at: number; value: SimilarityIdf } | null = null;
/** Частоты тегов и жанров по базе профилей (пересчёт раз в час — база растёт). */
export function idfSpace(): SimilarityIdf {
  if (idfCache && Date.now() - idfCache.at < 3600_000) return idfCache.value;
  idfCache = { at: Date.now(), value: similarityIdf(allProfileData().filter((d) => !d.isAdult)) };
  return idfCache.value;
}

/** Данные всех профилей (для похожести тайтлов по тегам). */
export function allProfileData(): ProfileData[] {
  return db.prepare<[], { data: string }>("SELECT data FROM anime_profile").all().map((r) => JSON.parse(r.data) as ProfileData);
}

/** Все профили с эмбеддингами (для kNN и графа). */
export function allEmbedded(): { id: number; data: ProfileData; embedding: number[] }[] {
  return db
    .prepare<[string, string], Row>("SELECT * FROM anime_profile WHERE embed_v IN (?, ?) AND embedding IS NOT NULL")
    .all(EMBED_V(), EMBED_DATA_V())
    .map((r) => ({ id: r.anilist_id, data: JSON.parse(r.data) as ProfileData, embedding: toVector(r.embedding)! }));
}

function cleanSynopsis(s: string | null): string | null {
  return s ? s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\(Source:[^)]*\)/gi, "").trim().slice(0, 1500) : null;
}

/** Загрузить из AniList данные тайтлов, которых нет или которые устарели. */
export async function ensureProfileData(ids: number[]): Promise<void> {
  const stale = ids.filter((id) => {
    const r = getRowStmt().get(id);
    return !r || r.updated_at < now() - DATA_TTL;
  });
  for (let i = 0; i < stale.length; i += 25) {
    const batch = stale.slice(i, i + 25);
    const data = await gql<{ Page: { media: RawProfile[] } }>(PROFILE_QUERY, { ids: batch, page: 1 });
    const ru = await shikiInfo(data.Page.media.map((m) => m.idMal).filter((x): x is number => Boolean(x)));
    const put = db.prepare(
      `INSERT INTO anime_profile (anilist_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(anilist_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
    for (const m of data.Page.media) {
      const p: ProfileData = {
        id: m.id,
        idMal: m.idMal,
        title: m.title.english ?? m.title.romaji ?? `#${m.id}`,
        titleRu: m.idMal ? ru.get(m.idMal)?.russian ?? null : null,
        format: m.format,
        episodes: m.episodes,
        year: m.seasonYear,
        source: m.source,
        country: m.countryOfOrigin,
        isAdult: m.isAdult,
        score: (m.idMal ? ru.get(m.idMal)?.score : null) ?? (m.averageScore ? m.averageScore / 10 : null),
        popularity: m.popularity ?? 0,
        genres: m.genres ?? [],
        tags: (m.tags ?? []).filter((t) => !t.isMediaSpoiler).map((t) => ({ name: t.name, rank: t.rank, category: t.category })),
        studios: m.studios.nodes.map((s) => s.name),
        staff: m.staff.edges.map((e) => ({ role: e.role, name: e.node.name.full })),
        synopsis: cleanSynopsis(m.description),
        cover: m.coverImage.large,
        color: m.coverImage.color,
        recs: m.recommendations.nodes
          .filter((n) => n.mediaRecommendation?.type === "ANIME" && n.rating > 0)
          .map((n) => ({ id: n.mediaRecommendation!.id, rating: n.rating })),
        relations: m.relations.edges.filter((e) => e.node.type === "ANIME").map((e) => ({ id: e.node.id, type: e.relationType })),
      };
      put.run(m.id, JSON.stringify(p), now());
    }
  }
}

// ---------------------------------------------------------------- анализ LLM

const ANALYSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary_ru: { type: "string", description: "2–3 предложения: о чём и какое ощущение оставляет" },
    themes: { type: "array", items: { type: "string" }, description: "3–8 коротких тем по-русски" },
    tone: { type: "string", enum: ["серьёзный", "мрачный", "лёгкий", "комедийный", "ироничный", "трэш/абсурд", "романтичный", "напряжённый"] },
    humor: { type: "array", items: { type: "string", enum: ["нет", "ситуационный", "абсурдный", "пародия", "чёрный", "этти", "словесный", "кринж"] } },
    pacing: { type: "string", enum: ["медленный", "средний", "быстрый"] },
    setting: { type: "string" },
    protagonist: { type: "string", description: "архетип главного героя в 2–5 словах" },
    emotional_intensity: { type: "integer", minimum: 1, maximum: 5 },
    complexity: { type: "integer", minimum: 1, maximum: 5 },
    so_bad_its_good: { type: "integer", minimum: 1, maximum: 5, description: "насколько тайтл смешон своей нелепостью" },
    voice_dependence: { type: "integer", minimum: 1, maximum: 5, description: "насколько впечатление зависит от озвучки и подачи" },
    vibes: { type: "array", items: { type: "string" }, description: "3 короткие фразы про атмосферу" },
  },
  required: ["summary_ru", "themes", "tone", "humor", "pacing", "setting", "protagonist", "emotional_intensity", "complexity", "so_bad_its_good", "voice_dependence", "vibes"],
};

const SYSTEM = `Ты эксперт по аниме. По данным о тайтле делаешь короткий содержательный разбор на русском языке
для системы рекомендаций. Пиши конкретно, без воды и без спойлеров. Если тайтл известен своей нелепостью
(«так плохо, что смешно»), отметь это в so_bad_its_good и тоне.`;

function analysisPrompt(p: ProfileData): string {
  const tags = p.tags.filter((t) => t.rank >= 50).slice(0, 15).map((t) => `${t.name} (${t.rank})`).join(", ");
  return [
    `Название: ${p.title}${p.titleRu ? ` / ${p.titleRu}` : ""}`,
    `Формат: ${p.format ?? "?"}, серий: ${p.episodes ?? "?"}, год: ${p.year ?? "?"}, первоисточник: ${p.source ?? "?"}`,
    `Жанры: ${p.genres.join(", ")}`,
    `Теги AniList (ранг 0–100): ${tags}`,
    `Студии: ${p.studios.join(", ") || "?"}; создатели: ${p.staff.map((s) => `${s.name} — ${s.role}`).join("; ")}`,
    `Оценка: ${p.score ?? "?"}/10, популярность: ${p.popularity}`,
    `Синопсис: ${p.synopsis ?? "нет"}`,
  ].join("\n");
}

/** Текст для эмбеддинга: суть тайтла словами (анализ, если есть, + теги и синопсис). */
function embedText(p: ProfileData, a: Analysis | null): string {
  const tags = p.tags.filter((t) => t.rank >= 40).map((t) => t.name).join(", ");
  return [
    p.title,
    `Жанры: ${p.genres.join(", ")}. Теги: ${tags}.`,
    a ? `Тон: ${a.tone}. Юмор: ${a.humor.join(", ")}. Темп: ${a.pacing}. Темы: ${a.themes.join(", ")}. ${a.summary_ru} ${a.vibes.join(". ")}.` : "",
    a && a.so_bad_its_good >= 4 ? "Так плохо, что смешно." : "",
    p.synopsis ?? "",
  ].filter(Boolean).join("\n").slice(0, 3000);
}

/** Проанализировать и/или посчитать эмбеддинг одного тайтла. */
export async function processProfile(id: number, withLLM: boolean): Promise<void> {
  const r = getRowStmt().get(id);
  if (!r) return;
  const data = JSON.parse(r.data) as ProfileData;
  let analysis = r.analysis && r.analysis_v === ANALYSIS_V ? (JSON.parse(r.analysis) as Analysis) : null;
  if (!analysis && withLLM) {
    // Русское описание с Shikimori подробнее и точнее для анализа
    if (data.idMal && !data.synopsis?.match(/[а-яё]/i)) {
      let ru = await ruDescription(data.idMal).catch(() => null);
      // Заглушка («Второй сезон …») — синопсис от ИИ по описанию AniList и первым сериям
      if (isStubDescription(ru)) {
        ru = await ensureSynopsis({
          id, title: { ru: data.titleRu, english: data.title, romaji: null, native: null }, format: data.format, year: data.year,
          episodes: data.episodes, status: null, nextAiringEpisode: null, en: data.synopsis, stub: ru, prequels: [],
        }).catch(() => null) ?? ru;
      }
      if (ru) data.synopsis = `${ru.slice(0, 1200)}\n\n${data.synopsis ?? ""}`.slice(0, 2000);
    }
    analysis = (await runTask<Analysis>("analysis", { schema: ANALYSIS_SCHEMA, system: SYSTEM, user: analysisPrompt(data) })).value;
    db.prepare("UPDATE anime_profile SET analysis = ?, analysis_v = ? WHERE anilist_id = ?").run(JSON.stringify(analysis), ANALYSIS_V, id);
  }
  // Эмбеддинг пересчитываем, когда появился анализ: текст профиля стал полнее
  const wanted = analysis ? EMBED_V() : EMBED_DATA_V();
  if (r.embed_v !== wanted && (await embedAvailable())) {
    const [vec] = await embed([embedText(data, analysis)]);
    db.prepare("UPDATE anime_profile SET embedding = ?, embed_v = ? WHERE anilist_id = ?").run(fromVector(vec), wanted, id);
  }
}

// ---------------------------------------------------------------- фоновая очередь

const queue: number[] = [];
const queued = new Set<number>();
let running = false;

export type QueueStatus = { pending: number; running: boolean; model: string; llm: boolean };

export async function queueStatus(): Promise<QueueStatus> {
  const route = await taskRoute("analysis");
  return { pending: queue.length, running, model: route[0]?.model ?? LLM_MODEL, llm: route.length > 0 };
}

/** Поставить тайтлы в очередь анализа. priority — в начало (мои списки). */
export function enqueueProfiles(ids: number[], priority = false) {
  const fresh = ids.filter((id) => !queued.has(id));
  for (const id of fresh) queued.add(id);
  if (priority) queue.unshift(...fresh);
  else queue.push(...fresh);
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      if (!(await taskAvailable("analysis"))) break; // ИИ ещё не готов — продолжим позже
      const id = queue.shift()!;
      queued.delete(id);
      await processProfile(id, true).catch((e) => console.warn(`[reco] профиль ${id}: ${String(e)}`));
    }
  } finally {
    running = false;
  }
}

/** Эмбеддинги без LLM-анализа (быстро): нужны, чтобы рекомендации работали сразу. */
export async function quickEmbed(ids: number[]): Promise<void> {
  if (!(await embedAvailable())) return; // без модели эмбеддингов работает «только по тегам»
  const need = ids.filter((id) => {
    const r = getRowStmt().get(id);
    return r && !usableEmbedding(r.embed_v);
  });
  for (let i = 0; i < need.length; i += 16) {
    const batch = need.slice(i, i + 16).map((id) => ({ id, data: JSON.parse(getRowStmt().get(id)!.data) as ProfileData }));
    const vecs = await embed(batch.map((b) => embedText(b.data, null)));
    const put = db.prepare("UPDATE anime_profile SET embedding = ?, embed_v = ? WHERE anilist_id = ?");
    batch.forEach((b, n) => put.run(fromVector(vecs[n]), EMBED_DATA_V(), b.id));
  }
}
