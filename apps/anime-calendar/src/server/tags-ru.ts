import "server-only";
import { gql } from "./anilist";
import { bestRouteTier, runTask, taskAvailable } from "./llm";
import { getLlmConfig } from "./llm-config";
import { bestByPrefix, hashOf, recordOutput } from "./knowledge";
import { TAGS_RU } from "./tags-ru-dict";
import type { JsonSchema } from "@/lib/json-lite";

// Русские названия тегов AniList: основной словарь переведён вручную (tags-ru-dict.ts),
// теги, появившиеся в AniList позже, переводит LLM (раз в сутки, порциями).
// Переводы хранятся в журнале llm_output без срока жизни (субъект tag:<название>).
// Нет перевода — показываем английское название; оригинал всегда — в подсказке при наведении.

const CHUNK = 40;
const SUBJECT = "tag:";

let memo: { at: number; map: Record<string, string> } | null = null;

function llmTranslations(): Map<string, { ru: string; tier: number }> {
  const out = new Map<string, { ru: string; tier: number }>();
  for (const [subject, k] of bestByPrefix<{ ru: string }>("tags", SUBJECT, { policy: "tier-first", staleOk: true })) {
    if (k.value.ru) out.set(subject.slice(SUBJECT.length), { ru: k.value.ru, tier: k.prov.tier });
  }
  return out;
}

/** Русские названия: ручной словарь, для новых тегов — перевод LLM. С заглавной, как жанры. */
export const tagsRu = (): Record<string, string> => {
  if (memo && Date.now() - memo.at < 3600_000) return memo.map;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const llm = Object.fromEntries([...llmTranslations()].map(([en, v]) => [en, cap(v.ru)]));
  memo = { at: Date.now(), map: { ...llm, ...TAGS_RU } };
  return memo.map;
};

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { en: { type: "string" }, ru: { type: "string" } }, required: ["en", "ru"] },
    },
  },
  required: ["items"],
};

const SYSTEM = `Ты переводишь названия тегов аниме с AniList на русский для русскоязычного каталога аниме.
Правила: коротко (1–3 слова), строчными буквами (кроме имён собственных), как принято на русских аниме-сайтах (Shikimori).
Устоявшиеся японские термины — общепринятой русской транслитерацией: исекай, цундэрэ, кудэрэ, яндэрэ, сёнэн, сэйнэн, иясикэй, меха.
Не объясняй, не добавляй кавычки. Верни перевод для каждого тега, en — ровно как в запросе.`;

let running = false;

/** Перевести недостающие теги (фоновая задача из jobs.ts); с флагом «улучшать» — и переведённые моделью слабее. */
export async function translateTags(): Promise<void> {
  if (running || !(await taskAvailable("tags"))) return;
  running = true;
  try {
    const all = (await gql<{ MediaTagCollection: { name: string; description: string | null; isAdult: boolean }[] }>(
      "{ MediaTagCollection { name description isAdult } }")).MediaTagCollection.filter((t) => !t.isAdult);
    const known = llmTranslations();
    const route = await bestRouteTier("tags");
    const upgrade = Boolean(getLlmConfig().upgrade.tags);
    const missing = all.filter((t) => {
      if (TAGS_RU[t.name]) return false;
      const k = known.get(t.name);
      return !k || (upgrade && route > k.tier);
    });
    let added = 0;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const prompt = chunk.map((t) => `${t.name} — ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
      const res = await runTask<{ items: { en: string; ru: string }[] }>("tags", { schema: SCHEMA, system: SYSTEM, user: `Теги (название — описание):\n${prompt}` });
      const byName = new Map(chunk.map((t) => [t.name, t]));
      for (const it of res.value.items) {
        const ru = it.ru?.trim();
        const tag = byName.get(it.en);
        if (!tag || !ru || ru.length > 40) continue;
        recordOutput("tags", `${SUBJECT}${it.en}`, res, { ru }, { schemaV: 1, promptV: 1, inputHash: hashOf(`${tag.name}|${tag.description ?? ""}`) });
        added++;
      }
    }
    memo = null;
    if (added) console.log(`[tags-ru] переведено тегов: ${added}`);
  } finally {
    running = false;
  }
}
