import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import type { PlaySub } from "@/lib/player";
import { buildAss, plainText, signEvents, signTexts, splitAss, withText } from "@/lib/signs";
import { glossaryFor } from "@/lib/translate-text";
import { displayTitle } from "@/lib/schedule";
import { getDetails } from "./anilist";
import { characterGlossary } from "./characters";
import { env } from "./env";
import { bestOutput, hashOf, recordOutput } from "./knowledge";
import { getMedia } from "./lists";
import { runTask } from "./llm";
import { upstreamPath, type PlaySession } from "./player";
import { ApiError } from "./route";
import { streamSubFile } from "./stream-subs";

// Надписи поверх (TASKS 9.5): из полной ASS-дорожки серии — только вывески, записки, титры и песни (lib/signs.ts).
// Из русской дорожки — как есть, из английской/японской — с переводом (задача «signs»: короткие строки одним
// запросом, имена — словарь Shikimori). Перевод — в журнал знаний от ИИ по файлу серии и дорожке, без срока.

type Stored = { map: Record<string, string> };

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: { type: "object", properties: { i: { type: "integer" }, ru: { type: "string", description: "перевод строки на русский" } }, required: ["i", "ru"] },
    },
  },
  required: ["lines"],
};

const SYSTEM = `Ты переводишь надписи из аниме на русский: вывески, записки, экраны, титры, названия серий, тексты песен.
Переводи коротко, как надпись в кадре, без пояснений и кавычек. Перенос строки внутри надписи обозначен « / » — сохраняй его.
Название тайтла пиши как его русское название. Имена из словаря пиши строго как в словаре. Остальные японские имена — по системе Поливанова (ши → си, цу, дзи).
Строку уже на русском, звук или бессмысленный набор знаков верни как есть. Ответ — перевод для каждой строки по её номеру i.`;

const BATCH = 60;
/** Версия подсказки: входит в хэш входа — перевод по старой подсказке остаётся в журнале, но текущим не считается. */
const PROMPT_V = 2;

/** Исходная дорожка: файл из раздачи или дорожка Jellyfin (вшитая или внешняя). */
async function sourceText(s: PlaySession, sub: PlaySub): Promise<string> {
  const ts = /^\/api\/stream-subs\/([0-9a-f]{40})\/(.+)$/.exec(sub.url);
  if (ts) {
    const buf = await streamSubFile(ts[1], ts[2]);
    if (!buf) throw new ApiError(404, "Файла субтитров раздачи нет");
    return buf.toString("utf-8");
  }
  const res = await fetch(`${env.jellyfinUrl}${upstreamPath(s, `sub/${sub.index}.ass`, "")}`, {
    headers: { Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"` },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new ApiError(502, `Jellyfin не отдал субтитры: HTTP ${res.status}`);
  return res.text();
}

const running = new Map<string, Promise<Record<string, string>>>();

/** Перевод надписей дорожки (сохранённый — сразу; одновременные запросы ждут один перевод). */
function translate(s: PlaySession, sub: PlaySub, texts: string[]): Promise<Record<string, string>> {
  const subject = `signs:${s.itemKey}:${sub.torrent ? sub.url : `jf${sub.index}`}`;
  const inputHash = hashOf({ texts, v: PROMPT_V });
  const ready = bestOutput<Stored>("signs", subject, { inputHash, policy: "tier-first", staleOk: false });
  if (ready?.fresh) return Promise.resolve(ready.value.map);
  const cur = running.get(subject);
  if (cur) return cur;
  const run = (async () => {
    const d = await getDetails(s.anilistId);
    const chars = await characterGlossary(d.idMal).catch(() => []);
    const m = getMedia(s.anilistId);
    const ru = m ? displayTitle(m.title) : null;
    const map: Record<string, string> = {};
    let usage = { provider: "", model: "", tier: 99, usageId: null as number | null };
    for (let k = 0; k < texts.length; k += BATCH) {
      const batch = texts.slice(k, k + BATCH);
      const gl = glossaryFor(batch.join("\n"), chars);
      const user = [
        `Тайтл: ${d.title.english ?? d.title.romaji ?? ""}${d.title.native ? ` (${d.title.native})` : ""}${ru ? `, по-русски — «${ru}»` : ""}`,
        gl.length ? `Словарь имён:\n${gl.join("\n")}` : "",
        `Надписи:\n${batch.map((t, i) => `${i}: ${t.replace(/\n/g, " / ")}`).join("\n")}`,
      ].filter(Boolean).join("\n\n");
      const res = await runTask<{ lines: { i: number; ru: string }[] }>("signs", { schema: SCHEMA, system: SYSTEM, user, maxTokens: 4000 });
      for (const l of res.value.lines) {
        const src = batch[l.i];
        if (src && l.ru.trim()) map[src] = l.ru.trim().replace(/\s*\/\s*/g, "\n");
      }
      if (res.tier < usage.tier) usage = { provider: res.provider, model: res.model, tier: res.tier, usageId: res.usageId };
    }
    recordOutput("signs", subject, usage, { map } satisfies Stored, { schemaV: 1, promptV: PROMPT_V, inputHash });
    return map;
  })().finally(() => running.delete(subject));
  running.set(subject, run);
  return run;
}

/** Дорожка надписей для слоя «Надписи поверх»: исходная шапка и стили, только надписи (переведённые, если нужно). */
export async function signsTrack(s: PlaySession, srcIndex: number): Promise<{ text: string; count: number }> {
  const sub = s.subs.find((x) => x.index === srcIndex && x.ass);
  if (!sub) throw new ApiError(404, "Нет такой дорожки");
  const parts = splitAss(await sourceText(s, sub));
  const events = signEvents(parts);
  if (sub.lang === "rus" || !events.length) return { text: buildAss(parts, events), count: events.length };
  const map = await translate(s, sub, signTexts(events));
  return { text: buildAss(parts, events.map((e) => (map[plainText(e.text)] ? withText(e, map[plainText(e.text)]) : e))), count: events.length };
}
