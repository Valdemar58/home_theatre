import "server-only";
import { maintenanceActive, beginMaintenanceWork } from "../maintenance";
import { gql } from "../anilist";
import { db, now, stmt } from "../db";
import { embed, embedAvailable, EMBED_MODEL, LLM_MODEL, taskAvailable, taskRoute } from "../llm";
import { bestOutput, hashOf, produce, type Known } from "../knowledge";
import type { JsonSchema } from "@/lib/json-lite";
import { isStubDescription } from "@/lib/plot";
import { ensureSynopsis, storedSynopsis } from "../plot";
import { shikiInfo, ruDescription } from "../shikimori";
import { isOutage, sourceDown } from "../sources";
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
  // v2: у разборов v1 этих полей нет (undefined) — они не выбрасываются, а улучшаются по желанию
  audience?: string;
  ending_type?: string;
  content_flags?: string[];
  pacing_arc?: string;
  rewatch?: number;
  commitment?: number;
};

export type Profile = { data: ProfileData; analysis: Analysis | null; embedding: number[] | null };

// Версии формы ответа и промпта — только провенанс: старые разборы остаются в работе (adaptAnalysis)
const ANALYSIS_SCHEMA_V = 2;
const ANALYSIS_PROMPT_V = 2;
/** Эмбеддинг по полному профилю: привязан к id текущего разбора — сменился разбор, пересчитали вектор */
const embedV = (analysisSrc: number) => `${EMBED_MODEL}:a${analysisSrc}`;
/** Эмбеддинг только по данным AniList (пока анализа нет) */
const EMBED_DATA_V = () => `${EMBED_MODEL}:data`;
/** Все варианты одной модели — в одном пространстве, поэтому сравнимы между собой */
const usableEmbedding = (v: string | null) => Boolean(v?.startsWith(`${EMBED_MODEL}:`));
const DATA_TTL = 14 * 86400;

/** Старый или неполный разбор → текущая форма (null — непригоден). */
export function adaptAnalysis(raw: unknown): Analysis | null {
  const a = raw as Partial<Analysis> | null;
  if (!a || typeof a.summary_ru !== "string" || typeof a.tone !== "string") return null;
  return {
    ...a,
    summary_ru: a.summary_ru,
    tone: a.tone,
    themes: a.themes ?? [],
    humor: a.humor ?? [],
    pacing: a.pacing ?? "средний",
    setting: a.setting ?? "",
    protagonist: a.protagonist ?? "",
    emotional_intensity: a.emotional_intensity ?? 3,
    complexity: a.complexity ?? 3,
    so_bad_its_good: a.so_bad_its_good ?? 1,
    voice_dependence: a.voice_dependence ?? 2,
    vibes: a.vibes ?? [],
  };
}

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

type Row = {
  anilist_id: number; data: string; analysis: string | null; analysis_v: number | null; embedding: Buffer | null; embed_v: string | null;
  updated_at: number; analysis_src: number | null; analysis_tier: number | null; analysis_hash: string | null;
};

const getRowStmt = stmt<[number], Row>("SELECT * FROM anime_profile WHERE anilist_id = ?");

const toVector = (b: Buffer | null) => (b ? Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)) : null);
const fromVector = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

export function getProfile(id: number): Profile | null {
  const r = getRowStmt().get(id);
  if (!r) return null;
  return {
    data: JSON.parse(r.data) as ProfileData,
    analysis: r.analysis ? adaptAnalysis(JSON.parse(r.analysis)) : null,
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

/** Разборы всех тайтлов (для похожести по ощущению и склейки тем). */
export function allAnalyses(): Map<number, Analysis> {
  const rows = db.prepare<[], { anilist_id: number; analysis: string }>("SELECT anilist_id, analysis FROM anime_profile WHERE analysis IS NOT NULL").all();
  const out = new Map<number, Analysis>();
  for (const r of rows) {
    const a = adaptAnalysis(JSON.parse(r.analysis));
    if (a) out.set(r.anilist_id, a);
  }
  return out;
}

/** Все профили с эмбеддингами (для kNN и графа). */
export function allEmbedded(): { id: number; data: ProfileData; embedding: number[] }[] {
  return db
    .prepare<[string], Row>("SELECT * FROM anime_profile WHERE embed_v LIKE ? AND embedding IS NOT NULL")
    .all(`${EMBED_MODEL}:%`)
    .map((r) => ({ id: r.anilist_id, data: JSON.parse(r.data) as ProfileData, embedding: toVector(r.embedding)! }));
}

function cleanSynopsis(s: string | null): string | null {
  return s ? s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\(Source:[^)]*\)/gi, "").trim().slice(0, 1500) : null;
}

/**
 * Загрузить из AniList данные тайтлов, которых нет или которые устарели. Ждём только отсутствующие: устаревшие
 * обновляются в фоне (рекомендации не ждут AniList); AniList лежит — работаем с тем, что сохранено.
 */
export async function ensureProfileData(ids: number[]): Promise<void> {
  const missing: number[] = [];
  const old: number[] = [];
  for (const id of ids) {
    const r = getRowStmt().get(id);
    if (!r) missing.push(id);
    else if (r.updated_at < now() - DATA_TTL && !refreshingProfiles.has(id)) old.push(id);
  }
  if (sourceDown("anilist")) return;
  if (old.length) {
    old.forEach((id) => refreshingProfiles.add(id));
    void loadProfileData(old).catch(() => undefined).finally(() => old.forEach((id) => refreshingProfiles.delete(id)));
  }
  await loadProfileData(missing).catch((e) => { if (!isOutage(e)) throw e; });
}

const refreshingProfiles = new Set<number>();

async function loadProfileData(stale: number[]): Promise<void> {
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

// Синонимы — варианты, которыми разные модели называют одно и то же значение
const TONE_SYN = {
  "комедия": "комедийный", "драма": "серьёзный", "драматичный": "серьёзный", "мрачно": "мрачный", "тёмный": "мрачный",
  "трэш": "трэш/абсурд", "абсурд": "трэш/абсурд", "абсурдный": "трэш/абсурд", "романтика": "романтичный", "напряженный": "напряжённый",
  "триллер": "напряжённый", "легкий": "лёгкий", "светлый": "лёгкий", "ирония": "ироничный",
};

const ANALYSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary_ru: { type: "string", description: "2–3 предложения: о чём и какое ощущение оставляет" },
    themes: { type: "array", items: { type: "string" }, maxItems: 8, description: "3–8 коротких тем по-русски, 1–3 слова каждая" },
    tone: { type: "string", enum: ["серьёзный", "мрачный", "лёгкий", "комедийный", "ироничный", "трэш/абсурд", "романтичный", "напряжённый"], synonyms: TONE_SYN },
    humor: { type: "array", items: { type: "string", enum: ["нет", "ситуационный", "абсурдный", "пародия", "чёрный", "этти", "словесный", "кринж"] } },
    pacing: { type: "string", enum: ["медленный", "средний", "быстрый"] },
    setting: { type: "string" },
    protagonist: { type: "string", description: "архетип главного героя в 2–5 словах" },
    emotional_intensity: { type: "integer", minimum: 1, maximum: 5 },
    complexity: { type: "integer", minimum: 1, maximum: 5 },
    so_bad_its_good: { type: "integer", minimum: 1, maximum: 5, description: "насколько тайтл смешон своей нелепостью" },
    voice_dependence: { type: "integer", minimum: 1, maximum: 5, description: "насколько впечатление зависит от озвучки и подачи" },
    vibes: { type: "array", items: { type: "string" }, maxItems: 3, description: "3 короткие фразы про атмосферу" },
    audience: { type: "string", enum: ["детская", "подростковая", "взрослая", "для всех"] },
    ending_type: {
      type: "string", enum: ["закрытая", "открытая", "клиффхэнгер", "незавершённая адаптация", "трагичная", "счастливая", "ещё выходит"],
      description: "чем заканчивается этот сезон/фильм (без спойлеров — только тип)",
    },
    content_flags: { type: "array", items: { type: "string", enum: ["нет", "жестокость", "кровь", "фансервис", "этти", "психологическое давление", "смерть персонажей"] } },
    pacing_arc: { type: "string", enum: ["ровный", "медленный старт", "провисает в середине", "ускоряется к финалу"] },
    rewatch: { type: "integer", minimum: 1, maximum: 5, description: "насколько интересно пересматривать" },
    commitment: { type: "integer", minimum: 1, maximum: 5, description: "сколько внимания требует: 1 — можно фоном, 5 — полное погружение" },
  },
  required: [
    "summary_ru", "themes", "tone", "humor", "pacing", "setting", "protagonist", "emotional_intensity", "complexity", "so_bad_its_good",
    "voice_dependence", "vibes", "audience", "ending_type", "content_flags", "pacing_arc", "rewatch", "commitment",
  ],
};

const SYSTEM = `Ты эксперт по аниме. По данным о тайтле делаешь короткий содержательный разбор на русском языке
для системы рекомендаций. Пиши конкретно, без воды и без спойлеров. Если тайтл известен своей нелепостью
(«так плохо, что смешно»), отметь это в so_bad_its_good и тоне. Шкалы 1–5 ставь честно: середина — 3.`;

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

/**
 * Хэш смыслового входа разбора: без оценки и популярности (меняются постоянно); с синопсисом от ИИ/TMDB,
 * если он есть, — появился синопсис вместо заглушки, разбор станет «несвежим» и переделается.
 */
function analysisHash(p: ProfileData): string {
  return hashOf({
    t: p.title, ru: p.titleRu, f: p.format, e: p.episodes, y: p.year, s: p.source, g: p.genres, st: p.studios, syn: p.synopsis,
    tags: p.tags.filter((t) => t.rank >= 50).map((t) => `${t.name}:${Math.round(t.rank / 10)}`),
    plot: storedSynopsis(p.id)?.text ?? null,
  });
}

/** Русское описание (Shikimori, а вместо заглушки — синопсис от ИИ) — для промпта разбора. */
async function enrich(p: ProfileData): Promise<ProfileData> {
  const data = { ...p };
  if (data.idMal && !data.synopsis?.match(/[а-яё]/i)) {
    let ru = await ruDescription(data.idMal).catch(() => null);
    if (isStubDescription(ru)) {
      ru = await ensureSynopsis({
        id: p.id, title: { ru: data.titleRu, english: data.title, romaji: null, native: null }, format: data.format, year: data.year,
        episodes: data.episodes, status: null, nextAiringEpisode: null, en: data.synopsis, stub: ru, prequels: [],
      }).catch(() => null) ?? ru;
    }
    if (ru) data.synopsis = `${ru.slice(0, 1200)}\n\n${data.synopsis ?? ""}`.slice(0, 2000);
  }
  return data;
}

/** Текущий разбор → колонка anime_profile (быстрое чтение без журнала). */
function promoteAnalysis(id: number, k: Known<Analysis>) {
  db.prepare("UPDATE anime_profile SET analysis = ?, analysis_v = ?, analysis_src = ?, analysis_tier = ?, analysis_hash = ? WHERE anilist_id = ?")
    .run(JSON.stringify(k.value), k.prov.schemaV, k.prov.id, k.prov.tier, k.prov.inputHash, id);
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

/**
 * Разбор и/или эмбеддинг одного тайтла. Модель зовётся, только если разбора нет, вход изменился
 * или включено улучшение более сильной моделью (produce); иначе берётся лучший из журнала.
 */
export async function processProfile(id: number, withLLM: boolean): Promise<void> {
  const r = getRowStmt().get(id);
  if (!r) return;
  const data = JSON.parse(r.data) as ProfileData;
  const opts = { inputHash: analysisHash(data), policy: "tier-first" as const, staleOk: true, adapt: adaptAnalysis };
  const known = withLLM
    ? await produce<Analysis>("analysis", `anime:${id}`, {
        ...opts, schemaV: ANALYSIS_SCHEMA_V, promptV: ANALYSIS_PROMPT_V, schema: ANALYSIS_SCHEMA, system: SYSTEM,
        user: async () => analysisPrompt(await enrich(data)), maxTokens: 1500,
      })
    : bestOutput<Analysis>("analysis", `anime:${id}`, opts);
  if (known && known.prov.id !== r.analysis_src) promoteAnalysis(id, known);
  // Эмбеддинг пересчитываем, когда сменился разбор: текст профиля стал другим
  const wanted = known ? embedV(known.prov.id) : EMBED_DATA_V();
  if (r.embed_v !== wanted && (await embedAvailable())) {
    const [vec] = await embed([embedText(data, known?.value ?? null)]);
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
  const finish = beginMaintenanceWork("profiles");
  try {
    while (queue.length) {
      if (maintenanceActive()) break;
      if (!(await taskAvailable("analysis"))) break; // ИИ ещё не готов — продолжим позже
      const id = queue.shift()!;
      queued.delete(id);
      await processProfile(id, true).catch((e) => console.warn(`[reco] профиль ${id}: ${String(e)}`));
    }
  } finally {
    running = false;
    finish();
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
