import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import { TIER } from "@/lib/llm-tier";
import type { PlotInfo } from "@/lib/types";
import { planBatches, stateAt, type DeepState } from "@/lib/plot-deep";
import { getDetails } from "./anilist";
import { characterGlossary } from "./characters";
import { corpusOf, type CorpusText } from "./corpus-store";
import { db } from "./db";
import { bestOutput, hashOf, recordOutput, type Known } from "./knowledge";
import { bestRouteTier, runTask } from "./llm";
import { getLlmConfig } from "./llm-config";

// Пересказ сезона (задача plot_deep, TASKS 7.12.2) по самому подробному тексту корпуса о каждой серии.
// Слепо по порядку: порция серий + состояние после прошлой порции → новое состояние. Каждая порция —
// своя запись llm_output (subject season:<id>:<последняя серия>), хэш входа включает хэш прошлой порции:
// поменялся текст серии — пересчитываются её порция и всё после неё, новая серия онгоинга — только хвост.

// Версия промпта — в журнал; в хэш входа идёт только версия смысла входа (правка формулировок не пересчитывает готовое)
const PROMPT_V = 2;
const INPUT_V = 1;
const EP_MAX = 12_000;
const TEASER_MAX = 1_200;

const subject = (id: number, upTo: number) => `season:${id}:${upTo}`;
const opts = (inputHash: string) => ({ inputHash, policy: "tier-first" as const, staleOk: false });

type EpInput = { ep: number; title: string | null; text: string; filler: boolean };

/**
 * Текст серии для пересказа: самый подробный пересказ, а если есть только анонсы — все анонсы вместе
 * (у разных источников разные подробности). Слишком длинный пересказ обрезается по абзацу.
 */
function episodeInputs(id: number): EpInput[] {
  const byEp = new Map<number, CorpusText[]>();
  for (const t of corpusOf(id)) byEp.set(t.ep, [...(byEp.get(t.ep) ?? []), t]);
  const filler = new Set(db.prepare<[number], { ep: number }>("SELECT ep FROM episode_meta WHERE anilist_id = ? AND filler = 1").all(id).map((r) => r.ep));
  return [...byEp.entries()].sort((a, b) => a[0] - b[0]).map(([ep, texts]) => {
    const full = texts.filter((t) => t.depth !== "teaser").sort((a, b) => b.text.length - a.text.length)[0];
    const title = (full ?? texts.find((t) => t.title && t.lang === "en") ?? texts[0]).title;
    let text: string;
    if (full) {
      text = full.text.length <= EP_MAX ? full.text : `${full.text.slice(0, full.text.lastIndexOf("\n", EP_MAX) > EP_MAX / 2 ? full.text.lastIndexOf("\n", EP_MAX) : EP_MAX)} […]`;
    } else {
      text = texts.filter((t) => t.text.trim()).map((t) => `(${t.source}, ${t.lang}) ${t.text.slice(0, TEASER_MAX)}`).join("\n");
    }
    return { ep, title, text, filler: filler.has(ep) };
  });
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    episode_beats: {
      type: "array", description: "по каждой серии из новой порции",
      items: { type: "object", properties: { ep: { type: "integer" }, beats_ru: { type: "string", description: "2–4 предложения: что произошло в этой серии" } }, required: ["ep", "beats_ru"] },
    },
    retelling_ru: { type: "string", description: "связный пересказ сезона с первой серии по последнюю данную включительно" },
    ending_state_ru: { type: "string", description: "2–4 предложения: положение героев и открытые вопросы на конец последней данной серии" },
    arcs: {
      type: "array", maxItems: 12,
      items: {
        type: "object",
        properties: {
          name_ru: { type: "string" }, eps: { type: "string", description: "серии, напр. «1–4»" },
          status: { type: "string", enum: ["завершена", "продолжается"] }, summary_ru: { type: "string", description: "1–2 предложения" },
        },
        required: ["name_ru", "eps", "status", "summary_ru"],
      },
    },
    characters: {
      type: "array", maxItems: 40,
      items: {
        type: "object",
        properties: {
          name_ru: { type: "string" }, name_en: { type: "string", description: "как в английском тексте" }, name_ja: { type: "string", description: "по-японски, если известно, иначе пусто" },
          role_ru: { type: "string", description: "кто это и чем важен — только по уже данным сериям" },
        },
        required: ["name_ru", "name_en", "name_ja", "role_ru"],
      },
    },
    glossary: {
      type: "array", maxItems: 60, description: "термины мира: навыки, места, организации, титулы, предметы",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "как в английском (или японском) тексте" }, ru: { type: "string", description: "по-русски" },
          kind: { type: "string", enum: ["навык", "место", "организация", "титул", "предмет", "раса", "другое"] },
        },
        required: ["term", "ru", "kind"],
      },
    },
  },
  required: ["episode_beats", "retelling_ru", "ending_state_ru", "arcs", "characters", "glossary"],
};

const SYSTEM = `Ты ведёшь пересказ сезона аниме по-русски, серия за серией, как зритель, который смотрит впервые.
Тебе дают состояние пересказа после прошлых серий и тексты следующих серий (по-английски или по-японски). Обнови состояние.
Правила:
- Опирайся только на данные тексты. Ничего не додумывай; чего нет в текстах — того не было.
- Ты не знаешь будущего: никаких намёков на то, что «позже окажется», даже если тебе это известно. Если текст серии сам забегает вперёд или говорит то, чего зритель в серии ещё не знает, не переноси это.
- Скрытое оставляй скрытым: тайны, подозрения, мотивы, которые серии не раскрыли, описывай так, как их видит зритель на этот момент.
- episode_beats — ровно по одной записи на каждую новую серию, ep — номер из заголовка «### Серия N»; каждая — только по тексту своей серии.
- Не уточняй того, чего нет в тексте: чисел, сроков, кто кому что сказал, родства, фамилий. Не уверен — пиши общее.
- retelling_ru — весь сезон до последней данной серии, связно и по порядку, примерно 120–180 слов на каждые 4 серии; прошлый пересказ можно сжать, но не терять важное.
- Арки, персонажи, термины — накопительно: оставь прежние, добавь новые, уточни роли по новым сериям.
- Имена из словаря Shikimori — строго как там; остальные японские имена — по Поливанову. Одного персонажа везде пиши одинаково, как в прошлом состоянии. Термины переводи по смыслу, если перевод очевиден, иначе транслитерация; прежние варианты не меняй.
- Филлер (помечен) пересказывай коротко и не вплетай в арки.`;

type Answer = {
  episode_beats: { ep: number; beats_ru: string }[];
  retelling_ru: string; ending_state_ru: string;
  arcs: DeepState["arcs"]; characters: DeepState["characters"]; glossary: DeepState["glossary"];
};

export type DeepPlan = { batches: number[][]; hashes: string[]; inputs: Map<number, EpInput> };

/** Порции сезона и хэши их входа (цепочкой: хэш порции включает хэш прошлой). */
export function deepPlan(id: number): DeepPlan {
  const eps = episodeInputs(id);
  const inputs = new Map(eps.map((e) => [e.ep, e]));
  const batches = planBatches(eps.map((e) => ({ ep: e.ep, chars: e.text.length })));
  const hashes: string[] = [];
  let prev = `v${INPUT_V}`;
  for (const b of batches) {
    prev = hashOf([prev, ...b.map((ep) => { const e = inputs.get(ep)!; return [ep, e.filler, hashOf(e.text)]; })]);
    hashes.push(prev);
  }
  return { batches, hashes, inputs };
}

/** Готовые порции сезона подряд с первой (на первой несвежей цепочка обрывается). */
function storedKnown(id: number, plan: DeepPlan): Known<DeepState>[] {
  const out: Known<DeepState>[] = [];
  for (const [i, b] of plan.batches.entries()) {
    const k = bestOutput<DeepState>("plot_deep", subject(id, b.at(-1)!), opts(plan.hashes[i]));
    if (!k?.fresh) break;
    out.push(k);
  }
  return out;
}

export const storedStates = (id: number, plan = deepPlan(id)): DeepState[] => storedKnown(id, plan).map((k) => k.value);

/** Для страницы тайтла: все готовые порции (что показать — решает курсор зрителя) и модель. */
export function seasonForPage(id: number): PlotInfo["season"] {
  const plan = deepPlan(id);
  const known = storedKnown(id, plan);
  return known.length ? { states: known.map((k) => k.value), total: plan.batches.length, model: known.at(-1)!.prov.model } : null;
}

/** Пересказ сезона для досмотревшего до серии upTo (без него — весь готовый). */
export function seasonPlot(id: number, upTo = Infinity) {
  const plan = deepPlan(id);
  const states = storedStates(id, plan);
  if (!states.length) return null;
  const at = stateAt(states, upTo);
  return { ...at, total: plan.batches.length, done: states.length, lastEp: plan.batches.at(-1)?.at(-1) ?? 0 };
}

const clip = <T,>(xs: T[], n: number) => xs.slice(0, n);
const missingBeats = (a: Answer, batch: number[]) => batch.filter((ep) => !a.episode_beats.some((x) => x.ep === ep && x.beats_ru.trim()));

/**
 * Досчитать пересказ сезона: порции, которых нет или вход которых изменился, по порядку.
 * onBatch — после каждой порции (прогресс). Возвращает число вызовов модели.
 */
export async function buildSeasonPlot(id: number, signal: AbortSignal, onBatch?: (done: number, total: number) => void): Promise<number> {
  const plan = deepPlan(id);
  if (!plan.batches.length) return 0;
  // С флагом «улучшать» порции слабее доступной модели пересчитываются (с первой такой — дальше по цепочке)
  const known = storedKnown(id, plan);
  const routeTier = await bestRouteTier("plot_deep");
  const weak = getLlmConfig().upgrade.plot_deep ? known.findIndex((k) => k.prov.tier < routeTier) : -1;
  const ready = (weak >= 0 ? known.slice(0, weak) : known).map((k) => k.value);
  onBatch?.(ready.length, plan.batches.length);
  if (ready.length === plan.batches.length) return 0;
  const d = await getDetails(id);
  const shiki = await characterGlossary(d.idMal).catch(() => []);
  const head = [
    `Тайтл: ${d.title.english ?? d.title.romaji ?? ""}${d.title.native ? ` (${d.title.native})` : ""}, серий: ${d.episodes ?? "?"}`,
    shiki.length ? `Словарь имён Shikimori (англ./яп. → рус.):\n${shiki.slice(0, 50).map((c) => `${c.names.slice(0, 2).join(" / ")} → ${c.ru}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const localOnly = getLlmConfig().tasks.plot_deep === "local" || getLlmConfig().mode === "local";
  let prev: DeepState | null = ready.at(-1) ?? null;
  let calls = 0;
  for (let i = ready.length; i < plan.batches.length; i++) {
    signal.throwIfAborted();
    const b = plan.batches[i];
    const state = prev
      ? JSON.stringify({ retelling_ru: prev.retelling_ru, ending_state_ru: prev.ending_state_ru, arcs: prev.arcs, characters: prev.characters, glossary: prev.glossary })
      : "";
    const user = [
      head,
      prev ? `Состояние после серии ${prev.upTo}:\n${state}` : "Это начало сезона: прошлого состояния нет.",
      `Новые серии (${b[0]}–${b.at(-1)}):`,
      ...b.map((ep) => { const e = plan.inputs.get(ep)!; return `### Серия ${ep}${e.title ? `: ${e.title}` : ""}${e.filler ? " [филлер]" : ""}\n${e.text}`; }),
    ].join("\n\n");
    // Внешний пул сорвался — не отдавать порцию локальной модели (до 30 тыс. символов ей не по силам):
    // лучше ошибка и повтор по кнопке, чем слабое звено в цепочке
    const req = { schema: SCHEMA, system: SYSTEM, user, maxTokens: 12_000, timeoutMs: 600_000, minTier: localOnly ? 0 : TIER.cheap };
    let res = await runTask<Answer>("plot_deep", req);
    calls++;
    // Краткое содержание пропустило серию или сдвинуло номер — ещё одна попытка, потом берём как есть
    if (missingBeats(res.value, b).length) {
      const again = await runTask<Answer>("plot_deep", req).catch(() => null);
      calls++;
      if (again && missingBeats(again.value, b).length < missingBeats(res.value, b).length) res = again;
    }
    const a = res.value;
    const beats: Record<number, string> = {};
    for (const x of a.episode_beats) if (b.includes(x.ep) && x.beats_ru.trim()) beats[x.ep] = x.beats_ru.trim();
    const value: DeepState = {
      upTo: b.at(-1)!, retelling_ru: a.retelling_ru.trim(), ending_state_ru: a.ending_state_ru.trim(),
      arcs: clip(a.arcs, 12), characters: clip(a.characters, 40), glossary: clip(a.glossary, 60), beats,
    };
    recordOutput("plot_deep", subject(id, value.upTo), res, value, { schemaV: 1, promptV: PROMPT_V, inputHash: plan.hashes[i] });
    prev = value;
    onBatch?.(i + 1, plan.batches.length);
  }
  return calls;
}
