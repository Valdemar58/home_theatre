import "server-only";
import sharp from "sharp";
import type { JsonSchema } from "@/lib/json-lite";
import { bubbles, type Bubble, type OcrLine } from "@/lib/manga-ocr";
import { glossaryFor } from "@/lib/translate-text";
import { cached } from "../cache";
import { franchiseGlossary } from "../glossary";
import { bestOutput, hashOf, recordOutput } from "../knowledge";
import { runTask } from "../llm";
import { mapvec, mapvecUp } from "../mapvec";
import { registerHandler, startTask } from "../tasks";
import { bookDetails } from "./anilist-books";
import { chapterContent } from "./library";
import { pageImage } from "./pages-cache";

// Автоперевод манги (TASKS 5.8): страницы главы → строки текста (dots.mocr в mapvec, страница за проход; длинная
// полоса манхвы — кусками) → пузыри (lib/manga-ocr.ts) → перевод пузырей всей главы пачками по глоссарию франшизы
// (текстовая задача — можно и внешней модели, картинки наружу не уходят). Результат — в llm_output
// `manga:<книга>:<провайдер>:<глава>`, рамки — в долях страницы (0–1000), ридер рисует слой поверх картинки.

export type MangaBubble = { x0: number; y0: number; x1: number; y1: number; text: string; ru: string; vertical: boolean };
export type MangaAi = { pages: { w: number; h: number; bubbles: MangaBubble[] }[] };
const subject = (bookId: number, provider: string, cref: string) => `manga:${bookId}:${provider}:${cref}`;
const PROMPT_V = 1;
// Пачка реплик на запрос: локальной модели 60 не хватило лимита ответа
const BATCH = 25;

export const mangaAi = (bookId: number, provider: string, cref: string) =>
  bestOutput<MangaAi>("manga_translate", subject(bookId, provider, cref), { policy: "tier-first", staleOk: true });

/** Строки страницы: целиком или кусками по высоте (полоса манхвы), повторы на стыках — по пересечению. */
async function pageLines(img: Buffer, signal: AbortSignal): Promise<{ w: number; h: number; lines: OcrLine[] }> {
  const meta = await sharp(img).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (h <= w * 2) {
    const png = await sharp(img).png().toBuffer();
    const r = await mapvec<{ lines: OcrLine[] }>("/lines", new Uint8Array(png), signal);
    return { w, h, lines: r.lines };
  }
  const step = Math.round(w * 1.4), over = Math.round(w * 0.25);
  const out: OcrLine[] = [];
  for (let top = 0; top < h; top += step - over) {
    const ch = Math.min(step, h - top);
    const png = await sharp(img).extract({ left: 0, top, width: w, height: ch }).png().toBuffer();
    const r = await mapvec<{ lines: OcrLine[] }>("/lines", new Uint8Array(png), signal);
    for (const l of r.lines) {
      const g = { ...l, y0: l.y0 + top, y1: l.y1 + top };
      const dup = out.some((o) => {
        const ix = Math.max(0, Math.min(o.x1, g.x1) - Math.max(o.x0, g.x0));
        const iy = Math.max(0, Math.min(o.y1, g.y1) - Math.max(o.y0, g.y0));
        return ix * iy > 0.5 * Math.min((o.x1 - o.x0) * (o.y1 - o.y0), (g.x1 - g.x0) * (g.y1 - g.y0));
      });
      if (!dup) out.push(g);
    }
    if (top + ch >= h) break;
  }
  return { w, h, lines: out };
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, ru: { type: "string" } }, required: ["id", "ru"] } } },
  required: ["items"],
};
const SYSTEM = `Ты переводишь реплики манги на русский язык для вставки в пузыри: коротко, живо и естественно, как в хорошем русском издании.
Каждая строка входа — один пузырь (или надпись) в порядке чтения: «id: текст». Распознавание могло ошибиться в отдельных знаках — восстанови смысл по контексту.
Имена и термины из словаря пиши строго как в словаре. Звукоподражания передавай кратко по-русски (БАХ, ШУРХ). Мусор распознавания (случайные знаки) переводи пустой строкой.
Верни перевод каждого id.`;

/** Перевести главу манги (готовое — сразу). */
export async function translateMangaChapter(bookId: number, provider: string, cref: string, signal: AbortSignal): Promise<{ isNew: boolean; bubbles: number }> {
  if (!(await mapvecUp())) throw new Error("Для перевода манги нужен контейнер mapvec (профиль mapvec): он читает текст на страницах");
  const content = await chapterContent(bookId, provider, cref);
  if (content.kind !== "pages") throw new Error("Это не страницы манги");
  const inputHash = hashOf({ pages: content.pages.map((p) => p.url), v: PROMPT_V });
  const ready = bestOutput<MangaAi>("manga_translate", subject(bookId, provider, cref), { inputHash, policy: "tier-first", staleOk: false });
  if (ready?.fresh) return { isNew: false, bubbles: ready.value.pages.reduce((n, p) => n + p.bubbles.length, 0) };

  const pages: { w: number; h: number; bubbles: Bubble[] }[] = [];
  for (const p of content.pages) {
    if (signal.aborted) throw new Error("Отменено");
    // Строки страницы — в хранилище навсегда: сбой перевода не заставляет читать страницы заново
    const r = await cached(`manga-ocr:${hashOf(p.url)}`, { fresh: 10 * 365 * 86400 }, async () => pageLines((await pageImage(provider, p.url)).body, signal));
    pages.push({ w: r.w, h: r.h, bubbles: bubbles(r.lines) });
  }
  const all = pages.flatMap((p, pi) => p.bubbles.map((b, bi) => ({ id: `${pi + 1}.${bi + 1}`, b })));
  const book = await bookDetails(bookId);
  const dict = await franchiseGlossary({ book: bookId });
  const ru = new Map<string, string>();
  let usage = { provider: "", model: "", tier: 99, usageId: null as number | null };
  for (let k = 0; k < all.length; k += BATCH) {
    const batch = all.slice(k, k + BATCH);
    const text = batch.map((x) => `${x.id}: ${x.b.text.replace(/\n/g, " ")}`).join("\n");
    const gl = glossaryFor(text, dict, 60);
    const user = [
      `Манга: ${book.title.ru ?? book.title.english ?? book.title.romaji ?? ""}${book.title.native ? ` (${book.title.native})` : ""}`,
      gl.length ? `Словарь (писать строго так):\n${gl.join("\n")}` : "",
      `Реплики:\n${text}`,
    ].filter(Boolean).join("\n\n");
    const res = await runTask<{ items: { id: string; ru: string }[] }>("manga_translate", { schema: SCHEMA, system: SYSTEM, user, maxTokens: 8000, timeoutMs: 600_000 });
    for (const it of res.value.items) ru.set(String(it.id).trim(), it.ru.trim());
    if (res.tier < usage.tier) usage = { provider: res.provider, model: res.model, tier: res.tier, usageId: res.usageId };
  }
  // Рамки — в долях страницы (0–1000): слой поверх картинки не зависит от её размера на экране
  const value: MangaAi = {
    pages: pages.map((p, pi) => ({
      w: p.w, h: p.h,
      bubbles: p.bubbles.map((b, bi) => ({
        x0: Math.round((b.x0 / p.w) * 1000), y0: Math.round((b.y0 / p.h) * 1000), x1: Math.round((b.x1 / p.w) * 1000), y1: Math.round((b.y1 / p.h) * 1000),
        text: b.text, ru: ru.get(`${pi + 1}.${bi + 1}`) ?? "", vertical: b.vertical,
      })).filter((b) => b.ru),
    })),
  };
  if (all.length) recordOutput("manga_translate", subject(bookId, provider, cref), usage, value, { schemaV: 1, promptV: PROMPT_V, inputHash });
  return { isNew: true, bubbles: all.length };
}

const taskKey = (bookId: number, provider: string, cref: string) => `${bookId}|${provider}|${cref}`;
const parseKey = (k: string) => {
  const [id, provider, ...rest] = k.split("|");
  return { bookId: Number(id), provider, cref: rest.join("|") };
};

export const queueMangaTranslate = (userId: number, bookId: number, provider: string, cref: string) =>
  startTask("manga_translate", taskKey(bookId, provider, cref), { userId, origin: "user", notify: true });

registerHandler("manga_translate", {
  noun: "Перевод страниц готов",
  title: async (k) => {
    const { bookId } = parseKey(k);
    const b = await bookDetails(bookId);
    return `${b.title.ru ?? b.title.romaji ?? `#${bookId}`}: перевод страниц`;
  },
  fresh: (k) => {
    const { bookId, provider, cref } = parseKey(k);
    return Boolean(mangaAi(bookId, provider, cref));
  },
  href: (k) => `/manga/${parseKey(k).bookId}`,
  run: async (k, signal) => {
    const { bookId, provider, cref } = parseKey(k);
    const r = await translateMangaChapter(bookId, provider, cref, signal);
    return { summary: r.isNew ? `Переведено пузырей: ${r.bubbles}` : "Глава уже переведена", isNew: r.isNew };
  },
});
