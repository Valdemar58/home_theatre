import "server-only";
import { gql } from "./anilist";
import { getCached, setCached } from "./cache";
import { chatJSON, llmAvailable } from "./llm";
import { TAGS_RU } from "./tags-ru-dict";

// Русские названия тегов AniList: основной словарь переведён вручную (tags-ru-dict.ts),
// теги, появившиеся в AniList позже, переводит локальная LLM (раз в сутки, порциями).
// Нет перевода — показываем английское название; оригинал всегда — в подсказке при наведении.

const KEY = "tags-ru:v1";
const CHUNK = 40;

/** Русские названия: ручной словарь, для новых тегов — перевод LLM. С заглавной, как жанры. */
export const tagsRu = (): Record<string, string> => {
  const llm = getCached<Record<string, string>>(KEY, true) ?? {};
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  return { ...Object.fromEntries(Object.entries(llm).map(([k, v]) => [k, cap(v)])), ...TAGS_RU };
};

const SCHEMA = {
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

/** Перевести недостающие теги (фоновая задача из jobs.ts). */
export async function translateTags(): Promise<void> {
  if (running || !(await llmAvailable())) return;
  running = true;
  try {
    const all = (await gql<{ MediaTagCollection: { name: string; description: string | null; isAdult: boolean }[] }>(
      "{ MediaTagCollection { name description isAdult } }")).MediaTagCollection.filter((t) => !t.isAdult);
    const map = getCached<Record<string, string>>(KEY, true) ?? {};
    const missing = all.filter((t) => !map[t.name] && !TAGS_RU[t.name]);
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const prompt = chunk.map((t) => `${t.name} — ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
      const res = await chatJSON<{ items: { en: string; ru: string }[] }>(SCHEMA, SYSTEM, `Теги (название — описание):\n${prompt}`);
      const names = new Set(chunk.map((t) => t.name));
      for (const it of res.items) {
        const ru = it.ru?.trim();
        if (names.has(it.en) && ru && ru.length <= 40) map[it.en] = ru;
      }
      setCached(KEY, map, 365 * 86400);
    }
    if (missing.length) console.log(`[tags-ru] переведено тегов: ${Object.keys(map).length}`);
  } finally {
    running = false;
  }
}
