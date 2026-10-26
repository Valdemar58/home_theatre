import "server-only";
import { createHash } from "node:crypto";
import { db, now } from "../db";
import { embedAvailable, runTask, taskAvailable } from "../llm";
import { bestOutput, hashOf, produce, recordOutput } from "../knowledge";
import { featureScore } from "@/lib/analysis-features";
import { featuresOf, userFeatureAffinity } from "./features";
import type { JsonSchema } from "@/lib/json-lite";
import { getRows, parseTags, type EntryRow } from "../lists";
import {
  cosine, entryWeight, hybridScore, meanScore, sharedTraits, tagAffinity, tagScore, tasteVector, type SharedTraits, type TasteEntry,
} from "./math";
import { allEmbedded, enqueueProfiles, ensureProfileData, getProfiles, idfSpace, quickEmbed, type Profile, type ProfileData } from "./profile";

// Рекомендации: вкус пользователя (оценки, статусы, личные теги и заметки) → кандидаты →
// гибридный балл → переранжирование и объяснения локальной LLM.

export type Portrait = {
  portrait_ru: string;
  likes: string[];
  dislikes: string[];
  ironic_enjoyment: boolean;
  voice_matters: boolean;
  preferred_voices: string[];
};

export type Recommendation = {
  id: number;
  title: string;
  titleRu: string | null;
  cover: string | null;
  color: string | null;
  format: string | null;
  year: number | null;
  episodes: number | null;
  score: number | null;
  genres: string[];
  /** Итоговый балл 0–100 */
  match: number;
  /** Объяснение LLM (пусто, пока LLM не переранжировала) */
  reason: string;
  /** Тайтлы из моих списков, от которых пришла рекомендация, и что у них общего (части франшизы схлопнуты) */
  basedOn: ({ id: number; title: string } & SharedTraits)[];
  /** Для рекомендаций по содержанию (без оснований): мои любимые темы, которые есть у тайтла */
  likedTags: string[];
  /** Из моего списка «Запланировано» */
  planned: boolean;
};

export type RecoResponse = {
  portrait: Portrait | null;
  /** Портрет по прошлой версии списка (ИИ сейчас недоступен) и когда он составлен */
  portraitStale?: boolean;
  portraitAt?: number | null;
  items: Recommendation[];
  stats: { rated: number; profiled: number; analyzed: number; llm: boolean; generatedAt: number };
};

type Taste = {
  rows: EntryRow[];
  weights: Map<number, number>;
  profiles: Map<number, Profile>;
  hash: string;
};

const LIKE = 0.15;

function listHash(rows: EntryRow[]): string {
  const sig = rows.map((r) => `${r.anilist_id}:${r.status}:${r.score}:${r.episodes}:${r.tags}:${r.note ?? ""}:${r.voice ?? ""}:${r.recommend ?? ""}`).sort().join("|");
  // p2 — портрет без выдуманных флагов иронии/озвучки; p3/p4 — «что общего» у рекомендаций; p5 — признаки разбора в балле
  return createHash("sha1").update(`p5|${sig}`).digest("hex");
}

async function loadTaste(userId: number): Promise<Taste> {
  const rows = getRows(userId);
  const ids = rows.map((r) => r.anilist_id);
  await ensureProfileData(ids);
  const profiles = getProfiles(ids);
  const entries: TasteEntry[] = rows.map((r) => ({
    status: r.status, score: r.score, episodes: r.episodes,
    totalEpisodes: profiles.get(r.anilist_id)?.data.episodes ?? null, tags: parseTags(r.tags),
    recommend: r.recommend === null ? null : Boolean(r.recommend),
  }));
  const mean = meanScore(entries);
  const weights = new Map(rows.map((r, i) => [r.anilist_id, entryWeight(entries[i], mean)]));
  return { rows, weights, profiles, hash: listHash(rows) };
}

const titleOf = (d: ProfileData) => d.titleRu ?? d.title;

// ---------------------------------------------------------------- портрет вкуса

const PORTRAIT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    portrait_ru: { type: "string", description: "3–5 предложений о вкусе: что нравится, за что, что раздражает" },
    likes: { type: "array", items: { type: "string" }, description: "что нравится, короткими пунктами" },
    dislikes: { type: "array", items: { type: "string" } },
  },
  required: ["portrait_ru", "likes", "dislikes"],
};

// Ирония и озвучка — из данных, а не от LLM: обязательное поле «да/нет» модель заполняла «да»
// без оснований (а промпт сам подсказывал эти слова)
const IRONIC_TAGS = ["так плохо, что смешно", "guilty pleasure"];

/** Совпадение разбора кандидата со склонностями, 0–1 (нет разбора или склонностей — undefined). */
export function vibeOf(p: Profile, faff: Map<string, number>): number | undefined {
  const f = featuresOf(p);
  return f && faff.size ? (featureScore(f, faff) + 1) / 2 : undefined;
}

export const ironicTaste = (rows: EntryRow[]) => voiceFacts(rows).ironic;

function voiceFacts(rows: EntryRow[]) {
  const ironic = rows.some((r) => parseTags(r.tags).some((x) => IRONIC_TAGS.includes(x)));
  const voices = new Map<string, number>();
  for (const r of rows) if (r.voice) voices.set(r.voice, (voices.get(r.voice) ?? 0) + 1);
  const voiceTag = rows.some((r) => parseTags(r.tags).includes("озвучка решает"));
  const preferred = [...voices].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v);
  return { ironic, voiceMatters: voiceTag || voices.size > 0 && [...voices.values()].reduce((s, n) => s + n, 0) >= 3, preferred };
}

/** Модели иногда отвечают с markdown — в интерфейсе он не нужен. */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)[*_](\S.*?\S)[*_](?=\s|$|[.,!?])/g, "$1$2").replace(/^#+\s*/gm, "").trim();

function describeEntry(r: EntryRow, p: Profile | undefined, w: number): string {
  const d = p?.data;
  const tags = parseTags(r.tags);
  return [
    `• ${d ? titleOf(d) : `#${r.anilist_id}`}`,
    r.score ? `оценка ${r.score}/10` : `статус: ${r.status}`,
    `вес ${w.toFixed(1)}`,
    tags.length ? `мои теги: ${tags.join(", ")}` : "",
    r.voice ? `смотрел в озвучке ${r.voice}` : "",
    r.note ? `заметка: «${r.note.slice(0, 200)}»` : "",
    p?.analysis ? `(${p.analysis.tone}; ${p.analysis.themes.slice(0, 4).join(", ")})` : d ? `(${d.genres.slice(0, 4).join(", ")})` : "",
  ].filter(Boolean).join("; ");
}

type PortraitText = Pick<Portrait, "portrait_ru" | "likes" | "dislikes">;
const adaptPortrait = (raw: unknown): PortraitText | null => {
  const p = raw as Partial<PortraitText> | null;
  return p && typeof p.portrait_ru === "string" ? { portrait_ru: p.portrait_ru, likes: p.likes ?? [], dislikes: p.dislikes ?? [] } : null;
};

/**
 * Портрет вкуса: свежий (по текущему списку) или — если ИИ сейчас нет — последний хороший.
 * Хранится в журнале без срока жизни; при правке списка старый не выбрасывается.
 */
async function buildPortrait(userId: number, t: Taste): Promise<{ portrait: Portrait; fresh: boolean; at: number } | null> {
  const sorted = [...t.rows].sort((a, b) => (t.weights.get(b.anilist_id) ?? 0) - (t.weights.get(a.anilist_id) ?? 0));
  const liked = sorted.filter((r) => (t.weights.get(r.anilist_id) ?? 0) > LIKE).slice(0, 20);
  const disliked = sorted.filter((r) => (t.weights.get(r.anilist_id) ?? 0) < -LIKE).slice(-10);
  if (liked.length < 2) return null;
  const user = () => [
    "Понравилось:",
    ...liked.map((r) => describeEntry(r, t.profiles.get(r.anilist_id), t.weights.get(r.anilist_id)!)),
    "",
    "Не понравилось / брошено:",
    ...(disliked.length ? disliked.map((r) => describeEntry(r, t.profiles.get(r.anilist_id), t.weights.get(r.anilist_id)!)) : ["(нет данных)"]),
  ].join("\n");
  const facts = voiceFacts(t.rows);
  const k = await produce<PortraitText>("portrait", `user:${userId}`, {
    inputHash: t.hash, policy: "fresh-first", staleOk: true, adapt: adaptPortrait, schemaV: 1, promptV: 1, schema: PORTRAIT_SCHEMA, system:
    `Ты помогаешь рекомендательной системе аниме. По оценкам, личным тегам и заметкам опиши вкус зрителя
на русском — не жанрами, а тем, ЗА ЧТО ему нравится. Опирайся только на данные ниже, ничего не додумывай.
Пиши обычным текстом без markdown (без звёздочек, решёток, списков).` +
    (facts.ironic ? `\nУчитывай иронию: низкая оценка с тегом «так плохо, что смешно» означает удовольствие от нелепости, а не неприязнь.` : ""),
    user, maxTokens: 1500 });
  if (!k) return null;
  const portrait: Portrait = {
    portrait_ru: plain(k.value.portrait_ru),
    likes: k.value.likes.map(plain),
    dislikes: k.value.dislikes.map(plain),
    ironic_enjoyment: facts.ironic,
    voice_matters: facts.voiceMatters,
    preferred_voices: facts.preferred,
  };
  return { portrait, fresh: k.fresh, at: k.prov.createdAt };
}

// ---------------------------------------------------------------- кандидаты и баллы

type Candidate = { id: number; community: number; basedOn: Map<number, number> };

function collectCandidates(t: Taste): Map<number, Candidate> {
  const inList = new Map(t.rows.map((r) => [r.anilist_id, r.status]));
  const cands = new Map<number, Candidate>();
  for (const [id, w] of t.weights) {
    if (w <= LIKE) continue;
    const p = t.profiles.get(id);
    if (!p) continue;
    for (const rec of p.data.recs) {
      const status = inList.get(rec.id);
      if (status && status !== "planned") continue;
      const c = cands.get(rec.id) ?? { id: rec.id, community: 0, basedOn: new Map() };
      const contrib = w * Math.log1p(rec.rating);
      c.community += contrib;
      c.basedOn.set(id, (c.basedOn.get(id) ?? 0) + contrib);
      cands.set(rec.id, c);
    }
  }
  return cands;
}

function score(t: Taste, cands: Map<number, Candidate>): Recommendation[] {
  const inList = new Map(t.rows.map((r) => [r.anilist_id, r.status]));
  const taste = tasteVector([...t.weights].map(([id, weight]) => ({ weight, embedding: t.profiles.get(id)?.embedding ?? [] })));
  const aff = tagAffinity([...t.weights].map(([id, weight]) => ({ weight, tags: t.profiles.get(id)?.data.tags ?? [] })));
  // Склонности по разбору LLM (тон, юмор, темп, шкалы) — работают и без ИИ: разборы уже сохранены
  const faff = userFeatureAffinity(t.weights, t.profiles, voiceFacts(t.rows).ironic);
  const idf = idfSpace();

  // Похожие по эмбеддингам тайтлы, которых нет среди рекомендаций сообщества
  if (taste) {
    const near = allEmbedded()
      .filter((e) => !inList.has(e.id) || inList.get(e.id) === "planned")
      .map((e) => ({ id: e.id, sim: cosine(taste, e.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 60);
    for (const n of near) if (!cands.has(n.id)) cands.set(n.id, { id: n.id, community: 0, basedOn: new Map() });
  }

  const profiles = getProfiles([...cands.keys()]);
  const maxCommunity = Math.max(1e-9, ...[...cands.values()].map((c) => c.community));
  const out: Recommendation[] = [];
  for (const c of cands.values()) {
    const p = profiles.get(c.id);
    if (!p || p.data.isAdult) continue;
    const similarity = taste && p.embedding ? Math.max(0, (cosine(taste, p.embedding) - 0.3) / 0.5) : 0.3;
    const parts = {
      similarity,
      tags: (tagScore(p.data.tags, aff) + 1) / 2,
      community: c.community / maxCommunity,
      quality: p.data.score ? Math.max(0, (p.data.score - 6) / 3) : 0.3,
      vibe: vibeOf(p, faff),
    };
    // Основания: самые весомые, без частей одной франшизы («Реинкарнация» и «Реинкарнация. Часть 2»)
    const picked: Profile[] = [];
    for (const [id] of [...c.basedOn].sort((a, b) => b[1] - a[1])) {
      const bp = t.profiles.get(id);
      if (!bp || picked.some((x) => x.data.relations.some((r) => r.id === id) || bp.data.relations.some((r) => r.id === x.data.id))) continue;
      picked.push(bp);
      if (picked.length === 3) break;
    }
    const basedOn = picked.map((bp) => ({ id: bp.data.id, title: titleOf(bp.data), ...sharedTraits(p.data, bp.data, idf) }));
    const likedTags = basedOn.length ? [] : p.data.tags
      .filter((tg) => tg.rank >= 50 && (aff.get(tg.name) ?? 0) > 0.2)
      .sort((x, y) => (aff.get(y.name) ?? 0) - (aff.get(x.name) ?? 0)).slice(0, 4).map((tg) => tg.name);
    out.push({
      id: c.id,
      title: p.data.title,
      titleRu: p.data.titleRu,
      cover: p.data.cover,
      color: p.data.color,
      format: p.data.format,
      year: p.data.year,
      episodes: p.data.episodes,
      score: p.data.score,
      genres: p.data.genres,
      match: hybridScore(parts),
      reason: "",
      basedOn,
      likedTags,
      planned: inList.get(c.id) === "planned",
    });
  }
  return out.sort((a, b) => b.match - a.match);
}

// ---------------------------------------------------------------- переранжирование LLM

const RERANK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          fit: { type: "integer", minimum: 0, maximum: 100, description: "насколько подходит именно этому зрителю" },
          reason_ru: { type: "string", description: "одно предложение: почему, со ссылкой на понравившиеся тайтлы" },
        },
        required: ["id", "fit", "reason_ru"],
      },
    },
  },
  required: ["items"],
};

type Fit = { fit: number; reason_ru: string };

/**
 * Переранжирование и объяснения. Оценка хранится по каждому тайтлу (user:<id>:anime:<id>) с хэшем
 * «портрет + строка кандидата»: в модель уходят только кандидаты без свежей оценки, а без ИИ
 * показываются сохранённые объяснения.
 */
async function rerank(userId: number, portrait: Portrait, items: Recommendation[], llmOk: boolean): Promise<Recommendation[]> {
  const top = items.slice(0, 30);
  const profiles = getProfiles(top.map((i) => i.id));
  const lineOf = (i: Recommendation) => {
    const p = profiles.get(i.id);
    const a = p?.analysis;
    // Без разбора — синопсис и теги: иначе модель додумывает сюжет по одному названию
    const about = a
      ? ` — ${a.tone}; ${a.summary_ru.slice(0, 220)}; нелепость ${a.so_bad_its_good}/5`
      : p ? ` — теги: ${p.data.tags.filter((t) => t.rank >= 60).slice(0, 6).map((t) => t.name).join(", ")}; ${(p.data.synopsis ?? "").slice(0, 220)}` : "";
    return `[${i.id}] ${i.titleRu ?? i.title} (${i.format ?? "?"}, ${i.year ?? "?"}; ${i.genres.slice(0, 3).join(", ")})` +
      about +
      (i.basedOn.length ? ` | основания: ${i.basedOn.map((b) => b.title).join(", ")}` : "");
  };
  const portraitKey = hashOf([portrait.portrait_ru, portrait.likes, portrait.dislikes, portrait.ironic_enjoyment, portrait.voice_matters]);
  const subject = (id: number) => `user:${userId}:anime:${id}`;
  const lines = new Map(top.map((i) => [i.id, lineOf(i)]));
  const hashes = new Map(top.map((i) => [i.id, hashOf(`${portraitKey}|${lines.get(i.id)}`)]));
  const known = new Map<number, Fit>();
  const need: Recommendation[] = [];
  for (const i of top) {
    const k = bestOutput<Fit>("rerank", subject(i.id), { inputHash: hashes.get(i.id), policy: "fresh-first", staleOk: true });
    if (k) known.set(i.id, k.value);
    if (!k?.fresh) need.push(i);
  }
  if (llmOk && need.length) {
    try {
      const res = await runTask<{ items: ({ id: number } & Fit)[] }>("rerank", { schema: RERANK_SCHEMA, system:
        `Ты подбираешь аниме конкретному зрителю. Оцени каждого кандидата по портрету вкуса (fit 0–100)
и объясни одним живым предложением на русском, почему ему зайдёт или нет, ссылаясь на основания.
Пиши обычным текстом без markdown.
`+ (portrait.ironic_enjoyment || portrait.voice_matters
          ? `Учитывай прямо: ${[portrait.ironic_enjoyment && "зрителю нравится «так плохо, что смешно»", portrait.voice_matters && "для зрителя важна озвучка"].filter(Boolean).join("; ")}.\n` : "") + `Описывай кандидата только по его собственной строке. Основания — другие тайтлы: упоминай их как сравнение
(«как в …»), но не приписывай кандидату их сюжет или героев.`, user:
        `Портрет вкуса: ${portrait.portrait_ru}\nНравится: ${portrait.likes.join("; ")}\nНе нравится: ${portrait.dislikes.join("; ")}` +
        `${portrait.preferred_voices.length ? `\nЛюбимые озвучки: ${portrait.preferred_voices.join(", ")}` : ""}\n\nКандидаты:\n${need.map((i) => lines.get(i.id)).join("\n")}`,
        maxTokens: Math.max(800, need.length * 180) });
      const wanted = new Set(need.map((i) => i.id));
      for (const x of res.value.items) {
        if (!wanted.has(x.id)) continue;
        const value = { fit: x.fit, reason_ru: plain(x.reason_ru) };
        recordOutput("rerank", subject(x.id), res, value, { schemaV: 1, promptV: 1, inputHash: hashes.get(x.id)! });
        known.set(x.id, value);
      }
    } catch (e) {
      console.warn(`[reco] переранжирование: ${String(e)}`);
    }
  }
  const merged = top.map((i) => {
    const f = known.get(i.id);
    return f ? { ...i, match: Math.round(0.5 * i.match + 0.5 * f.fit), reason: f.reason_ru } : i;
  });
  return [...merged.sort((a, b) => b.match - a.match), ...items.slice(30)];
}

// ---------------------------------------------------------------- API

type Cached = { list_hash: string; portrait: string | null; recs: string | null; updated_at: number };

export async function recommendations(userId: number, force = false): Promise<RecoResponse> {
  const t = await loadTaste(userId);
  const embedOk = await embedAvailable();
  const llm = (await taskAvailable("portrait")) || (await taskAvailable("rerank"));
  const rerankOk = await taskAvailable("rerank");
  const cached = db.prepare<[number], Cached>("SELECT list_hash, portrait, recs, updated_at FROM user_taste WHERE user_id = ?").get(userId);
  const fresh = cached && cached.list_hash === t.hash && now() - cached.updated_at < 12 * 3600;
  if (fresh && !force && cached.recs) return JSON.parse(cached.recs) as RecoResponse;

  // Мои тайтлы — в начало очереди анализа, кандидаты — следом
  enqueueProfiles(t.rows.map((r) => r.anilist_id), true);
  const cands = collectCandidates(t);
  await ensureProfileData([...cands.keys()].slice(0, 300));
  if (embedOk) {
    await quickEmbed([...t.profiles.keys(), ...cands.keys()].slice(0, 400)).catch((e) => console.warn(`[reco] эмбеддинги: ${e}`));
    t.profiles = getProfiles(t.rows.map((r) => r.anilist_id));
  }
  let items = score(t, cands).slice(0, 60);
  enqueueProfiles(items.slice(0, 40).map((i) => i.id));

  // Портрет: свежий или последний хороший (без ИИ — сохранённый); переранжирование — с сохранёнными оценками
  const built = await buildPortrait(userId, t).catch((e) => {
    console.warn(`[reco] портрет: ${String(e)}`);
    return null;
  });
  const portrait = built?.portrait ?? null;
  if (portrait) items = await rerank(userId, portrait, items, rerankOk);

  const profiled = [...t.profiles.values()];
  const result: RecoResponse = {
    portrait,
    portraitStale: built ? !built.fresh : false,
    portraitAt: built?.at ?? null,
    items: items.slice(0, 40),
    stats: {
      rated: [...t.weights.values()].filter((w) => Math.abs(w) > LIKE).length,
      profiled: profiled.length,
      analyzed: profiled.filter((p) => p.analysis).length,
      llm,
      generatedAt: now(),
    },
  };
  // Портрет в user_taste — последний хороший (NULL не записываем поверх существующего)
  db.prepare(
    `INSERT INTO user_taste (user_id, list_hash, portrait, recs, updated_at, portrait_hash) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET list_hash = excluded.list_hash, portrait = COALESCE(excluded.portrait, user_taste.portrait),
       recs = excluded.recs, updated_at = excluded.updated_at, portrait_hash = COALESCE(excluded.portrait_hash, user_taste.portrait_hash)`,
  ).run(userId, t.hash, portrait ? JSON.stringify(portrait) : null, JSON.stringify(result), now(), built?.fresh ? t.hash : null);
  return result;
}

export { loadTaste };
