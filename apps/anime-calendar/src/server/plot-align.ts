import "server-only";
import { chapterName, summarize, translationsOf, type ChapterSummary, type EditionSummary } from "@/lib/books";
import type { JsonSchema } from "@/lib/json-lite";
import { alignPlot, needsMore, simMatrix } from "@/lib/plot-align";
import { alignRows, fandomChapters } from "./adapt";
import { getDetails } from "./anilist";
import { bookDetails } from "./books/anilist-books";
import { chapterContent, chapterRows } from "./books/library";
import { corpusOf, deepestByEpisode } from "./corpus-store";
import { db, now } from "./db";
import { franchiseGraph } from "./franchise";
import { hashOf, produce } from "./knowledge";
import { embed, embedAvailable } from "./llm";
import { registerHandler } from "./tasks";

// Сопоставление серий и глав по сюжету (TASKS 5.11, IDEAS #90). Серии — самые подробные пересказы корпуса
// (вики, Fandom, MAL, конспекты субтитров); главы — короткий пересказ ИИ по тексту главы (задача chapter_digest,
// навсегда в llm_output). Похожесть — локальные эмбеддинги, порядок — выравниванием (lib/plot-align.ts).
// Окно глав — от конца предыдущего сезона той же книги; не хватило — расширяется. Итог — plot_align по сериям.

const DIGEST_SCHEMA: JsonSchema = {
  type: "object",
  properties: { digest: { type: "string", description: "4–6 предложений по-английски: что происходит в главе — кто, что делает, где, что открывается; имена персонажей" } },
  required: ["digest"],
};
const DIGEST = { schemaV: 1, promptV: 1, policy: "tier-first" as const, staleOk: true };
const TEXT_MAX = 14_000;
const EP_MAX = 3_000;

/** Издание для сопоставления — то, где больше глав с текстом (ранобэ: веб-версия часто полнее книжной). */
function pickEdition(eds: EditionSummary[]): EditionSummary | null {
  return [...eds].sort((a, b) => b.chapters.length - a.chapters.length)[0] ?? null;
}

/**
 * Главы манги для сопоставления — и те, что есть у провайдеров, и описанные на вики (лицензионную мангу
 * провайдеры часто не отдают, а вики знает все главы). Глава только с вики — без переводов (читать — на странице книги).
 */
function withWiki(ed: EditionSummary | null, wiki: Record<number, string>): EditionSummary | null {
  const nums = Object.keys(wiki).map(Number);
  if (!nums.length) return ed;
  const base: EditionSummary = ed?.edition === "main" ? ed : { edition: "main", chapters: [], langs: [], missingRu: [] };
  const known = new Set(base.chapters.map((c) => c.num));
  const extra: ChapterSummary[] = nums.filter((n) => !known.has(n)).map((n) => ({ key: String(n), vol: null, num: n, numText: String(n), title: null, langs: {} }));
  return { ...base, chapters: [...base.chapters, ...extra].sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity)) };
}

const GAP = 5;

/**
 * Сколько глав окна идут без большой дыры в пересказах: между соседними главами с пересказом — не больше GAP
 * номеров (у вики бывают пересказаны главы 1–17 и 94–128, а между ними — ничего).
 */
function coveredUntil(chs: ChapterSummary[], digests: (string | null)[]): number {
  let last: number | null = null;
  let lastIdx = -1;
  for (let j = 0; j < digests.length; j++) {
    const num: number = chs[j].num ?? (last ?? 0) + (j - lastIdx);
    if ((last !== null && num - last > GAP) || (last === null && j >= GAP)) return Math.max(0, lastIdx + 1);
    if (digests[j]) { last = num; lastIdx = j; }
  }
  return digests.length;
}

/** Пересказ главы (ИИ, один раз); null — текста нет (картинки, внешняя ссылка). */
async function digest(bookId: number, edition: string, c: ChapterSummary, bad: Set<string>): Promise<string | null> {
  // Текст — из первого перевода, который его отдаёт (русский, ИИ, английский, оригинал). Провайдер, не отдавший
  // текст (выключен, сбой, долго), до конца задачи пропускается — иначе сотни глав ждут его тайм-аут
  let text = "";
  for (const t of translationsOf(c)) {
    if (bad.has(t.provider)) continue;
    const content = await Promise.race([
      chapterContent(bookId, t.provider, t.cref).catch(() => null),
      new Promise<null>((ok) => setTimeout(() => ok(null), 30_000)),
    ]);
    if (content?.kind !== "text") { bad.add(t.provider); continue; }
    text = content.blocks.map((b) => (b.t === "p" ? b.text : "")).filter(Boolean).join("\n").slice(0, TEXT_MAX);
    if (text.length >= 200) break;
  }
  if (text.length < 200) return null;
  const k = await produce<string>("chapter_digest", `chapter:${bookId}:${edition}:${c.key}`, {
    ...DIGEST, inputHash: hashOf(text), schema: DIGEST_SCHEMA, maxTokens: 600,
    system: "You summarize one chapter of a novel or manga for matching it with anime episodes. Only events from the text, no speculation. English.",
    user: () => `Chapter: ${c.numText}${c.title ? ` — ${c.title}` : ""}\n\n${text}`,
    shape: (a) => String((a as { digest?: string }).digest ?? "").trim(),
  });
  return k?.value || null;
}

/** Где закончился предыдущий сезон той же книги и издания (индекс главы в издании; -1 — с начала). */
async function previousEnd(animeId: number, bookId: number, ed: EditionSummary): Promise<number> {
  const { items } = await franchiseGraph(animeId);
  const story = items.filter((i) => i.kind === "main" || i.kind === "side").map((i) => i.media.id);
  const before = story.slice(0, Math.max(0, story.indexOf(animeId)));
  let end = -1;
  for (const id of before) {
    for (const r of alignRows(id)) {
      if (r.book_id !== bookId || r.edition !== ed.edition) continue;
      end = Math.max(end, ed.chapters.findIndex((c) => c.key === r.to_key));
    }
  }
  return end;
}

export async function alignSeason(animeId: number, bookId: number, signal: AbortSignal): Promise<{ episodes: number; matched: number; label: string }> {
  if (!(await embedAvailable())) throw new Error("Нет локальных эмбеддингов (Ollama, bge-m3) — сопоставить не получится");
  const media = await getDetails(animeId);
  const texts = deepestByEpisode(corpusOf(animeId));
  if (!texts.size) throw new Error("У сезона нет пересказов серий — сначала «Собрать сюжет» на странице тайтла");
  const count = Math.max(media.episodes ?? 0, ...texts.keys());
  const eps = Array.from({ length: count }, (_, i) => texts.get(i + 1)?.text.slice(0, EP_MAX) ?? "");

  // Манга: пересказы глав с вики франшизы (вместо пересказа ИИ по картинкам)
  const book = await bookDetails(bookId);
  const wiki = book.kind !== "novel" ? await fandomChapters(animeId).catch(() => ({} as Record<number, string>)) : {};
  const fromWiki = (c: ChapterSummary) => (c.num !== null && wiki[c.num] ? wiki[c.num].slice(0, EP_MAX) : null);
  if (book.kind !== "novel" && !Object.keys(wiki).length) throw new Error("Пересказов глав манги на вики франшизы нет (распознавание страниц — следующий шаг)");
  const ed = withWiki(pickEdition(summarize(chapterRows(bookId))), wiki);
  if (!ed?.chapters.length) throw new Error("У книги нет глав у провайдеров");

  const epVec = await embed(eps.map((t) => t || "—"));
  const start = Math.max(0, (await previousEnd(animeId, bookId, ed)) - 1);
  let size = Math.max(30, count * 4);
  const digests: (string | null)[] = [];
  const bad = new Set<string>();
  const vecs: number[][] = [];
  let alignment = alignPlot([]);
  for (let round = 0; round < 4; round++) {
    const want = ed.chapters.slice(start, start + size);
    for (let j = digests.length; j < want.length; j++) {
      signal.throwIfAborted();
      const w = fromWiki(want[j]);
      if (w || book.kind !== "novel") { digests.push(w); continue; }
      digests.push(await digest(bookId, ed.edition, want[j], bad).catch((e) => { console.warn(`[align] ${bookId} гл. ${want[j].key}: ${String(e).slice(0, 200)}`); return null; }));
    }
    const fresh = digests.slice(vecs.length);
    if (fresh.length) vecs.push(...(await embed(fresh.map((d) => d ?? "—"))));
    // Главы без текста — нулевой вектор (ни на что не похожи)
    // Дыра в данных (подряд больше GAP глав без пересказа) — дальше не сопоставляем: иначе поздние серии
    // перескочат через дыру на далёкие главы
    const usable = coveredUntil(want, digests);
    const chVec = vecs.slice(0, usable).map((v, j) => (digests[j] ? v : v.map(() => 0)));
    alignment = alignPlot(simMatrix(chVec, epVec.map((v, i) => (eps[i] ? v : v.map(() => 0)))));
    if (usable < want.length || !needsMore(alignment, usable) || start + size >= ed.chapters.length) break;
    size += Math.max(20, count * 2);
  }

  const del = db.prepare("DELETE FROM plot_align WHERE anime_id = ?");
  const put = db.prepare(`INSERT INTO plot_align (anime_id, ep, book_id, edition, from_key, to_key, from_num, to_num, from_vol, to_vol, score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  del.run(animeId);
  let matched = 0;
  const chs = ed.chapters.slice(start);
  alignment.episodes.forEach((r, i) => {
    if (!r) return;
    matched++;
    const a = chs[r[0]], b = chs[r[1]];
    put.run(animeId, i + 1, bookId, ed.edition, a.key, b.key, a.num, b.num, a.vol, b.vol, alignment.score[i], now());
  });
  const rows = alignRows(animeId);
  const label = rows.length ? `${chapterName(chs.find((c) => c.key === rows[0].from_key)!, ed.edition)} — ${chapterName(chs.find((c) => c.key === rows.at(-1)!.to_key)!, ed.edition).toLowerCase()}` : "главы не найдены";
  return { episodes: count, matched, label };
}

const parseKey = (k: string) => {
  const [anime, book] = k.split("|").map(Number);
  return { anime, book };
};

registerHandler("align", {
  noun: "Серии и главы сопоставлены",
  title: async (k) => {
    const { anime, book } = parseKey(k);
    const [m, b] = await Promise.all([getDetails(anime).catch(() => null), bookDetails(book).catch(() => null)]);
    return `${m?.title.ru ?? m?.title.romaji ?? `#${anime}`} ↔ ${b?.title.ru ?? b?.title.romaji ?? `#${book}`}`;
  },
  fresh: () => false,
  href: (k) => `/franchise/${parseKey(k).anime}`,
  anilistId: async (k) => parseKey(k).anime,
  run: async (k, signal) => {
    const { anime, book } = parseKey(k);
    const r = await alignSeason(anime, book, signal);
    return { summary: `${r.matched} из ${r.episodes} серий: ${r.label}`, isNew: true };
  },
});
