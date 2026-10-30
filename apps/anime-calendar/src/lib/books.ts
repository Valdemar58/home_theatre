// Книги (манга, манхва, ранобе — заход 5): общие типы и чистая логика. Книга — тайтл AniList типа MANGA (id общий
// с аниме). Что вышло и где — главы от провайдеров (`ChapterRow`): сводка по номеру главы и языкам, пропуски перевода.

export type BookKind = "manga" | "manhwa" | "manhua" | "novel" | "oneshot";

export const KIND_LABELS: Record<BookKind, string> = {
  manga: "Манга", manhwa: "Манхва", manhua: "Маньхуа", novel: "Ранобэ", oneshot: "Ваншот",
};

/** Вид книги по формату и стране AniList (манхва — Корея, маньхуа — Китай). */
export function bookKind(format: string | null, country: string | null): BookKind {
  if (format === "NOVEL") return "novel";
  if (format === "ONE_SHOT") return "oneshot";
  if (country === "KR") return "manhwa";
  if (country === "CN" || country === "TW") return "manhua";
  return "manga";
}

/** Ридер ленты (манхва и маньхуа рисуются вертикальной полосой). */
export const isStrip = (kind: BookKind) => kind === "manhwa" || kind === "manhua";

/** Развороты: первая страница — обложка (одна), широкие — по одной, остальные — парами. */
export function spreadsOf(pages: { w?: number | null; h?: number | null }[], double: boolean): number[][] {
  if (!double) return pages.map((_, i) => [i]);
  const wide = (p: { w?: number | null; h?: number | null }) => Boolean(p.w && p.h && p.w > p.h);
  const out: number[][] = [];
  for (let i = 0; i < pages.length; i++) {
    if (i === 0 || wide(pages[i]) || i + 1 >= pages.length || wide(pages[i + 1])) out.push([i]);
    else { out.push([i, i + 1]); i++; }
  }
  return out;
}

export type BookTitle = { romaji: string | null; english: string | null; native: string | null; ru: string | null };

export type BookLite = {
  id: number;
  idMal: number | null;
  format: string | null;
  kind: BookKind;
  status: string | null;
  chapters: number | null;
  volumes: number | null;
  countryOfOrigin: string | null;
  isAdult: boolean;
  title: BookTitle;
  coverImage: { large: string | null; color: string | null };
  year: number | null;
  averageScore: number | null;
};

export type BookRelation = {
  relationType: string; id: number; type: "ANIME" | "MANGA"; format: string | null; status: string | null;
  title: string; cover: string | null; year: number | null;
};

export type BookDetails = BookLite & {
  synonyms: string[];
  description: string | null;
  /** Описание Shikimori (по-русски) */
  descriptionRu: string | null;
  bannerImage: string | null;
  genres: string[];
  authors: { name: string; role: string }[];
  relations: BookRelation[];
  links: { site: string; url: string }[];
};

/** Что известно о выходе в оригинале (трекеры): «32 тома, выходит», последняя глава. */
export type Origin = {
  status: string | null;
  /** Последняя известная глава оригинала (не меньше) */
  chapters: number | null;
  volumes: number | null;
  ended: boolean | null;
  /** Откуда: MangaUpdates, Syosetu, AniList */
  source: string;
  url: string | null;
};

// ---------------------------------------------------------------- главы

/**
 * Издание: у ранобэ веб-версия и книжная нумеруются по-разному (и в книжной главы считаются заново в каждом томе),
 * поэтому сводка строится отдельно на каждое. Манга — одно издание.
 */
export type Edition = "main" | "web" | "book";

export const EDITION_LABELS: Record<Edition, string> = { main: "Главы", web: "Веб-версия", book: "Книжная версия (по томам)" };

/** Глава у провайдера: один перевод (язык и команда). */
export type ChapterRow = {
  provider: string;
  /** Книга у провайдера */
  ref: string;
  edition: Edition;
  /** Язык: «ja» / «ko» / «zh» — оригинал, «en», «ru», «ai» — перевод ИИ */
  lang: string;
  team: string | null;
  vol: number | null;
  num: number | null;
  /** Номер как у провайдера («12.5», «Экстра») */
  numText: string;
  title: string | null;
  /** Время выхода, с */
  date: number | null;
  /** Глава у провайдера (для чтения) */
  cref: string;
};

export const ORIGINAL_LANGS = new Set(["ja", "ko", "zh", "zh-hk", "ja-ro", "ko-ro", "zh-ro"]);
export const langGroup = (lang: string) => (ORIGINAL_LANGS.has(lang) ? "orig" : lang);

export const LANG_LABELS: Record<string, string> = {
  orig: "Оригинал", ja: "Японский", ko: "Корейский", zh: "Китайский", en: "Английский", ru: "Русский", ai: "Перевод ИИ",
  uk: "Украинский", es: "Испанский", "es-la": "Испанский (ЛА)", "pt-br": "Португальский (Бр.)", fr: "Французский",
  de: "Немецкий", it: "Итальянский", id: "Индонезийский", vi: "Вьетнамский", pl: "Польский", tr: "Турецкий",
};

/** Ключ главы внутри издания: в книжном — «том-глава», иначе номер. */
export function chapterKey(edition: Edition, vol: number | null, num: number | null, numText: string): string {
  const n = num ?? numText;
  return edition === "book" ? `${vol ?? 0}-${n}` : String(n);
}

export type ChapterTranslation = { provider: string; lang: string; team: string | null; ref: string; cref: string; date: number | null };

export type ChapterSummary = {
  key: string;
  vol: number | null;
  num: number | null;
  numText: string;
  title: string | null;
  /** Переводы этой главы по языкам (оригинал — «orig») */
  langs: Record<string, ChapterTranslation[]>;
};

export type LangStat = { lang: string; count: number; last: string | null; teams: { team: string | null; provider: string; count: number }[] };

export type EditionSummary = {
  edition: Edition;
  chapters: ChapterSummary[];
  langs: LangStat[];
  /** Главы без русского перевода (есть в оригинале или на другом языке) — диапазонами для показа */
  missingRu: string[];
};

const byNum = (a: { vol: number | null; num: number | null; numText: string }, b: typeof a) =>
  (a.vol ?? 0) - (b.vol ?? 0) || (a.num ?? Infinity) - (b.num ?? Infinity) || a.numText.localeCompare(b.numText);

/** Сводка глав по изданиям: номер → переводы по языкам; статистика языков и команд; пропуски русского. */
export function summarize(rows: ChapterRow[]): EditionSummary[] {
  const editions = new Map<Edition, Map<string, ChapterSummary>>();
  for (const r of rows) {
    let chs = editions.get(r.edition);
    if (!chs) editions.set(r.edition, (chs = new Map()));
    const key = chapterKey(r.edition, r.vol, r.num, r.numText);
    let c = chs.get(key);
    if (!c) chs.set(key, (c = { key, vol: r.vol, num: r.num, numText: r.numText, title: null, langs: {} }));
    // Название — по-русски, если есть, иначе любое
    if (r.title && (!c.title || r.lang === "ru")) c.title = r.title;
    const g = langGroup(r.lang);
    (c.langs[g] ??= []).push({ provider: r.provider, lang: r.lang, team: r.team, ref: r.ref, cref: r.cref, date: r.date });
  }
  const order: Edition[] = ["main", "web", "book"];
  return order.filter((e) => editions.has(e)).map((edition) => {
    const chapters = [...editions.get(edition)!.values()].sort(byNum);
    const stats = new Map<string, LangStat>();
    for (const c of chapters) {
      for (const [lang, tr] of Object.entries(c.langs)) {
        let s = stats.get(lang);
        if (!s) stats.set(lang, (s = { lang, count: 0, last: null, teams: [] }));
        s.count++;
        s.last = c.key;
        for (const t of tr) {
          const team = s.teams.find((x) => x.team === t.team && x.provider === t.provider);
          if (team) team.count++;
          else s.teams.push({ team: t.team, provider: t.provider, count: 1 });
        }
      }
    }
    const langs = [...stats.values()].sort((a, b) => langRank(a.lang) - langRank(b.lang) || b.count - a.count);
    for (const s of langs) s.teams.sort((a, b) => b.count - a.count);
    // Без русского: глава есть где-то ещё, а русского нет (ИИ-перевод не считается переводом)
    const missing = chapters.filter((c) => !c.langs.ru && Object.keys(c.langs).some((l) => l !== "ai"));
    return { edition, chapters, langs, missingRu: keyRanges(missing.map((c) => c.key), chapters.map((c) => c.key)) };
  });
}

const LANG_ORDER = ["orig", "ru", "en", "ai"];
const langRank = (l: string) => (LANG_ORDER.includes(l) ? LANG_ORDER.indexOf(l) : LANG_ORDER.length);

/**
 * Подряд идущие ключи (по порядку всех глав издания) — диапазонами: ["1–3", "7", "10–12"]. Дырки в нумерации
 * (нет главы 4 нигде) диапазон не рвут — рвёт только глава, у которой русский есть.
 */
export function keyRanges(keys: string[], all: string[]): string[] {
  const want = new Set(keys);
  const out: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const k of all) {
    if (want.has(k)) {
      start ??= k;
      prev = k;
    } else if (start !== null) {
      out.push(start === prev ? start : `${start}–${prev}`);
      start = prev = null;
    }
  }
  if (start !== null) out.push(start === prev ? start : `${start}–${prev}`);
  return out;
}

/** Номер главы из текста провайдера: «12», «12.5», «Глава 7» → число или null («Экстра»). */
export function parseNum(s: string | number | null | undefined): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const m = /(\d+(?:[.,]\d+)?)/.exec(s ?? "");
  return m ? Number(m[1].replace(",", ".")) : null;
}

// ---------------------------------------------------------------- страница книги

export type BookLinkView = { provider: string; name: string; ref: string; title: string | null; edition: Edition; how: string; url: string | null; chaptersAt: number | null };

export type BookPage = {
  book: BookDetails;
  origin: Origin;
  links: BookLinkView[];
  editions: EditionSummary[];
  /** Идёт поиск у провайдеров или обновление оглавлений */
  updating: boolean;
};

export type BookHit = { provider: string; ref: string; title: string; titles: string[]; year: number | null; cover: string | null; url: string; edition: Edition; note?: string | null; score: number };

export type ReadPosView = { chapter: string; edition: Edition; provider: string; cref: string; pos: number; done: boolean; updatedAt: number };
export type BookProgress = {
  positions: ReadPosView[];
  pref: { provider?: string; team?: string | null; lang?: string; edition?: Edition };
  entry: { status: string; chapters: number; score: number } | null;
};

export type ChapterContentView =
  | { kind: "text"; blocks: Block[] }
  | { kind: "pages"; pages: { url: string; w?: number | null; h?: number | null }[] }
  | { kind: "external"; url: string };

// ---------------------------------------------------------------- сопоставление

/** Название для сравнения: без регистра, диакритики, пунктуации и пробелов. */
export function normTitle(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Все названия книги (для поиска у провайдеров и сравнения). */
export function bookTitles(b: Pick<BookDetails, "title" | "synonyms">): string[] {
  return [b.title.romaji, b.title.english, b.title.native, b.title.ru, ...b.synonyms].filter((x): x is string => Boolean(x?.trim()));
}

/**
 * Насколько книга провайдера похожа на нашу: 1 — точное совпадение одного из названий, 0,6 — одно начинается с
 * другого (подзаголовки), 0 — нет. Год дальше чем на 1 — не она.
 */
export function titleMatch(ours: string[], theirs: string[], years?: { ours: number | null; theirs: number | null }): number {
  if (years?.ours && years.theirs && Math.abs(years.ours - years.theirs) > 1) return 0;
  const a = ours.map(normTitle).filter((x) => x.length > 1);
  const b = theirs.map(normTitle).filter((x) => x.length > 1);
  if (a.some((x) => b.includes(x))) return 1;
  if (a.some((x) => b.some((y) => (x.length > 6 && y.startsWith(x)) || (y.length > 6 && x.startsWith(y))))) return 0.6;
  return 0;
}

// ---------------------------------------------------------------- текст главы

/** Текст главы для ридера: абзацы и картинки (иллюстрации ранобэ). */
export type Block = { t: "p"; text: string } | { t: "img"; url: string } | { t: "hr" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…" };
export const decodeEntities = (s: string) => s
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);

/** HTML главы (Lib, Syosetu) → абзацы: <p>/<br> — границы, теги убираются, картинки — отдельными блоками. */
export function htmlToBlocks(html: string, resolve: (src: string) => string = (s) => s): Block[] {
  const out: Block[] = [];
  const parts = html
    .replace(/\r/g, "")
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<img[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src: string) => `\n\u0000img:${src}\n`)
    .replace(/<hr[^>]*>/gi, "\n\u0000hr\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n");
  for (const raw of parts) {
    if (raw.startsWith("\u0000img:")) { out.push({ t: "img", url: resolve(raw.slice(5)) }); continue; }
    if (raw === "\u0000hr") { out.push({ t: "hr" }); continue; }
    const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: "p", text });
  }
  return out;
}

type PmNode = { type: string; text?: string; content?: PmNode[]; attrs?: Record<string, unknown> };

/** Документ ProseMirror (Lib: описания и часть глав) → абзацы. */
export function docToBlocks(doc: PmNode, resolve: (src: string) => string = (s) => s): Block[] {
  const out: Block[] = [];
  const text = (n: PmNode): string => n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(text).join("");
  const walk = (n: PmNode) => {
    if (n.type === "paragraph" || n.type === "heading") {
      for (const line of text(n).split("\n")) if (line.trim()) out.push({ t: "p", text: line.trim() });
    } else if (n.type === "image") {
      const imgs = (n.attrs?.images as { image?: string }[] | undefined) ?? [];
      const src = (n.attrs?.src as string | undefined) ?? imgs[0]?.image;
      if (src) out.push({ t: "img", url: resolve(src) });
    } else if (n.type === "horizontalRule") out.push({ t: "hr" });
    else (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

/** Блоки → простой текст (описание, вход перевода). */
export const blocksText = (b: Block[]) => b.filter((x): x is Extract<Block, { t: "p" }> => x.t === "p").map((x) => x.text).join("\n\n");

// ---------------------------------------------------------------- чтение

/** Статусы списка чтения (коды — как у аниме, подписи — свои). */
export const READ_LABELS: Record<string, string> = {
  watching: "Читаю", planned: "В планах", completed: "Прочитано", on_hold: "Отложено", dropped: "Брошено", rewatching: "Перечитываю",
};

/** Все переводы главы одним списком: русский, английский, оригинал, ИИ, прочие. */
export function translationsOf(c: ChapterSummary): ChapterTranslation[] {
  return Object.entries(c.langs).sort(([a], [b]) => langRank(a) - langRank(b)).flatMap(([, t]) => t);
}

/**
 * Перевод главы для чтения: выбранный у книги (тот же провайдер и команда), иначе тот же провайдер, иначе русский,
 * английский, оригинал.
 */
export function pickTranslation(c: ChapterSummary, pref: { provider?: string; team?: string | null } = {}): ChapterTranslation | null {
  const all = translationsOf(c);
  return all.find((t) => t.provider === pref.provider && t.team === pref.team)
    ?? all.find((t) => t.provider === pref.provider)
    ?? c.langs.ru?.[0] ?? c.langs.en?.[0] ?? c.langs.orig?.[0] ?? all[0] ?? null;
}

/** Подпись перевода в переключателе: «Русский · RanobeLib · Команда». */
export function translationLabel(t: ChapterTranslation, providerName: (id: string) => string = (x) => x): string {
  return [LANG_LABELS[langGroup(t.lang)] ?? t.lang, providerName(t.provider), t.team].filter(Boolean).join(" · ");
}

/** Номер главы для людей: «Том 2, глава 5» в книжном издании, иначе «Глава 12». */
export const chapterName = (c: Pick<ChapterSummary, "vol" | "numText">, edition: Edition) =>
  edition === "book" && c.vol !== null ? `Том ${c.vol}, гл. ${c.numText}` : `Глава ${c.numText}`;
