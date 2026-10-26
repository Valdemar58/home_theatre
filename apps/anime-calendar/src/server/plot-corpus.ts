import "server-only";
import { episodeCategory, infoboxInfo, parseDate, plotSections, wikiMatchScore } from "@/lib/fandom-episodes";
import { fuzzyIso } from "@/lib/plot";
import type { CorpusProgress, CorpusState } from "@/lib/types";
import { alignToTimeline, decodeEntities, jstDate, parseEpisodeTables, pickSeason, type Dated, type SeasonWindow, type WikiEpisode } from "@/lib/wiki-episodes";
import { getDetails, type AnilistDetails } from "./anilist";
import { cached } from "./cache";
import { corpusOf, deepestByEpisode, putMeta, putTexts, retractSource, type Depth, type Found } from "./corpus-store";
import { db } from "./db";
import { fetchWithRetry, RateLimiter } from "./http";
import { episodesOf } from "./plot";
import { buildSeasonPlot } from "./plot-deep";
import { latestTask, registerHandler } from "./tasks";

// Корпус сюжета: тексты о каждой серии из всех источников (docs/plot-analysis-design.md, TASKS 7.12).
// Источник правды для пересказов и будущего разбора серий; строки не удаляются (изменился текст — новая строка).
// Собирается по кнопке (задача «corpus»): TMDB/Kitsu → Википедия EN → Fandom → dアニメストア.
// Серии выбираются по датам выхода тайтла AniList — так не важно, как источник режет сериал на сезоны.

const UA = "home-theater/1.0 (personal media server)";
// Вежливо: по запросу за раз на хост; Wikidata через VPN быстро отвечает 429 — реже
const limits = {
  wikidata: new RateLimiter(1500),
  wikipedia: new RateLimiter(400),
  fandom: new RateLimiter(700),
  danime: new RateLimiter(500),
  mal: new RateLimiter(1000),
};

async function getJson<T>(url: string, limiter: RateLimiter, headers: Record<string, string> = {}): Promise<T | null> {
  const res = await fetchWithRetry(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } }, limiter, { timeoutMs: 30_000 });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- прогресс


const progress = new Map<number, CorpusProgress>();
export const corpusProgress = (anilistId: number) => progress.get(anilistId) ?? null;

type Run = {
  d: AnilistDetails;
  window: SeasonWindow;
  count: number | null;
  signal: AbortSignal;
  p: CorpusProgress;
  /** Шаг сделан (запрос к источнику) — для полосы прогресса и оценки «осталось» */
  tick: () => void;
  /** Нашлась работа на k шагов (серии Fandom, dアニメ) — общий итог растёт */
  grow: (k: number) => void;
};

const touch = (p: CorpusProgress, patch: Partial<CorpusProgress> = {}) => Object.assign(p, patch, { updatedAt: Date.now() });

// ---------------------------------------------------------------- Wikidata

type WdEntity = {
  sitelinks?: Record<string, { title: string }>;
  claims: Record<string, { mainsnak: { datavalue?: { value: unknown } } }[]>;
};
/** pages — статьи Википедии EN по убыванию точности: сезон, сериал, первоисточник (манга/ранобэ со списком серий) */
type WdInfo = { pages: string[]; fandom: string | null; start: string | null };

const claim = <T>(e: WdEntity, p: string) => (e.claims[p] ?? []).map((c) => c.mainsnak.datavalue?.value as T).filter(Boolean);

async function wdEntity(q: string): Promise<WdEntity | null> {
  const d = await getJson<{ entities: Record<string, WdEntity> }>(
    `https://www.wikidata.org/w/api.php?format=json&action=wbgetentities&props=sitelinks|claims&sitefilter=enwiki&ids=${q}`, limits.wikidata);
  return d ? Object.values(d.entities)[0] ?? null : null;
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400_000;

/**
 * Элемент Wikidata тайтла: по AniList id (P8729), иначе по MAL id (P4086). У сезонов — своя статья
 * Википедии и вики Fandom (P6262); у сериала-родителя (P179) — общая статья со списком серий; у многих
 * экранизаций своей статьи нет — серии в статье первоисточника (P144 «основано на»).
 * В данных Wikidata бывают чужие id — элемент проверяем по дате начала.
 */
function wikidataOf(d: AnilistDetails): Promise<WdInfo | null> {
  return cached(`corpus-wd:v2:${d.id}`, 30 * 86400, async () => {
    const start = fuzzyIso(d.startDate);
    const search = async (prop: string, val: number) => {
      const r = await getJson<{ query?: { search?: { title: string }[] } }>(
        `https://www.wikidata.org/w/api.php?format=json&action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:${prop}=${val}`)}`, limits.wikidata);
      return (r?.query?.search ?? []).map((x) => x.title);
    };
    let ids = await search("P8729", d.id);
    if (!ids.length && d.idMal) ids = await search("P4086", d.idMal);
    for (const q of ids.slice(0, 3)) {
      const e = await wdEntity(q);
      if (!e) continue;
      const wdStart = claim<{ time: string }>(e, "P580")[0]?.time.slice(1, 11) ?? null;
      if (start && wdStart && days(start, wdStart) > 10) continue;
      const parent = claim<{ id: string }>(e, "P179")[0]?.id;
      const p = parent ? await wdEntity(parent) : null;
      const fandom = claim<string>(e, "P6262")[0] ?? (p ? claim<string>(p, "P6262")[0] : undefined) ?? null;
      const pages = [e.sitelinks?.enwiki?.title, p?.sitelinks?.enwiki?.title].filter((x): x is string => Boolean(x));
      if (!pages.length) {
        const based = claim<{ id: string }>(e, "P144")[0]?.id ?? (p ? claim<{ id: string }>(p, "P144")[0]?.id : undefined);
        const b = based ? await wdEntity(based) : null;
        if (b?.sitelinks?.enwiki) pages.push(b.sitelinks.enwiki.title);
      }
      return { pages, fandom, start: wdStart };
    }
    return null;
  });
}

// ---------------------------------------------------------------- Википедия EN

const WP = "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&";

type WpParse = { parse?: { title: string; text: string; links?: { title: string; exists?: boolean }[] } };

async function wikipediaPage(title: string) {
  const r = await getJson<WpParse>(`${WP}action=parse&prop=text|links&redirects=1&page=${encodeURIComponent(title)}`, limits.wikipedia);
  return r?.parse ?? null;
}

async function wikipediaSearch(q: string): Promise<string[]> {
  const r = await getJson<{ query?: { search?: { title: string }[] } }>(`${WP}action=query&list=search&srlimit=3&srsearch=${encodeURIComponent(q)}`, limits.wikipedia);
  return (r?.query?.search ?? []).map((x) => x.title);
}

/** Пересказы серий с Википедии: статья сезона и общая статья со списком серий, ссылки на сезоны — до 6 страниц. */
async function wikipediaEpisodes(run: Run, wd: WdInfo | null): Promise<Found[]> {
  const seen = new Set<string>();
  const rows: WikiEpisode[] = [];
  let eps = await wikipediaCrawl(run, [...(wd?.pages ?? [])], seen, rows);
  // По Wikidata не нашлось — поиск по названию (английскому, потом ромадзи)
  for (const n of [run.d.title.english, run.d.title.romaji]) {
    if (eps.length || !n) continue;
    const found = [
      ...(await wikipediaSearch(`List of ${n} episodes`)).filter((t) => /episodes/i.test(t)).slice(0, 1),
      ...(await wikipediaSearch(n)).slice(0, 2),
    ];
    run.tick();
    eps = await wikipediaCrawl(run, found, seen, rows);
  }
  // И серии без пересказа: их даты и японские названия — эталон для сверки остальных источников (текст пустой — не записывается)
  return eps
    .map((r) => ({ ep: r.ep, title: r.title, titleJa: r.titleJa ?? null, text: r.text, aired: r.date, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.table.split("#")[0].replace(/ /g, "_"))}` }));
}

/** Обойти страницы (и ссылки на списки серий и сезоны с них), до 8 страниц на тайтл; серии тайтла — по датам. */
async function wikipediaCrawl(run: Run, queue: string[], seen: Set<string>, rows: WikiEpisode[]) {
  while (queue.length && seen.size < 8) {
    run.signal.throwIfAborted();
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    const page = await wikipediaPage(t).catch(() => null);
    run.tick();
    if (!page) continue;
    rows.push(...parseEpisodeTables(page.text, page.title));
    for (const l of page.links ?? []) {
      if (l.exists !== false && /^List of .* episodes|\bseason \d|\(season \d/i.test(l.title) && !seen.has(l.title)) queue.push(l.title);
    }
  }
  return pickSeason(rows, run.window);
}

// ---------------------------------------------------------------- Fandom

const slugWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

type FandomHit = { name: string; description: string | null; url: string };

/**
 * Вики Fandom, которые могут быть про тайтл, по убыванию уверенности: из Wikidata, из поиска Fandom
 * (вики должна называться похоже — wikiMatchScore), догадка по названию. Какая из них верная, решают даты серий.
 */
async function fandomWikis(run: Run, wd: WdInfo | null): Promise<string[]> {
  const out: string[] = [];
  if (wd?.fandom) out.push(wd.fandom.split(":")[0]);
  const names = [run.d.title.english, run.d.title.romaji].filter((x): x is string => Boolean(x));
  for (const n of names) {
    run.signal.throwIfAborted();
    const r = await getJson<{ results?: FandomHit[] }>(
      `https://services.fandom.com/unified-search/community-search?lang=en&limit=10&query=${encodeURIComponent(n)}`, limits.fandom).catch(() => null);
    run.tick();
    for (const h of r?.results ?? []) {
      const slug = h.url.match(/^https?:\/\/([a-z0-9-]+)\.fandom\.com\/?$/i)?.[1];
      if (slug && wikiMatchScore(names, h) >= 0.6 && !out.includes(slug)) out.push(slug);
    }
  }
  if (out.length) return out.slice(0, 3);
  // Поиск ничего не дал — догадка по названию
  const cands = new Set<string>();
  for (const n of names) {
    const w = slugWords(n);
    for (const k of [1, 2, 3]) if (w.length >= k) cands.add(w.slice(0, k).join("")).add(w.slice(0, k).join("-"));
  }
  const key = slugWords(names[0] ?? "").join("").slice(0, 5);
  for (const slug of [...cands].slice(0, 8)) {
    run.signal.throwIfAborted();
    const info = await getJson<{ query?: { general?: { sitename?: string } } }>(
      `https://${slug}.fandom.com/api.php?format=json&action=query&meta=siteinfo`, limits.fandom).catch(() => null);
    const site = info?.query?.general?.sitename?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (site && key && site.includes(key)) return [slug];
  }
  return [];
}

type FandomQuery = {
  query?: {
    allcategories?: { category: string }[];
    categorymembers?: { title: string }[];
    pages?: { title: string; revisions?: { slots: { main: { content: string } } }[] }[];
  };
  continue?: Record<string, string>;
};

async function fandomEpisodes(run: Run, wd: WdInfo | null): Promise<Found[]> {
  for (const slug of await fandomWikis(run, wd)) {
    const found = await fandomWikiEpisodes(run, slug).catch(() => [] as Found[]);
    if (found.length) return found;
  }
  return [];
}

/** Серии тайтла в одной вики: категория серий → даты из инфобоксов → пересказы выбранных серий. */
async function fandomWikiEpisodes(run: Run, slug: string): Promise<Found[]> {
  const api = `https://${slug}.fandom.com/api.php?format=json&formatversion=2&`;
  const cats = await getJson<FandomQuery>(`${api}action=query&list=allcategories&aclimit=500&acmin=3`, limits.fandom);
  const cat = episodeCategory((cats?.query?.allcategories ?? []).map((c) => c.category));
  if (!cat) return [];
  const titles: string[] = [];
  let cont = "";
  do {
    const r = await getJson<FandomQuery>(`${api}action=query&list=categorymembers&cmnamespace=0&cmlimit=500&cmtitle=${encodeURIComponent(`Category:${cat}`)}${cont}`, limits.fandom);
    titles.push(...(r?.query?.categorymembers ?? []).map((m) => m.title));
    cont = r?.continue?.cmcontinue ? `&cmcontinue=${encodeURIComponent(r.continue.cmcontinue)}` : "";
  } while (cont && titles.length < 2000);
  // Даты и сезоны — из инфобоксов, по 50 страниц за запрос
  const rows: WikiEpisode[] = [];
  for (let i = 0; i < titles.length; i += 50) {
    run.signal.throwIfAborted();
    run.tick();
    const r = await getJson<FandomQuery>(`${api}action=query&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(titles.slice(i, i + 50).join("|"))}`, limits.fandom);
    for (const p of r?.query?.pages ?? []) {
      const info = infoboxInfo(p.revisions?.[0]?.slots.main.content ?? "");
      if (info.date) rows.push({ table: info.season ?? "", overall: info.number, inSeason: null, title: p.title, titleJa: info.titleJa, date: info.date, text: "" });
    }
  }
  const eps = pickSeason(rows, run.window);
  run.grow(eps.length);
  const out: Found[] = [];
  for (const e of eps) {
    run.signal.throwIfAborted();
    const r = await getJson<{ parse?: { text: string } }>(`${api}action=parse&prop=text&page=${encodeURIComponent(e.title!)}`, limits.fandom).catch(() => null);
    const { synopsis, plot } = plotSections(r?.parse?.text ?? "");
    const text = plot ?? synopsis;
    if (text) out.push({ ep: e.ep, title: e.title, titleJa: e.titleJa ?? null, text, aired: e.date, url: `https://${slug}.fandom.com/wiki/${encodeURIComponent(e.title!.replace(/ /g, "_"))}` });
    run.tick();
  }
  return out;
}

// ---------------------------------------------------------------- MyAnimeList (Tenrai, запасной — Jikan-Edge)

// Jikan закрыт 2026-10-01; оба сервиса — неофициальный разбор публичных страниц MAL, без ключа.
// У MAL у каждой серии есть дата и японское название (эталон для сверки) и часто — описание
const TENRAI = "https://api.tenrai.org/v1";
const JIKAN_EDGE = "https://jikan.lucashdo.com/v1";

type TenraiEpisode = { mal_id: number; title: string | null; title_japanese: string | null; aired: string | null; synopsis?: string | null; recap?: boolean; filler?: boolean };
type EdgeEpisode = { number: number; title: string | null; titleJapanese: string | null; aired: string | null; recap?: boolean; filler?: boolean };

async function malEpisodes(run: Run): Promise<Found[]> {
  const mal = run.d.idMal;
  if (!mal) return [];
  const url = (ep: number) => `https://myanimelist.net/anime/${mal}/x/episode/${ep}`;
  try {
    const eps: TenraiEpisode[] = [];
    for (let page = 1; page <= 10; page++) {
      run.signal.throwIfAborted();
      const r = await getJson<{ data?: TenraiEpisode[]; pagination?: { has_next_page?: boolean } }>(`${TENRAI}/anime/${mal}/episodes?page=${page}`, limits.mal);
      run.tick();
      eps.push(...(r?.data ?? []));
      if (!r?.pagination?.has_next_page) break;
    }
    // Рекапы не берём: в нумерации тайтла AniList их обычно нет
    return eps.filter((e) => !e.recap).map((e) => {
      const text = decodeEntities((e.synopsis ?? "").replace(/\s*\(Source:[^)]*\)\s*$/i, "").trim());
      return {
        ep: e.mal_id, title: e.title, titleJa: e.title_japanese, aired: e.aired?.slice(0, 10) ?? null, text, url: url(e.mal_id),
        depth: text.length >= 400 ? ("full" as const) : ("teaser" as const), filler: Boolean(e.filler),
      };
    });
  } catch (e) {
    if (run.signal.aborted) throw e;
    // Tenrai не ответил — даты и названия из Jikan-Edge (описаний там нет: серии только для сверки)
    const r = await getJson<{ data?: EdgeEpisode[] }>(`${JIKAN_EDGE}/anime/${mal}/episodes`, limits.mal);
    run.tick();
    return (r?.data ?? []).filter((x) => !x.recap)
      .map((x) => ({ ep: x.number, title: x.title, titleJa: x.titleJapanese, aired: x.aired ? parseDate(x.aired) : null, text: "", url: url(x.number), filler: Boolean(x.filler) }));
  }
}

// ---------------------------------------------------------------- dアニメストア (японские анонсы и названия серий)

const DA = "https://animestore.docomo.ne.jp/animestore/rest/";
const normJa = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

async function danimeEpisodes(run: Run): Promise<Found[]> {
  const native = run.d.title.native;
  if (!native) return [];
  const r = await getJson<{ data?: { workList?: { workId: string; workInfo: { workTitle: string } }[] } }>(
    `${DA}WS000105?length=20&mainKeyVisualSize=1&vodTypeList=svod_tvod&searchKey=${encodeURIComponent(native)}`, limits.danime);
  const work = (r?.data?.workList ?? []).find((w) => normJa(w.workInfo.workTitle) === normJa(native));
  if (!work) return [];
  run.grow(run.count ?? 12);
  type Part = { partDispNumber: string | null; partTitle: string | null; partExp: string | null; nextPartId: string | null };
  const out: Found[] = [];
  let partId: string | null = `${work.workId}001`;
  for (let i = 0; partId && i < (run.count ?? 60) + 5; i++) {
    run.signal.throwIfAborted();
    const p: Part | null = await getJson<Part>(`${DA}WS030101?partId=${partId}`, limits.danime);
    run.tick();
    if (!p) break;
    const n = p.partDispNumber?.normalize("NFKC").match(/^第(\d+)話$/)?.[1];
    if (n && p.partExp) out.push({ ep: Number(n), title: p.partTitle ? decodeEntities(p.partTitle) : null, titleJa: p.partTitle ? decodeEntities(p.partTitle) : null, text: decodeEntities(p.partExp), url: `https://animestore.docomo.ne.jp/animestore/ci_pc?workId=${work.workId}` });
    partId = p.nextPartId || null;
  }
  // Своя нумерация (спецвыпуски среди серий) — сопоставить нельзя
  if (run.count !== null && out.length && Math.max(...out.map((o) => o.ep)) > run.count) return out.filter((o) => o.ep <= run.count!);
  return out;
}

// ---------------------------------------------------------------- сбор

type Source = {
  key: string; label: string; lang: string; depth: Depth; license: string | null;
  /** Запросов, которые будут всегда; по сериям — добавляются, когда источник нашёл тайтл (run.grow) */
  units: number;
  fetch: (run: Run, wd: WdInfo | null) => Promise<Found[]>;
};

// Википедия первой: её таблица серий полная и с датами — эталон, к которому привязываются TMDB и Fandom
const SOURCES: Source[] = [
  { key: "wiki-en", label: "Википедия", lang: "en", depth: "full", license: "CC BY-SA 4.0", units: 3, fetch: wikipediaEpisodes },
  // Второй — MAL: если Википедия сезон не покрыла, эталон дат и японских названий — он
  { key: "mal", label: "MyAnimeList", lang: "en", depth: "teaser", license: "© MyAnimeList", units: 1, fetch: (run) => malEpisodes(run) },
  {
    key: "tmdb", label: "TMDB / Kitsu", lang: "", depth: "teaser", license: null, units: 1,
    fetch: async (run) => (await episodesOf(run.d)).episodes.filter((e) => e.overview)
      .map((e) => ({ ep: e.number, title: e.title, text: e.overview!, url: null, lang: e.lang ?? "en", aired: e.airDate })),
  },
  { key: "fandom", label: "Fandom", lang: "en", depth: "full", license: "CC BY-SA 3.0", units: 3, fetch: fandomEpisodes },
  { key: "danime", label: "dアニメストア", lang: "ja", depth: "teaser", license: "© правообладатель", units: 1, fetch: (run) => danimeEpisodes(run) },
];

// Типичная длительность источника, с — уточняется по каждому сбору (скользящее среднее): у большинства
// тайтлов нет вики Fandom и работы в dアニメ, у популярных — по секунде на серию; заранее не угадать
const typicalSec: Record<string, number> = { tmdb: 3, "wiki-en": 8, mal: 3, fandom: 10, danime: 8 };

type Timeline = { dates: Dated[]; tol: number; from: string };

/**
 * Номера серий источника — по эталонной шкале дат (alignToTimeline). TMDB, у которого с эталоном совпало
 * меньше половины серий, — это другой сезон: его тексты не берём. Без эталона — номера как есть.
 */
function realign(key: string, found: Found[], tl: Timeline | null, window: SeasonWindow): { found: Found[]; note?: string } {
  const dated = found.filter((f) => f.aired || f.titleJa);
  if (!tl) {
    if (key !== "tmdb" || !window.start || !dated.length) return { found };
    // Эталона нет — TMDB хотя бы должен попадать в период показа
    const from = Date.parse(window.start) - 7 * 86400_000;
    const to = window.end ? Date.parse(window.end) + 7 * 86400_000 : Date.now() + 86400_000;
    const inside = dated.filter((f) => f.aired && Date.parse(f.aired) >= from && Date.parse(f.aired) <= to).length;
    return inside * 2 >= dated.length ? { found } : { found: [], note: "TMDB: серии другого сезона" };
  }
  const aligned = alignToTimeline(dated.map((f) => ({ ...f, date: f.aired ?? null })), tl.dates, tl.tol)
    .map(({ date: _date, ...f }) => f);
  if (key === "tmdb" && aligned.length * 2 < dated.length) return { found: [], note: `TMDB: серии другого сезона (сверка с ${tl.from})` };
  return { found: aligned };
}

/** Собрать корпус тайтла: все источники по очереди; ошибка источника не останавливает сбор. */
export async function collectCorpus(anilistId: number, signal: AbortSignal): Promise<CorpusProgress> {
  const d = structuredClone(await getDetails(anilistId));
  const count = d.episodes ?? (d.nextAiringEpisode ? d.nextAiringEpisode.episode - 1 : null);
  const p: CorpusProgress = {
    anilistId, step: "", done: 0, total: SOURCES.reduce((a, s) => a + s.units, 0),
    startedAt: Date.now(), updatedAt: Date.now(), finished: false, found: {}, errors: [], etaSec: null,
  };
  progress.set(anilistId, p);
  // Шаги источника: обязательные заранее, по сериям — когда нашлись; сделал больше — итог растёт, меньше — остаток засчитывается в конце
  let base = 0;
  let planned = 0;
  let used = 0;
  let at = 0;
  let current = 0;
  // Осталось: текущий источник (по скорости, если известно число серий, иначе по типичному времени) + типичное у следующих
  const eta = () => {
    const s = SOURCES[current];
    const spent = (Date.now() - at) / 1000;
    const here = planned > s.units && used > 0 ? (planned - used) * (spent / used) : Math.max(1, typicalSec[s.key] - spent);
    return Math.round(here + SOURCES.slice(current + 1).reduce((a, x) => a + typicalSec[x.key], 0));
  };
  const tick = () => {
    used++;
    if (used > planned) grow(1);
    touch(p, { done: base + used, etaSec: eta() });
  };
  const grow = (k: number) => {
    planned += k;
    touch(p, { total: p.total + k, etaSec: eta() });
  };
  const run: Run = { d, window: { start: fuzzyIso(d.startDate), end: d.status === "FINISHED" ? fuzzyIso(d.endDate) : null, count }, count, signal, p, tick, grow };
  let wd: WdInfo | null = null;
  // Эталон дат: Википедия, покрывшая сезон, → TMDB в период показа → расписание AniList (у него бывает другой канал — допуск 3 дня)
  let tl: Timeline | null = null;
  const covers = (f: Found[]) => f.filter((x) => x.aired).length >= Math.max(1, Math.ceil((count ?? f.length) * 0.8));
  const schedule: Dated[] = d.schedule.map((a) => ({ ep: a.episode, date: jstDate(a.airingAt) }));
  for (const [i, s] of SOURCES.entries()) {
    signal.throwIfAborted();
    base = p.done;
    planned = s.units;
    used = 0;
    at = Date.now();
    current = i;
    touch(p, { step: s.label, etaSec: eta() });
    try {
      if (s.key === "wiki-en") wd = await wikidataOf(d).catch(() => null);
      let found = await s.fetch(run, wd);
      if (s.key === "tmdb" || s.key === "fandom" || ((s.key === "danime" || s.key === "mal") && tl)) {
        const r = realign(s.key, found, tl ?? (s.key === "fandom" && schedule.length ? { dates: schedule, tol: 3, from: "AniList" } : null), run.window);
        found = r.found;
        if (r.note) {
          p.errors.push(r.note);
          retractSource(anilistId, s.key);
          db.prepare("DELETE FROM episode_meta WHERE anilist_id = ? AND source = ?").run(anilistId, s.key);
        }
      }
      if (!tl && (s.key === "wiki-en" || s.key === "mal" || s.key === "tmdb") && found.length && covers(found)) {
        tl = { dates: found.filter((f) => f.aired).map((f) => ({ ep: f.ep, date: f.aired!, titleJa: f.titleJa ?? null })), tol: 1, from: s.label };
      }
      putTexts(anilistId, s.key, s.lang, s.depth, s.license, found);
      putMeta(anilistId, s.key, found);
      p.found[s.key] = new Set(found.filter((f) => f.text.trim()).map((f) => f.ep)).size;
    } catch (e) {
      if (signal.aborted) throw e;
      p.errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    typicalSec[s.key] = Math.round(0.7 * typicalSec[s.key] + 0.3 * ((Date.now() - at) / 1000));
    touch(p, { done: base + Math.max(planned, used) });
  }
  return p;
}

// Порция пересказа сезона умной моделью — около 40 с
const DEEP_SEC = 40;

/** Пересказ сезона по собранному корпусу — следом за сбором, в том же статусе. */
async function deepStep(p: CorpusProgress, signal: AbortSignal) {
  const base = p.done;
  touch(p, { step: "Пересказ сезона" });
  try {
    await buildSeasonPlot(p.anilistId, signal, (done, total) => {
      touch(p, { done: base + done, total: base + total, etaSec: (total - done) * DEEP_SEC });
    });
  } catch (e) {
    if (signal.aborted) throw e;
    p.errors.push(`Пересказ сезона: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const pluralRu = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

registerHandler("corpus", {
  noun: "Сюжет собран",
  anilistId: async (key) => Number(key) || null,
  title: async (key) => {
    const d = await getDetails(Number(key));
    return d.title.romaji ?? d.title.english ?? `#${key}`;
  },
  fresh: () => false,
  href: (key) => `/anime/${key}`,
  run: async (key, signal) => {
    const p = await collectCorpus(Number(key), signal);
    await deepStep(p, signal);
    touch(p, { step: "готово", finished: true, etaSec: 0 });
    const full = deepestByEpisode(corpusOf(Number(key)));
    const deep = [...full.values()].filter((t) => t.depth !== "teaser").length;
    const summary = `Подробных пересказов: ${deep} ${pluralRu(deep, "серия", "серии", "серий")} из ${full.size}` + (p.errors.length ? ` (ошибки: ${p.errors.length})` : "");
    return { summary, isNew: deep > 0 };
  },
});

/** Состояние корпуса для страницы тайтла: задача, прогресс и что уже собрано. */
export function corpusState(anilistId: number): CorpusState {
  const texts = corpusOf(anilistId);
  const best = deepestByEpisode(texts);
  const sources: Record<string, number> = {};
  for (const t of texts) sources[t.source] = (sources[t.source] ?? 0) + 1;
  return {
    task: latestTask("corpus", String(anilistId)),
    progress: corpusProgress(anilistId),
    episodes: best.size,
    deep: [...best.values()].filter((t) => t.depth !== "teaser").length,
    sources,
  };
}
