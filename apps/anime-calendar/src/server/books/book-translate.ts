import "server-only";
import { aiCref, assemble, segments } from "@/lib/book-translate";
import { blocksText, chapterName, summarize, type Block, type ChapterSummary, type Edition } from "@/lib/books";
import type { TermKind } from "@/lib/glossary";
import type { JsonSchema } from "@/lib/json-lite";
import { glossaryFor } from "@/lib/translate-text";
import { db, now } from "../db";
import { addFound, franchiseGlossary, glossaryRoot } from "../glossary";
import { bestOutput, hashOf, recordOutput } from "../knowledge";
import { runTask } from "../llm";
import { registerHandler, startTask } from "../tasks";
import { bookDetails } from "./anilist-books";
import { aiChapter, aiSubject as subject, type AiStored as Stored } from "./ai-chapters";
import { chapterContent, chapterRows } from "./library";

// Автоперевод глав ранобэ (TASKS 5.7): глава без русского перевода — с японского оригинала (Syosetu) или английского.
// Куски по абзацам, словарь — единый глоссарий франшизы (термины куска), для связности — конец прошлого куска и
// прошлой переведённой главы. Новые имена и термины модель предлагает — они идут в глоссарий «на проверку».
// Перевод — в журнале llm_output без срока (book:<id>:<издание>:<глава>), в оглавлении — язык «ai» (таблица book_ai).

const PROMPT_V = 2;

const KINDS: TermKind[] = ["name", "place", "term", "skill", "title"];
const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    text_ru: { type: "string", description: "перевод фрагмента на русский, абзацы через пустую строку — столько же, сколько в оригинале" },
    new_terms: {
      type: "array", description: "новые собственные имена и названия мира, которых нет в словаре; обычных слов не включать",
      items: {
        type: "object",
        properties: { source: { type: "string" }, ru: { type: "string" }, kind: { type: "string", enum: KINDS } },
        required: ["source", "ru", "kind"],
      },
    },
  },
  required: ["text_ru", "new_terms"],
};

const SYSTEM = `Ты переводчик ранобэ на русский язык: литературно, живо и точно, как хороший издательский перевод.
Переводи полностью, ничего не пропускай и не добавляй от себя. Абзацы сохраняй: один абзац оригинала — один абзац перевода, абзацы разделяй пустой строкой.
Диалоги оформляй по-русски (тире или кавычки «ёлочки»), японские звукоподражания передавай по-русски.
Имена и термины из словаря пиши строго как в словаре и склоняй по-русски. Остальные японские имена — по системе Поливанова (ши → си, цу, дзи).
Названия навыков, титулов, мест и организаций переводи по смыслу, если перевод очевиден; иначе — транслитерация.
В new_terms перечисли только новые собственные имена и названия этого мира, которых нет в словаре: персонажей, мест, стран, организаций, навыков и заклинаний, титулов. Обычные слова, жаргон и названия вещей нашего мира (блог, фигурка, игра, причёска) туда не включай. Для каждого — как в оригинале (source), как ты написал по-русски (ru) и вид. Нет новых имён — пустой список.
Если дан переведённый предыдущий фрагмент — держись тех же вариантов имён, обращений и стиля.`;

/** Источник перевода главы: японский оригинал с текстом, иначе английский. */
const sourceOf = (c: ChapterSummary) => c.langs.orig?.[0] ?? c.langs.en?.[0] ?? null;

function chapterOf(bookId: number, edition: Edition, key: string): { c: ChapterSummary; prev: ChapterSummary | null; all: ChapterSummary[] } | null {
  const ed = summarize(chapterRows(bookId)).find((e) => e.edition === edition);
  const i = ed ? ed.chapters.findIndex((c) => c.key === key) : -1;
  return i < 0 ? null : { c: ed!.chapters[i], prev: ed!.chapters[i - 1] ?? null, all: ed!.chapters };
}

/** Перевести главу (готовый перевод — сразу). */
export async function translateChapter(bookId: number, edition: Edition, key: string, signal?: AbortSignal): Promise<{ isNew: boolean; name: string }> {
  const at = chapterOf(bookId, edition, key);
  if (!at) throw new Error("Главы нет в оглавлении книги");
  const name = chapterName(at.c, edition);
  const src = sourceOf(at.c);
  if (!src) throw new Error("Нет ни японского оригинала, ни английского перевода главы");
  const content = await chapterContent(bookId, src.provider, src.cref);
  if (content.kind !== "text") throw new Error("Перевод ИИ пока только для текста (ранобэ)");
  const inputHash = hashOf({ text: blocksText(content.blocks), v: PROMPT_V });
  const ready = bestOutput<Stored>("book_translate", subject(bookId, edition, key), { inputHash, policy: "tier-first", staleOk: false });
  if (ready?.fresh) return { isNew: false, name };

  const book = await bookDetails(bookId);
  const root = await glossaryRoot({ book: bookId }).catch(() => null);
  const dict = await franchiseGlossary({ book: bookId });
  const prevTail = at.prev ? blocksText(aiChapter(bookId, edition, at.prev.key)?.value.blocks ?? []).slice(-800) : "";
  const ja = src.lang === "ja" || at.c.langs.orig?.[0] === src;
  const segs = segments(content.blocks, ja ? 2500 : 5000);
  const head = `Книга: ${book.title.ru ?? book.title.english ?? book.title.romaji ?? ""}${book.title.native ? ` (${book.title.native})` : ""}. ${name}${at.c.title ? ` — «${at.c.title}»` : ""}. Перевод с ${ja ? "японского" : "английского"}.`;
  const parts: string[] = [];
  const found: { source: string; ru: string; kind: TermKind }[] = [];
  let usage = { provider: "", model: "", tier: 99, usageId: null as number | null };
  for (const s of segs) {
    if (s.t !== "text") continue;
    if (signal?.aborted) throw new Error("Отменено");
    const chunk = s.paras.join("\n\n");
    const gl = glossaryFor(chunk, dict, 80);
    const prev = parts.at(-1) ?? prevTail;
    const user = [
      head,
      gl.length ? `Словарь (писать строго так):\n${gl.join("\n")}` : "",
      prev ? `Предыдущий фрагмент в переводе (для связности, не переводи заново):\n${prev.slice(-1200)}` : "",
      `Фрагмент для перевода (${s.paras.length} абз.):\n${chunk}`,
    ].filter(Boolean).join("\n\n");
    const res = await runTask<{ text_ru: string; new_terms: { source: string; ru: string; kind: TermKind }[] }>("book_translate",
      { schema: SCHEMA, system: SYSTEM, user, maxTokens: 8000, timeoutMs: 600_000 });
    parts.push(res.value.text_ru.trim());
    found.push(...res.value.new_terms);
    if (res.tier < usage.tier) usage = { provider: res.provider, model: res.model, tier: res.tier, usageId: res.usageId };
  }
  const blocks = assemble(segs, parts);
  recordOutput("book_translate", subject(bookId, edition, key), usage,
    { blocks, source: { provider: src.provider, cref: src.cref, lang: src.lang } } satisfies Stored, { schemaV: 1, promptV: PROMPT_V, inputHash });
  db.prepare(`INSERT INTO book_ai (book_id, edition, chapter_key, vol, num, num_text, title, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (book_id, edition, chapter_key) DO UPDATE SET model = excluded.model, created_at = excluded.created_at`)
    .run(bookId, edition, key, at.c.vol, at.c.num, at.c.numText, at.c.title, usage.model, now());
  // Новые имена и термины — в глоссарий на проверку (уже известные просто дополнятся написанием)
  if (root && found.length) {
    addFound(root, found.filter((t) => t.source?.trim() && t.ru?.trim()).map((t) => {
      const jp = /[぀-ヿ一-鿿]/.test(t.source);
      return { kind: KINDS.includes(t.kind) ? t.kind : "term", ja: jp ? t.source.trim() : null, en: jp ? null : t.source.trim(), ru: t.ru.trim(), alts: [], source: "ai" as const };
    }));
  }
  return { isNew: true, name };
}

/** Главы для перевода «вперёд»: следующие n глав после key без русского и без перевода ИИ, но с источником. */
export function aheadKeys(bookId: number, edition: Edition, key: string, n: number): string[] {
  const at = chapterOf(bookId, edition, key);
  if (!at) return [];
  const i = at.all.findIndex((c) => c.key === key);
  return at.all.slice(i + 1).filter((c) => !c.langs.ru && !c.langs.ai && sourceOf(c)).slice(0, n).map((c) => c.key);
}

const taskKey = (bookId: number, edition: Edition, key: string) => `${bookId}|${edition}|${key}`;
const parseKey = (k: string) => {
  const [id, edition, ...rest] = k.split("|");
  return { bookId: Number(id), edition: edition as Edition, key: rest.join("|") };
};

/** Перевод вперёд по мере чтения: n следующих глав — автоматически, после ручных. */
export async function queueAhead(userId: number, bookId: number, edition: Edition, key: string, n: number) {
  for (const k of aheadKeys(bookId, edition, key, n)) await startTask("book_translate", taskKey(bookId, edition, k), { userId, origin: "auto", notify: false });
}

/** Поставить перевод главы (и n следующих — автоматически, после ручных) в очередь. */
export async function queueTranslate(userId: number, bookId: number, edition: Edition, key: string, ahead = 0) {
  const first = await startTask("book_translate", taskKey(bookId, edition, key), { userId, origin: "user", notify: true });
  for (const k of aheadKeys(bookId, edition, key, ahead)) await startTask("book_translate", taskKey(bookId, edition, k), { userId, origin: "auto", notify: false });
  return first;
}

registerHandler("book_translate", {
  noun: "Глава переведена",
  title: async (k) => {
    const { bookId, edition, key } = parseKey(k);
    const b = await bookDetails(bookId);
    const at = chapterOf(bookId, edition, key);
    return `${b.title.ru ?? b.title.romaji ?? `#${bookId}`}: ${at ? chapterName(at.c, edition).toLowerCase() : key}`;
  },
  fresh: (k) => {
    const { bookId, edition, key } = parseKey(k);
    return Boolean(aiChapter(bookId, edition, key));
  },
  href: (k) => {
    const { bookId, edition, key } = parseKey(k);
    return `/manga/${bookId}/read?e=${edition}&c=${encodeURIComponent(key)}&p=ai&r=${encodeURIComponent(aiCref(edition, key))}`;
  },
  run: async (k, signal) => {
    const { bookId, edition, key } = parseKey(k);
    const r = await translateChapter(bookId, edition, key, signal);
    return { summary: r.isNew ? `${r.name} — перевод ИИ готов` : `${r.name} уже переведена`, isNew: r.isNew };
  },
});
