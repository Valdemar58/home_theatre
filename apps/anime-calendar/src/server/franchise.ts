import "server-only";
import { chapterName, pickTranslation, summarize, type BookDetails, type BookLite, type EditionSummary } from "@/lib/books";
import {
  bookSeeds, franchiseBooks, franchiseBranches, franchiseItems, franchiseProgress, franchiseRoot, FRANCHISE_LIMIT, nextUp,
  type EntryLite, type FranchiseItem, type FranchiseKind, type FranchiseNode,
} from "@/lib/franchise";
import type { JsonSchema } from "@/lib/json-lite";
import { displayTitle } from "@/lib/schedule";
import type { FranchiseView, MediaLite } from "@/lib/types";
import { adaptRanges, alignRows } from "./adapt";
import { getDetails, type AnilistDetails } from "./anilist";
import { enqueue } from "./archive";
import { booksForAnime, bookDetails, type AnimeBook } from "./books/anilist-books";
import { chapterRows } from "./books/library";
import { getCached } from "./cache";
import { db } from "./db";
import { bestOutput, hashOf, produce } from "./knowledge";
import { withShikimori } from "./lists";
import { seasonArcs } from "./plot-graph";

// Страница франшизы (IDEAS #80, TASKS 5.10): все формы — аниме, манга, ранобэ — сюжетно связанные, в порядке выхода,
// мой прогресс по каждой форме, ответвления группами, кроссоверы, общее описание. Страницы тайтлов — из кэша AniList;
// недостающие аниме догружает архив, книги — очередь ниже (франшиза вроде Gundam — сотни связей, ждать их здесь
// нельзя), страница переспрашивает, пока partial.

const STORY = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "SUMMARY"]);
// Книга ↔ книга: ещё и адаптации (манга по ранобэ)
const BOOK_STORY = new Set([...STORY, "ADAPTATION", "SOURCE"]);
const BOOK_LIMIT = 40;
// С каких аниме искать книги: десятков сезонов хватает, пересказы и клипы книг не дают
const BOOK_ANIME = 30;

/** Карточка без описания, тегов, расписания и связей — в ответе десятки тайтлов. */
function lite(m: MediaLite): MediaLite {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { coverXL, description, synonyms, trailer, tags, schedule, relations, ...rest } = m as MediaLite & Record<string, unknown>;
  return rest;
}

const node = (d: AnilistDetails): FranchiseNode => ({ media: d, rel: d.relations.map((r) => ({ type: r.relationType, id: r.media.id })) });

/** Тайтлы франшизы из кэша AniList (недостающие — в очередь архива), корень и порядок. */
export async function franchiseGraph(id: number) {
  const start = await getDetails(id);
  const nodes = new Map<number, FranchiseNode>([[id, node(start)]]);
  const missing: number[] = [];
  const queue: AnilistDetails[] = [start];
  while (queue.length && nodes.size < FRANCHISE_LIMIT * 2) {
    const d = queue.shift()!;
    for (const r of d.relations) {
      if (!STORY.has(r.relationType) || nodes.has(r.media.id)) continue;
      const full = getCached<AnilistDetails>(`media:v2:${r.media.id}`, true);
      nodes.set(r.media.id, full ? node(full) : { media: r.media, rel: null });
      if (full) queue.push(full);
      else missing.push(r.media.id);
    }
  }
  if (missing.length) enqueue(missing, "page", `open:${id}`, 1);
  const root = franchiseRoot(id, nodes);
  return { root, items: franchiseItems(root, nodes), nodes, partial: missing.length > 0 };
}

// ---------------------------------------------------------------- догрузка книг

// Страницы книг и книги аниме, которых нет в кэше, — по одной в фоне (AniList: 30 запросов в минуту на всех)
const g = globalThis as unknown as { __franchiseBooks?: { keys: Set<string>; queue: [string, () => Promise<unknown>][]; running: boolean } };
const later = (g.__franchiseBooks ??= { keys: new Set(), queue: [], running: false });

function fetchLater(key: string, fn: () => Promise<unknown>) {
  if (later.keys.has(key)) return;
  later.keys.add(key);
  later.queue.push([key, fn]);
  if (later.running) return;
  later.running = true;
  void (async () => {
    while (later.queue.length) {
      const [k, job] = later.queue.shift()!;
      await job().catch((e) => console.warn(`[franchise] ${k}: ${String(e).slice(0, 200)}`));
      later.keys.delete(k);
    }
    later.running = false;
  })();
}

const bookCached = (id: number) => getCached<BookDetails>(`book:v1:${id}`, true);

/** Карточка книги из связи аниме (пока страницы книги нет). */
const fromRelation = (r: AnimeBook): BookLite => ({
  id: r.id, idMal: null, format: r.format, kind: r.format === "NOVEL" ? "novel" : r.format === "ONE_SHOT" ? "oneshot" : "manga",
  status: r.status, chapters: null, volumes: null, countryOfOrigin: null, isAdult: false,
  title: { romaji: r.title, english: null, native: null, ru: r.ru }, coverImage: { large: r.cover, color: null }, year: r.year, averageScore: null,
});

/** Узел книги для обхода: даты — только год (точнее AniList у связей не даёт). */
const bookNode = (b: BookLite, rel: { type: string; id: number }[] | null): FranchiseNode => ({
  media: { id: b.id, format: b.format, startDate: { year: b.year, month: null, day: null } } as MediaLite, rel,
});

const bookRel = (d: BookDetails) => d.relations.filter((r) => r.type === "MANGA" && BOOK_STORY.has(r.relationType)).map((r) => ({ type: r.relationType, id: r.id }));

/**
 * Книги франшизы: от связанных с аниме (или от корня, если аниме нет) по связям книг. Возвращает книги с видом,
 * карточки, пары связей (для ответвлений) и признак «не всё загружено».
 */
function collectBooks(seeds: Map<number, FranchiseKind>, seedInfo: Map<number, AnimeBook>) {
  const nodes = new Map<number, FranchiseNode>();
  const cards = new Map<number, BookLite>();
  const links: [number, number][] = [];
  let partial = false;
  const queue = [...seeds.keys()];
  while (queue.length && nodes.size < BOOK_LIMIT) {
    const id = queue.shift()!;
    if (nodes.has(id)) continue;
    const d = bookCached(id);
    if (d) {
      const rel = bookRel(d);
      nodes.set(id, bookNode(d, rel));
      cards.set(id, d);
      for (const r of rel) {
        links.push([id, r.id]);
        if (!nodes.has(r.id)) queue.push(r.id);
      }
      for (const r of d.relations) if (r.type === "ANIME") links.push([id, r.id]);
    } else {
      partial = true;
      fetchLater(`book:${id}`, () => bookDetails(id));
      const info = seedInfo.get(id);
      if (info) {
        cards.set(id, fromRelation(info));
        nodes.set(id, bookNode(cards.get(id)!, null));
      }
    }
  }
  return { items: franchiseBooks(seeds, nodes, BOOK_LIMIT), cards, links, partial };
}

/** Книга без аниме: корень — вверх по первоисточнику, предыстории и основной истории; экранизация — если найдётся по пути. */
async function bookStart(id: number): Promise<{ anime: number | null; root: number }> {
  let cur = await bookDetails(id);
  const seen = new Set([id]);
  for (let i = 0; i < 6; i++) {
    const anime = cur.relations.filter((r) => r.type === "ANIME" && (r.relationType === "ADAPTATION" || r.relationType === "SPIN_OFF" || r.relationType === "SIDE_STORY"))
      .sort((a, b) => Number(b.format === "TV") - Number(a.format === "TV") || (a.year ?? 9999) - (b.year ?? 9999))[0];
    if (anime) return { anime: anime.id, root: cur.id };
    const up = ["SOURCE", "PREQUEL", "PARENT"].map((t) => cur.relations.find((r) => r.type === "MANGA" && r.relationType === t && !seen.has(r.id))).find(Boolean);
    if (!up) break;
    seen.add(up.id);
    cur = await bookDetails(up.id);
  }
  return { anime: null, root: cur.id };
}

// ---------------------------------------------------------------- описание франшизы

const ABOUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { about_ru: { type: "string", description: "3–5 предложений по-русски: что это за мир, кто главный герой, с чего начинается история, жанр и настроение; без спойлеров дальше завязки" } },
  required: ["about_ru"],
};
const ABOUT = { schemaV: 1, promptV: 1, policy: "tier-first" as const, staleOk: true };
const aboutRuns = new Set<number>();

type AboutInput = { name: string; original: string | null; genres: string[]; bookRu: string | null; book: string | null; anime: string | null; forms: string };

const clean = (s: string | null | undefined) => (s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\(Source:[^)]*\)/gi, "").replace(/\[[^\]]*\]/g, "").trim();

/** Описание франшизы: составленное ИИ (в фоне, один раз), пока его нет — описание первоисточника или первого сезона. */
function aboutOf(root: number, input: AboutInput): FranchiseView["about"] {
  const inputHash = hashOf(input);
  const best = bestOutput<string>("franchise_about", `franchise:${root}`, { ...ABOUT, inputHash });
  if ((!best || !best.fresh) && !aboutRuns.has(root) && (input.bookRu || input.book || input.anime)) {
    aboutRuns.add(root);
    void produce<string>("franchise_about", `franchise:${root}`, {
      ...ABOUT, inputHash, schema: ABOUT_SCHEMA, maxTokens: 800,
      system: "Ты пишешь короткое описание франшизы для каталога аниме и книг. Только по данным ниже, ничего не выдумывай. Без спойлеров дальше завязки. Имена и названия — как в русском описании, если оно есть.",
      user: () => [
        `Франшиза: ${input.name}${input.original ? ` (${input.original})` : ""}`,
        input.genres.length ? `Жанры: ${input.genres.join(", ")}` : null,
        `Что выходило: ${input.forms}`,
        input.bookRu ? `Описание первоисточника (Shikimori):\n${input.bookRu}` : null,
        input.book && !input.bookRu ? `Описание первоисточника (AniList):\n${input.book}` : null,
        input.anime ? `Описание первого сезона аниме (AniList):\n${input.anime}` : null,
      ].filter(Boolean).join("\n\n"),
      shape: (a) => String((a as { about_ru?: string }).about_ru ?? "").trim(),
    }).catch((e) => console.warn(`[franchise] описание ${root}: ${String(e).slice(0, 200)}`)).finally(() => aboutRuns.delete(root));
  }
  if (best?.value) return { text: best.value, by: "ai" };
  if (input.bookRu) return { text: input.bookRu, by: "book" };
  if (input.anime) return { text: input.anime, by: "anime" };
  return input.book ? { text: input.book, by: "book" } : null;
}

// ---------------------------------------------------------------- кроссоверы

/** Кроссоверы: тайтлы, связанные с франшизой «персонажи там же», у которых есть и другие такие связи (Isekai Quartet). */
function crossoversOf(nodes: Map<number, FranchiseNode>, inFranchise: Set<number>) {
  const cand = new Set<number>();
  for (const id of inFranchise) {
    for (const r of nodes.get(id)?.rel ?? []) if ((r.type === "CHARACTER" || r.type === "OTHER") && !inFranchise.has(r.id)) cand.add(r.id);
  }
  const out: { media: AnilistDetails; others: MediaLite[] }[] = [];
  const missing: number[] = [];
  for (const id of [...cand].slice(0, 20)) {
    const d = getCached<AnilistDetails>(`media:v2:${id}`, true);
    if (!d) { missing.push(id); continue; }
    if (d.format === "MUSIC") continue;
    const others = d.relations.filter((r) => r.relationType === "CHARACTER" && !inFranchise.has(r.media.id)).map((r) => r.media);
    if (others.length) out.push({ media: d, others });
  }
  if (missing.length) enqueue(missing, "page", "open:0", 1);
  return out;
}

// ---------------------------------------------------------------- серии ↔ главы (TASKS 5.11)

/** Сопоставление по сюжету для страницы: серии сезона с главами и «досмотрел серию N — читай с главы M». */
function alignView(story: FranchiseItem[], entries: Map<number, EntryLite>) {
  const eds = new Map<number, EditionSummary[]>();
  const edOf = (book: number, edition: string) => {
    if (!eds.has(book)) eds.set(book, summarize(chapterRows(book)));
    return eds.get(book)!.find((e) => e.edition === edition) ?? null;
  };
  const perSeason = new Map<number, { ep: number; label: string }[]>();
  let readAfter: FranchiseView["readAfter"] = null;
  for (const it of story) {
    const rows = alignRows(it.media.id);
    if (!rows.length) continue;
    // Главы манги бывают только на вики (у провайдеров их нет) — тогда подпись по номеру
    const ed = edOf(rows[0].book_id, rows[0].edition) ?? { edition: rows[0].edition as EditionSummary["edition"], chapters: [], langs: [], missingRu: [] };
    const name = (key: string) => { const c = ed.chapters.find((x) => x.key === key); return c ? chapterName(c, ed.edition) : `Глава ${key}`; };
    perSeason.set(it.media.id, rows.map((r) => ({ ep: r.ep, label: r.from_key === r.to_key ? name(r.from_key) : `${name(r.from_key)} — ${name(r.to_key).toLowerCase()}` })));
    const e = entries.get(it.media.id);
    const upTo = e?.status === "completed" ? Infinity : e?.episodes ?? 0;
    const last = rows.filter((r) => r.ep <= upTo).at(-1);
    if (!last) continue;
    const at = ed.chapters.findIndex((c) => c.key === last.to_key);
    const next = at >= 0 ? ed.chapters[at + 1] : ed.chapters.find((c) => c.num !== null && last.to_num !== null && c.num > last.to_num);
    const t = next ? pickTranslation(next) : null;
    const book = getCached<BookLite>(`book:lite:${last.book_id}`, true);
    const label = next ? chapterName(next, ed.edition) : last.to_num !== null ? `Глава ${Math.floor(last.to_num) + 1}` : null;
    if (!label) continue;
    readAfter = {
      bookId: last.book_id, form: book?.kind === "novel" ? "novel" : "manga", anime: it.media.id, ep: last.ep, label,
      href: next && t ? `/manga/${last.book_id}/read?e=${ed.edition}&c=${encodeURIComponent(next.key)}&p=${t.provider}&r=${encodeURIComponent(t.cref)}` : `/manga/${last.book_id}`,
    };
  }
  return { perSeason, readAfter };
}

// ---------------------------------------------------------------- страница

/** Франшиза по любому её тайтлу — аниме или книге. */
export async function franchiseOf(userId: number, id: number): Promise<FranchiseView> {
  let start: { anime: number | null; root: number };
  if (bookCached(id) || getCached(`book:lite:${id}`, true)) start = await bookStart(id);
  else {
    try {
      await getDetails(id);
      start = { anime: id, root: id };
    } catch (e) {
      // Не аниме — значит, книга
      start = await bookStart(id).catch(() => { throw e; });
    }
  }

  const graph = start.anime ? await franchiseGraph(start.anime) : null;
  const anime: FranchiseItem[] = graph?.items ?? [];
  await withShikimori(anime.map((i) => i.media));
  const root = graph?.root ?? start.root;

  // Книги: от связанных с аниме или от корневой книги
  const seedInfo = new Map<number, AnimeBook>();
  const animeLinks = new Map<number, { type: string; id: number }[]>();
  let partial = graph?.partial ?? false;
  for (const a of anime.filter((i) => i.kind !== "recap").slice(0, BOOK_ANIME)) {
    const books = getCached<AnimeBook[]>(`book-meta:anime:${a.media.id}`, true);
    if (!books) { partial = true; fetchLater(`anime:${a.media.id}`, () => booksForAnime(a.media.id)); continue; }
    animeLinks.set(a.media.id, books.map((b) => ({ type: b.relationType, id: b.id })));
    for (const b of books) if (!seedInfo.has(b.id)) seedInfo.set(b.id, b);
  }
  const seeds = graph ? bookSeeds(anime, animeLinks) : new Map<number, FranchiseKind>([[root, "main"]]);
  const books = collectBooks(seeds, seedInfo);
  partial ||= books.partial;

  const entries = new Map(db.prepare<[number], EntryLite & { anilist_id: number }>(
    "SELECT anilist_id, status, episodes FROM list_entries WHERE user_id = ? AND deleted = 0").all(userId).map((e) => [e.anilist_id, e]));
  const reads = new Map(db.prepare<[number], { book_id: number; status: string; chapters: number }>(
    "SELECT book_id, status, chapters FROM read_entries WHERE user_id = ? AND deleted = 0").all(userId).map((e) => [e.book_id, e]));

  // Ответвления — группами по всем формам
  const links: [number, number][] = [...books.links];
  for (const [id, n] of graph?.nodes ?? []) for (const r of n.rel ?? []) links.push([id, r.id]);
  for (const [id, ls] of animeLinks) for (const l of ls) links.push([id, l.id]);
  const branches = franchiseBranches([...anime, ...books.items], links);

  const inFranchise = new Set([...anime, ...books.items].map((i) => i.media.id));
  const crossovers = graph ? crossoversOf(graph.nodes, inFranchise) : [];
  await withShikimori([...crossovers.map((c) => c.media), ...crossovers.flatMap((c) => c.others)]);

  const next = nextUp(anime, entries);
  // Состав — на тот сезон основной истории, где я сейчас: смотрю, следующий или последний досмотренный
  const main = anime.filter((i) => i.kind === "main");
  const castTitle = graph ? main.find((i) => entries.get(i.media.id)?.status === "watching")?.media.id
    ?? next ?? main.filter((i) => entries.has(i.media.id)).at(-1)?.media.id ?? root : null;

  const rootAnime = anime.find((i) => i.media.id === root)?.media as AnilistDetails | undefined;
  const mainBooks = books.items.filter((b) => b.kind === "main").map((b) => books.cards.get(b.media.id)!);
  // Первоисточник: ранобэ, если основная история есть в ранобэ и аниме не по манге; иначе первая книга
  const source = mainBooks.find((b) => b.kind === "novel" && rootAnime?.source !== "MANGA") ?? mainBooks[0];
  const sourceDetails = source ? bookCached(source.id) : undefined;
  const title = rootAnime?.title ?? books.cards.get(root)?.title ?? { romaji: null, english: null, native: null, ru: null };
  const count = (pred: (b: BookLite) => boolean) => books.items.filter((b) => pred(books.cards.get(b.media.id)!)).length;
  const about = aboutOf(root, {
    name: displayTitle(title), original: title.romaji ?? title.native,
    genres: rootAnime?.genres ?? sourceDetails?.genres ?? [],
    bookRu: sourceDetails?.descriptionRu ? clean(sourceDetails.descriptionRu) : null,
    book: sourceDetails?.description ? clean(sourceDetails.description) : null,
    anime: rootAnime?.description ? clean(rootAnime.description) : null,
    forms: [anime.length ? `аниме — ${anime.length}` : null, count((b) => b.kind !== "novel") ? `манга — ${count((b) => b.kind !== "novel")}` : null,
      count((b) => b.kind === "novel") ? `ранобэ — ${count((b) => b.kind === "novel")}` : null].filter(Boolean).join(", "),
  });

  const story = anime.filter((i) => i.kind === "main" || i.kind === "side");
  const adapt = adaptRanges(story.map((i) => i.media));
  const aligned = alignView(story, entries);
  return {
    root, castTitle, next, partial, progress: franchiseProgress(anime, entries),
    title, about, sourceBook: source?.id ?? null, readAfter: aligned.readAfter,
    banner: rootAnime?.bannerImage ?? sourceDetails?.bannerImage ?? null,
    items: anime.map((i) => {
      const e = entries.get(i.media.id);
      return { media: lite(i.media), kind: i.kind, entry: e ? { status: e.status, episodes: e.episodes } : null, plot: seasonArcs(userId, i.media.id), adapt: adapt.get(i.media.id) ?? null,
        align: aligned.perSeason.get(i.media.id) ?? null };
    }),
    books: books.items.map((i) => {
      const b = books.cards.get(i.media.id)!;
      const e = reads.get(b.id);
      const langs = summarize(chapterRows(b.id)).find((x) => x.edition === "main")?.langs ?? [];
      const ru = langs.find((l) => l.lang === "ru");
      return {
        book: b, kind: i.kind, entry: e ? { status: e.status, chapters: e.chapters } : null,
        ru: ru ? { count: ru.count, last: ru.last } : null,
        known: Math.max(b.chapters ?? 0, ...langs.map((l) => l.count)) || null,
      };
    }),
    branches,
    crossovers: crossovers.map((c) => ({ media: lite(c.media), others: c.others.map((o) => ({ id: o.id, title: o.title })) })),
  };
}
