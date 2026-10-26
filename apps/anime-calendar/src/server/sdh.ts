import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonSchema } from "@/lib/json-lite";
import { TIER } from "@/lib/llm-tier";
import { matchFiles, parseSubs, type ParsedSubs } from "@/lib/sdh";
import type { CorpusProgress } from "@/lib/types";
import { getDetails } from "./anilist";
import { cached } from "./cache";
import { characterGlossary } from "./characters";
import { corpusOf, putTexts, type Found } from "./corpus-store";
import { db, now } from "./db";
import { env } from "./env";
import { fetchWithRetry, RateLimiter } from "./http";
import { bestOutput, recordOutput } from "./knowledge";
import { runTask } from "./llm";
import { getLlmConfig } from "./llm-config";
import { buildSeasonPlot } from "./plot-deep";
import { registerHandler } from "./tasks";

// «Глубокий разбор» (TASKS 7.12.3, идея #79): японские субтитры для слабослышащих с Jimaku → реплики → конспект серии
// по сценам (LLM, слепо: только эта серия) → корпус (source «sdh», depth «script») → пересказ сезона.
// Субтитры — фанатские загрузки: файлы лежат только локально и сырым текстом никому не показываются.

const JIMAKU = "https://jimaku.cc";
const UA = "home-theater/1.0 (personal media server)";
const limiter = new RateLimiter(1500);
const PROMPT_V = 1;

const fetchText = async (url: string) => {
  const res = await fetchWithRetry(url, { headers: { "User-Agent": UA } }, limiter, { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`Jimaku: HTTP ${res.status}`);
  return res.text();
};

/** Записи Jimaku по AniList id: главная страница — полный список с data-extra (API без ключа не отвечает). */
function jimakuIndex(): Promise<Record<string, number[]>> {
  return cached("jimaku-index", 86400, async () => {
    const html = await fetchText(`${JIMAKU}/`);
    const out: Record<string, number[]> = {};
    for (const m of html.matchAll(/<div class="entry" data-extra="([^"]+)">\s*<a href="\/entry\/(\d+)"/g)) {
      try {
        const extra = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")) as { anilist_id?: number | null };
        if (extra.anilist_id) (out[extra.anilist_id] ??= []).push(Number(m[2]));
      } catch { /* битая запись — пропускаем */ }
    }
    return out;
  });
}

/** Файлы записи: ссылки на скачивание со страницы записи. */
async function entryFiles(entry: number): Promise<{ name: string; url: string }[]> {
  const html = await fetchText(`${JIMAKU}/entry/${entry}`);
  return [...new Set([...html.matchAll(/href="(\/entry\/\d+\/download\/[^"]+)"/g)].map((m) => m[1]))]
    .map((href) => ({ name: decodeURIComponent(href.replace(/^.*\/download\//, "")), url: `${JIMAKU}${href}` }));
}

type FileRow = { ep: number; name: string; url: string; path: string; hash: string };

const dirOf = (anilistId: number) => join(env.dataDir, "plot", String(anilistId), "sdh");

/** Скачать недостающие файлы серий (уже скачанные не трогаем). */
async function fetchFiles(anilistId: number, signal: AbortSignal, onFile: () => void): Promise<{ rows: FileRow[]; note: string | null }> {
  const entries = (await jimakuIndex())[anilistId] ?? [];
  if (!entries.length) return { rows: storedFiles(anilistId), note: "на Jimaku нет записи тайтла" };
  const files = (await Promise.all(entries.map(entryFiles))).flat();
  // Японские названия серий из справочника (MAL, dアニメ, Fandom) — по ним файл находит свою серию
  const titles = new Map(db.prepare<[number], { ep: number; title_ja: string }>(
    "SELECT ep, title_ja FROM episode_meta WHERE anilist_id = ? AND title_ja IS NOT NULL ORDER BY source = 'mal' DESC").all(anilistId).map((r) => [r.ep, r.title_ja] as const).reverse());
  const d = await getDetails(anilistId);
  const pick = matchFiles(files, titles, d.episodes ?? (d.nextAiringEpisode ? d.nextAiringEpisode.episode - 1 : null));
  const have = new Map(storedFiles(anilistId).map((r) => [r.ep, r]));
  await mkdir(dirOf(anilistId), { recursive: true });
  const put = db.prepare("INSERT OR REPLACE INTO sdh_file (anilist_id, ep, name, url, path, hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const [ep, f] of [...pick].sort((a, b) => a[0] - b[0])) {
    signal.throwIfAborted();
    if (have.get(ep)?.name === f.name) continue;
    const res = await fetchWithRetry(f.url, { headers: { "User-Agent": UA } }, limiter, { timeoutMs: 60_000 });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = f.name.match(/\.(srt|ass|ssa)$/i)?.[1].toLowerCase() ?? "srt";
    const path = join(dirOf(anilistId), `${String(ep).padStart(3, "0")}.${ext}`);
    await writeFile(path, buf);
    put.run(anilistId, ep, f.name, f.url, path, createHash("sha1").update(buf).digest("hex").slice(0, 16), now());
    onFile();
  }
  return { rows: storedFiles(anilistId), note: pick.size ? null : "на Jimaku нет японских субтитров по сериям" };
}

const storedFiles = (anilistId: number) =>
  db.prepare<[number], FileRow>("SELECT ep, name, url, path, hash FROM sdh_file WHERE anilist_id = ? ORDER BY ep").all(anilistId);

// ---------------------------------------------------------------- конспект серии

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** Реплики для модели: «[мм:сс] Говорящий: текст», без метки — «—», звуки в скобках. */
export function scriptText(p: ParsedSubs): string {
  const out: string[] = [];
  for (const c of p.cues) {
    for (const l of c.lines) {
      if (l.kind === "music") continue;
      const who = l.speakers.length ? l.speakers.join("・") : "—";
      out.push(l.kind === "sound" ? `[${mmss(c.start)}] (${l.text})` : `[${mmss(c.start)}] ${who}: ${l.kind === "offscreen" ? `〈${l.text}〉` : l.text}`);
    }
  }
  return out.join("\n");
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    speakers: {
      type: "array", maxItems: 40, description: "кто есть кто: метка в субтитрах → персонаж по-русски",
      items: { type: "object", properties: { label: { type: "string" }, name_ru: { type: "string" } }, required: ["label", "name_ru"] },
    },
    scenes: {
      type: "array", maxItems: 25,
      items: {
        type: "object",
        properties: {
          start: { type: "string", description: "мм:сс" }, where_ru: { type: "string" },
          who: { type: "array", items: { type: "string" } }, what_ru: { type: "string", description: "1–3 предложения: что происходит, кто что говорит и зачем" },
        },
        required: ["start", "where_ru", "who", "what_ru"],
      },
    },
    summary_ru: { type: "string", description: "конспект серии: абзац на сцену или этап, 300–600 слов" },
  },
  required: ["speakers", "scenes", "summary_ru"],
};

const SYSTEM = `Ты составляешь конспект серии аниме по японским субтитрам для слабослышащих — по-русски, для зрителя.
В субтитрах: [время] говорящий: реплика. «—» — говорящий не подписан: определи по смыслу и обращениям, а если не ясно — не называй. В скобках — звуки. 〈〉 — голос из-за кадра (телефон, мысли, издалека).
Правила:
- Только эта серия и только то, что в ней сказано или ясно следует из реплик. Не додумывай того, что могло быть только на экране; не знаешь — пропусти.
- Метки говорящих иногда раскрывают то, чего зритель ещё не знает (настоящее имя таинственного персонажа). Называй персонажей так, как их знает зритель на этот момент.
- Сцены — по смене места, времени или состава. В каждой — кто, где, что происходит, кто что говорит и зачем, что узнают герои.
- Конспект — связным текстом, абзац на сцену или этап; одно предложение — одна мысль; причины и следствия называй.
- Имена из словаря — строго как там; остальные японские имена — по Поливанову. Термины мира переводи по смыслу, если перевод очевиден.`;

type Digest = { speakers: { label: string; name_ru: string }[]; scenes: { start: string; where_ru: string; who: string[]; what_ru: string }[]; summary_ru: string };

const subject = (id: number, ep: number) => `ep:${id}:${ep}`;
const opts = (inputHash: string) => ({ inputHash, policy: "tier-first" as const, staleOk: false });

/** Конспект серии (готовый — из журнала; вход — хэш файла субтитров). */
async function digestEpisode(id: number, f: FileRow, names: Set<string>, glossary: string, prev: string | null): Promise<Digest> {
  const ready = bestOutput<Digest>("sdh", subject(id, f.ep), opts(f.hash));
  if (ready?.fresh) return ready.value;
  const parsed = parseSubs(f.name, await readFile(f.path, "utf-8"), names);
  const user = [
    glossary,
    prev ? `Чем кончилась прошлая серия (для имён и контекста):\n${prev.slice(-1200)}` : "",
    `Серия ${f.ep}. Субтитры:\n${scriptText(parsed)}`,
  ].filter(Boolean).join("\n\n");
  const localOnly = getLlmConfig().tasks.sdh === "local" || getLlmConfig().mode === "local";
  const res = await runTask<Digest>("sdh", { schema: SCHEMA, system: SYSTEM, user, maxTokens: 14_000, timeoutMs: 600_000, minTier: localOnly ? 0 : TIER.cheap });
  recordOutput("sdh", subject(id, f.ep), res, res.value, { schemaV: 1, promptV: PROMPT_V, inputHash: f.hash });
  return res.value;
}

// ---------------------------------------------------------------- задача

// Одна карта на процесс (см. plot-corpus.ts)
const progress = ((globalThis as unknown as { __sdhProgress?: Map<number, CorpusProgress> }).__sdhProgress ??= new Map());
export const sdhProgress = (id: number) => progress.get(id) ?? null;
const touch = (p: CorpusProgress, patch: Partial<CorpusProgress> = {}) => Object.assign(p, patch, { updatedAt: Date.now() });

/** Скачать субтитры, составить конспекты серий по порядку и пересчитать пересказ сезона. */
export async function deepDive(id: number, signal: AbortSignal): Promise<CorpusProgress> {
  const p: CorpusProgress = { anilistId: id, step: "Jimaku", done: 0, total: 1, startedAt: Date.now(), updatedAt: Date.now(), finished: false, found: {}, errors: [], etaSec: null };
  progress.set(id, p);
  const { rows, note } = await fetchFiles(id, signal, () => touch(p));
  if (note) p.errors.push(note);
  const d = await getDetails(id);
  const chars = await characterGlossary(d.idMal).catch(() => []);
  // Японские имена справочника — чтобы «（リムル）» не приняли за звук
  const names = new Set(chars.flatMap((c) => c.names).filter((n) => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]/u.test(n)));
  const glossary = chars.length ? `Словарь имён (Shikimori):\n${chars.slice(0, 60).map((c) => `${c.names.slice(0, 3).join(" / ")} → ${c.ru}`).join("\n")}` : "";
  touch(p, { step: "Конспекты серий", total: rows.length + 1 });
  const digests = new Map<number, Digest>();
  let prev: string | null = null;
  const started = Date.now();
  for (const [i, f] of rows.entries()) {
    signal.throwIfAborted();
    try {
      const dg = await digestEpisode(id, f, names, glossary, prev);
      digests.set(f.ep, dg);
      prev = dg.summary_ru;
    } catch (e) {
      if (signal.aborted) throw e;
      p.errors.push(`серия ${f.ep}: ${e instanceof Error ? e.message : String(e)}`);
      prev = null;
    }
    const per = (Date.now() - started) / 1000 / (i + 1);
    touch(p, { done: i + 1, etaSec: Math.round(per * (rows.length - i - 1)) });
  }
  // В корпус — все готовые конспекты разом (набор источника заменяет прежний)
  const found: Found[] = [...digests].map(([ep, dg]) => ({ ep, title: null, text: dg.summary_ru, url: null }));
  if (found.length) putTexts(id, "sdh", "ru", "script", "субтитры Jimaku — только локально", found);
  p.found.sdh = found.length;
  touch(p, { step: "Пересказ сезона" });
  try {
    await buildSeasonPlot(id, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    p.errors.push(`Пересказ сезона: ${e instanceof Error ? e.message : String(e)}`);
  }
  touch(p, { step: "готово", done: p.total, finished: true, etaSec: 0 });
  return p;
}

registerHandler("sdh", {
  noun: "Глубокий разбор готов",
  anilistId: async (key) => Number(key) || null,
  title: async (key) => {
    const d = await getDetails(Number(key));
    return d.title.romaji ?? d.title.english ?? `#${key}`;
  },
  fresh: () => false,
  href: (key) => `/anime/${key}`,
  run: async (key, signal) => {
    const p = await deepDive(Number(key), signal);
    const total = corpusOf(Number(key)).filter((t) => t.source === "sdh").length;
    return { summary: `Конспектов серий по субтитрам: ${total}` + (p.errors.length ? ` (ошибки: ${p.errors.length})` : ""), isNew: total > 0 };
  },
});
