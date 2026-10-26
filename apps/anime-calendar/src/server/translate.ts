import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import { chunkText, glossaryFor } from "@/lib/translate-text";
import { getDetails } from "./anilist";
import { characterGlossary } from "./characters";
import { corpusOf } from "./corpus-store";
import { bestOutput, hashOf, recordOutput, type Known } from "./knowledge";
import { runTask } from "./llm";
import { seasonPlot } from "./plot-deep";
import { deepGlossary } from "@/lib/plot-deep";

// Перевод пересказов серий из корпуса (EN/JA → язык пользователя, пока русский).
// Один раз на текст: перевод хранится в журнале llm_output без срока жизни и переиспользуется всеми.
// Имена — по словарю персонажей Shikimori (англ./яп. → рус.), названия серий — по русским названиям TMDB.

export type Translation = { text: string; model: string; provider: string; tier: number; at: number };
type Stored = { text: string };

const subject = (anilistId: number, ep: number, source: string, lang: string) => `ep:${anilistId}:${ep}:${source}:${lang}`;
const opts = (inputHash?: string) => ({ inputHash, policy: "tier-first" as const, staleOk: false });

const toTranslation = (k: Known<Stored>): Translation => ({ text: k.value.text, model: k.prov.model, provider: k.prov.provider, tier: k.prov.tier, at: k.prov.createdAt });

/** Готовый перевод текста серии (null — нет; перевод старой версии текста не отдаётся). */
export function storedTranslation(anilistId: number, ep: number, source: string, text: string, lang = "ru"): Translation | null {
  const k = bestOutput<Stored>("translate", subject(anilistId, ep, source, lang), opts(hashOf(text)));
  return k?.fresh ? toTranslation(k) : null;
}

// ---------------------------------------------------------------- перевод

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { text_ru: { type: "string", description: "перевод фрагмента на русский, абзацы через пустую строку" } },
  required: ["text_ru"],
};

const SYSTEM = `Ты переводишь пересказ серии аниме на русский язык — литературно и точно.
Переводи полностью: ничего не пропускай, не сокращай и не добавляй от себя, абзацы сохраняй.
Имена из словаря пиши строго как в словаре и склоняй по-русски. Остальные японские имена — по системе Поливанова (ши → си, цу, дзи).
Названия приёмов, навыков, титулов, мест и организаций переводи по смыслу, если перевод устоялся или очевиден; иначе — транслитерация.
Если дан уже переведённый предыдущий фрагмент — держись тех же вариантов имён и терминов.`;

const running = new Map<string, Promise<Translation>>();

/** Перевести текст серии из корпуса (одновременные запросы ждут один и тот же перевод). */
export function translateEpisode(anilistId: number, ep: number, source: string, lang = "ru"): Promise<Translation> {
  const key = subject(anilistId, ep, source, lang);
  const cur = running.get(key);
  if (cur) return cur;
  const run = (async () => {
    const texts = corpusOf(anilistId, ep).filter((t) => t.ep === ep);
    const src = texts.find((t) => t.source === source);
    if (!src) throw new Error("текста серии нет в корпусе");
    const ready = storedTranslation(anilistId, ep, source, src.text, lang);
    if (ready) return ready;
    const d = await getDetails(anilistId);
    // Имена Shikimori первыми (их варианты главнее), дальше имена и термины пересказа сезона до этой серии
    const deep = seasonPlot(anilistId, ep)?.state;
    const chars = [...await characterGlossary(d.idMal).catch(() => []), ...(deep ? deepGlossary(deep) : [])];
    // Русское название серии (TMDB) — подсказка для названий и терминов
    const ruTitle = texts.find((t) => t.lang === "ru" && t.title)?.title;
    const head = [
      `Тайтл: ${d.title.english ?? d.title.romaji ?? ""}${d.title.native ? ` (${d.title.native})` : ""}`,
      src.title ? `Название серии: ${src.title}${ruTitle ? ` = ${ruTitle}` : ""}` : "",
    ].filter(Boolean).join("\n");
    const parts: string[] = [];
    let usage = { provider: "", model: "", tier: 99, usageId: null as number | null };
    for (const chunk of chunkText(src.text)) {
      const gl = glossaryFor(chunk, chars);
      const prev = parts.at(-1);
      const user = [
        head,
        gl.length ? `Словарь имён:\n${gl.join("\n")}` : "",
        prev ? `Предыдущий фрагмент в переводе (для единства терминов, не переводи заново):\n${prev.slice(-1500)}` : "",
        `Фрагмент для перевода:\n${chunk}`,
      ].filter(Boolean).join("\n\n");
      const res = await runTask<{ text_ru: string }>("translate", { schema: SCHEMA, system: SYSTEM, user, maxTokens: 6000 });
      parts.push(res.value.text_ru.trim());
      // Ранг перевода — по худшему из фрагментов
      if (res.tier < usage.tier) usage = { provider: res.provider, model: res.model, tier: res.tier, usageId: res.usageId };
    }
    const text = parts.join("\n\n");
    recordOutput("translate", key, usage, { text } satisfies Stored, { schemaV: 1, promptV: 1, inputHash: hashOf(src.text) });
    return storedTranslation(anilistId, ep, source, src.text, lang) ?? { text, model: usage.model, provider: usage.provider, tier: usage.tier, at: Math.floor(Date.now() / 1000) };
  })().finally(() => running.delete(key));
  running.set(key, run);
  return run;
}
