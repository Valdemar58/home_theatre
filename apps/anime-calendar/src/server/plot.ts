import "server-only";
import { described, episodeDigest, fillEpisodes, fuzzyIso, isStubDescription, seasonEpisodes, seasonFit, type AirWindow, type RawEpisode } from "@/lib/plot";
import type { EpisodeInfo, MediaLite, PlotInfo } from "@/lib/types";
import { getDetails, type AnilistDetails } from "./anilist";
import { freshFor } from "@/lib/freshness";
import { cached } from "./cache";
import { corpusOf, deepestByEpisode } from "./corpus-store";
import { db, now } from "./db";
import { env, seerrConfigured } from "./env";
import { HttpError } from "./http";
import { externalIds, mappingForAnilist } from "./idmap";
import { bestRouteTier, runTask, taskAvailable } from "./llm";
import { getLlmConfig } from "./llm-config";
import { hashOf, recordOutput } from "./knowledge";
import { TIER } from "@/lib/llm-tier";
import type { JsonSchema } from "@/lib/json-lite";
import { withShikimori } from "./lists";
import { seasonForPage, seasonPlot } from "./plot-deep";
import { ruDescription } from "./shikimori";
import { guarded, isOutage } from "./sources";

// Сюжет тайтла: серии (TMDB через Seerr — по-русски, иначе по-английски; запасной источник — Kitsu),
// синопсис от локальной LLM вместо заглушек Shikimori и пересказ предыдущих сезонов без спойлеров нового.

const TMDB_IMG = "https://image.tmdb.org/t/p";
const KITSU = "https://kitsu.app/api/edge";

// «…/t/p/original//abc.jpg» → «…/t/p/w780/abc.jpg»: оригиналы кадров тяжёлые
const still = (p: string | null | undefined) => (p ? `${TMDB_IMG}/w780/${p.replace(/^.*\/(?=[^/]+$)/, "")}` : null);

/** Запрос к Seerr (TMDB): нет такого — null; сбой (сеть, 5xx) — ошибка, чтобы пустое не сохранилось как «серий нет». */
function seerr<T>(path: string): Promise<T | null> {
  return guarded("seerr", async () => {
    const res = await fetch(`${env.seerrUrl}${path}`, { headers: { "X-Api-Key": env.seerrApiKey }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, `Seerr ${path}: ${res.status}`);
    return null;
  });
}

/** Kitsu: то же правило — нет данных ≠ сбой. */
function kitsu<T>(url: string): Promise<T | null> {
  return guarded("kitsu", async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, `Kitsu: ${res.status}`);
    return null;
  });
}

type TmdbSeason = { overview?: string | null; episodes?: { episodeNumber: number; name: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[] };

/** Серии и описание сезона TMDB на языке (en — без language: так Seerr отвечает для любых тайтлов). */
function tmdbSeason(tv: number, season: number, lang: "ru" | "en"): Promise<{ overview: string | null; episodes: RawEpisode[] }> {
  // Сезон TMDB у вышедшего не меняется — неделя (свежесть тайтла решает plot-eps), сбой не сохраняется
  return cached(`tmdb-season:v2:${tv}:${season}:${lang}`, { fresh: 7 * 86400, source: "seerr" }, async () => {
    const d = await seerr<TmdbSeason>(`/api/v1/tv/${tv}/season/${season}${lang === "ru" ? "?language=ru" : ""}`);
    return {
      overview: d?.overview?.trim() || null,
      episodes: (d?.episodes ?? []).map((e) => ({ number: e.episodeNumber, title: e.name, overview: e.overview, airDate: e.airDate, still: still(e.stillPath) })),
    };
  });
}

/** Сезон TMDB по-русски с английскими описаниями там, где русских нет. */
async function tmdbBoth(tv: number, season: number) {
  const ru = await tmdbSeason(tv, season, "ru");
  const en = ru.overview && ru.episodes.every((e) => e.overview?.trim()) ? { overview: null, episodes: [] } : await tmdbSeason(tv, season, "en");
  // Без русского перевода TMDB отдаёт английский текст и на ru-запрос
  const ruOverview = ru.overview && /[а-яё]/i.test(ru.overview) ? ru.overview : null;
  return { ru: ru.episodes.length ? ru.episodes : en.episodes, en: en.episodes, overview: { ru: ruOverview, en: en.overview ?? (ruOverview ? null : ru.overview) } };
}

type SeasonText = { ru: string | null; en: string | null };
type Episodes = { episodes: EpisodeInfo[]; overview: SeasonText | null };

/**
 * Серии тайтла AniList из TMDB: сезон из anime-lists, сдвиг частей сезона — по TVDB. Если серии этого
 * сезона вышли не в период показа тайтла (anime-lists ошиблись — серии прошлого года), сезон ищется по датам.
 */
async function tmdbEpisodes(anilistId: number, count: number | null, w: AirWindow): Promise<Episodes> {
  if (!seerrConfigured()) return { episodes: [], overview: null };
  const [ids, m] = await Promise.all([externalIds(anilistId), mappingForAnilist(anilistId)]);
  if (!ids.tmdbTv) return { episodes: [], overview: null };
  // Абсолютная нумерация (длинные сериалы): склеиваем сезоны TMDB подряд и вырезаем свои серии
  if (!ids.tmdbSeason && m?.season === "a") {
    const tv = await tmdbShow(ids.tmdbTv);
    const ru: RawEpisode[] = [];
    const en: RawEpisode[] = [];
    let start = 0;
    for (const s of (tv?.seasons ?? []).filter((x) => x.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber)) {
      const from = start;
      start += s.episodeCount;
      if (start <= m.offset) continue;
      if (count !== null && from >= m.offset + count) break;
      if (count === null && from > m.offset + 60) break;
      const b = await tmdbBoth(ids.tmdbTv, s.seasonNumber);
      ru.push(...b.ru.map((e) => ({ ...e, number: from + e.number })));
      en.push(...b.en.map((e) => ({ ...e, number: from + e.number })));
    }
    return { episodes: seasonEpisodes(ru, en, m.offset, count), overview: null };
  }
  const season = ids.tmdbSeason ?? (typeof m?.season === "number" ? m.season : 1);
  const b = await tmdbBoth(ids.tmdbTv, season);
  // Сдвиг TVDB годится, если TVDB и TMDB режут сериал на сезоны одинаково
  let offset = m && m.season === season ? m.offset : 0;
  if (offset && b.ru.length <= offset) offset = 0;
  const fit = seasonFit(seasonEpisodes(b.ru, b.en, offset, count), w);
  if (fit.dated >= 3 && fit.inside * 2 < fit.dated) {
    const other = await seasonByDates(ids.tmdbTv, season, count, w);
    if (other) return other;
  }
  // Описание сезона — только если тайтл и есть весь сезон (у второй части оно про обе)
  return { episodes: seasonEpisodes(b.ru, b.en, offset, count), overview: offset ? null : b.overview };
}

/** Сериал TMDB (список сезонов) — сохраняется, как и сезоны. */
function tmdbShow(tv: number) {
  return cached(`tmdb-show:${tv}`, { fresh: 7 * 86400, source: "seerr" }, () => seerr<{ seasons?: { seasonNumber: number; episodeCount: number }[] }>(`/api/v1/tv/${tv}`));
}

/** Сезон TMDB, чьи серии вышли в период показа тайтла (и с какой серии сезона он начинается). */
async function seasonByDates(tv: number, skip: number, count: number | null, w: AirWindow): Promise<Episodes | null> {
  const info = await tmdbShow(tv);
  let best: { b: Awaited<ReturnType<typeof tmdbBoth>>; offset: number; inside: number } | null = null;
  for (const s of (info?.seasons ?? []).filter((x) => x.seasonNumber > 0 && x.seasonNumber !== skip)) {
    const b = await tmdbBoth(tv, s.seasonNumber);
    const f = seasonFit(b.ru, w);
    if (f.inside > (best?.inside ?? 0)) best = { b, offset: f.offset, inside: f.inside };
  }
  if (!best) return null;
  return { episodes: seasonEpisodes(best.b.ru, best.b.en, best.offset, count), overview: best.offset ? null : best.b.overview };
}

type KitsuEpisode = { attributes: { number: number | null; canonicalTitle: string | null; synopsis: string | null; airdate: string | null; thumbnail: { original?: string } | null } };

/** Серии из Kitsu (английские): там, где TMDB ничего не знает. */
function kitsuEpisodes(anilistId: number, count: number | null): Promise<EpisodeInfo[]> {
  return cached(`kitsu-eps:${anilistId}`, { fresh: 7 * 86400, source: "kitsu" }, async () => {
    const map = await kitsu<{ included?: { id: string; type: string }[] }>(`${KITSU}/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`);
    const kitsuId = map?.included?.find((x) => x.type === "anime")?.id;
    if (!kitsuId) return [];
    const raw: RawEpisode[] = [];
    const pages = Math.min(5, Math.ceil((count ?? 40) / 20));
    for (let p = 0; p < pages; p++) {
      const d = await kitsu<{ data?: KitsuEpisode[] }>(`${KITSU}/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=${p * 20}&sort=number`);
      for (const e of d?.data ?? []) {
        if (e.attributes.number) raw.push({ number: e.attributes.number, title: e.attributes.canonicalTitle, overview: e.attributes.synopsis, airDate: e.attributes.airdate, still: e.attributes.thumbnail?.original ?? null });
      }
      if ((d?.data?.length ?? 0) < 20) break;
    }
    return seasonEpisodes(raw, [], 0, count).map((e) => ({ ...e, lang: e.overview ? ("en" as const) : null }));
  });
}

/** Сколько серий у тайтла: объявлено, иначе — сколько уже вышло. */
function episodeCount(d: Pick<MediaLite, "episodes" | "nextAiringEpisode">): number | null {
  return d.episodes ?? (d.nextAiringEpisode ? d.nextAiringEpisode.episode - 1 : null);
}

/**
 * Серии тайтла. Срок — по живости (онгоинг — 6 ч, вышедший давно — 90 дней, в фоне). Источник лежит — сохранённое;
 * сохранённого нет — пустой список без записи (иначе «серий нет» держалось бы до следующей проверки).
 */
export async function episodesOf(
  d: Pick<MediaLite, "id" | "format" | "status" | "episodes" | "nextAiringEpisode"> & Partial<Pick<MediaLite, "startDate" | "endDate">>,
): Promise<Episodes & { source: PlotInfo["source"] }> {
  if (d.format === "MOVIE") return { episodes: [], overview: null, source: null };
  const ttl = freshFor(d, "airing");
  // Сбой источника — наверх (не сохранять), «нет данных» — пусто
  const unlessOutage = <T,>(empty: T) => (e: unknown): T => { if (isOutage(e)) throw e; return empty; };
  try {
    return await cached(`plot-eps:v3:${d.id}`, { fresh: ttl }, async () => {
      const count = episodeCount(d);
      const w: AirWindow = { start: fuzzyIso(d.startDate), end: d.status === "FINISHED" ? fuzzyIso(d.endDate) : null };
      const { episodes: tmdb, overview } = await tmdbEpisodes(d.id, count, w).catch(unlessOutage<Episodes>({ episodes: [], overview: null }));
      // Kitsu — если в TMDB серий нет или описано меньше половины
      if (tmdb.length && described(tmdb) * 2 >= tmdb.length) return { episodes: tmdb, overview, source: "TMDB" as const };
      const kitsuEps = await kitsuEpisodes(d.id, count).catch(unlessOutage([] as EpisodeInfo[]));
      if (!tmdb.length) return { episodes: kitsuEps, overview, source: kitsuEps.length ? ("Kitsu" as const) : null };
      return { episodes: fillEpisodes(tmdb, kitsuEps), overview, source: "TMDB" as const };
    });
  } catch (e) {
    if (isOutage(e)) return { episodes: [], overview: null, source: null };
    throw e;
  }
}

/**
 * Серии с самым подробным текстом корпуса сюжета (Википедия, Fandom, MAL) вместо анонсов TMDB — там,
 * где корпус собран (кнопка «Собрать сюжет»). Для промптов ИИ: показ на странице не меняется.
 */
function withCorpusText(id: number, eps: EpisodeInfo[]): EpisodeInfo[] {
  const best = deepestByEpisode(corpusOf(id));
  if (!best.size) return eps;
  const base = eps.length ? eps : [...best.values()].map((t): EpisodeInfo => ({ number: t.ep, title: t.title, overview: null, lang: null, airDate: null, still: null }));
  return base.map((e) => {
    const t = best.get(e.number);
    return t && t.text.length > (e.overview?.length ?? 0) ? { ...e, overview: t.text, lang: t.lang === "ru" ? "ru" : "en" } : e;
  });
}

// ---------------------------------------------------------------- хранилище

// Текущее значение (быстрое чтение); все варианты от ИИ — в журнале llm_output (src — id строки, tier — ранг источника)
type PlotRow = { text: string; data: string | null; sources: string | null; updated_at: number; src: number | null; tier: number | null };
const getPlot = (id: number, kind: "synopsis" | "recap") =>
  db.prepare<[number, string], PlotRow>("SELECT text, data, sources, updated_at, src, tier FROM anime_plot WHERE anilist_id = ? AND kind = ?").get(id, kind);
function putPlot(id: number, kind: "synopsis" | "recap", text: string, data: unknown, sources: string, prov: { src: number | null; tier: number | null } = { src: null, tier: null }) {
  db.prepare(`INSERT INTO anime_plot (anilist_id, kind, text, data, sources, updated_at, src, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anilist_id, kind) DO UPDATE SET text = excluded.text, data = excluded.data, sources = excluded.sources,
      updated_at = excluded.updated_at, src = excluded.src, tier = excluded.tier`)
    .run(id, kind, text, data === null ? null : JSON.stringify(data), sources, now(), prov.src, prov.tier);
}

const titleOf = (t: MediaLite["title"]) => t.ru ?? t.english ?? t.romaji ?? "?";
const clean = (s: string | null | undefined) => (s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\(Source:[^)]*\)/gi, "").trim();

// ---------------------------------------------------------------- синопсис

export type SynopsisInput = {
  id: number; title: MediaLite["title"]; format: string | null; year: number | null; episodes: number | null;
  status: string | null; nextAiringEpisode: MediaLite["nextAiringEpisode"];
  /** Описание AniList (английское) */
  en: string | null;
  /** Заглушка Shikimori — в ней русское название, которым стоит называть тайтл */
  stub: string | null;
  prequels: string[];
};

const SYNOPSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: { synopsis_ru: { type: "string", description: "3–5 предложений: завязка сезона, герои, атмосфера; без спойлеров дальше первых серий" } },
  required: ["synopsis_ru"],
};

const SYNOPSIS_SYSTEM = `Ты пишешь описания аниме для каталога на русском языке. Опирайся только на данные — ничего не выдумывай.
Без спойлеров: только завязка и первые серии. Имена персонажей — в принятой русской транскрипции.
Если это продолжение, одной фразой упомяни, что это продолжение, и дальше пиши о новом сезоне. Без оценок и рекламных слов.`;

const synopsisRuns = new Map<number, Promise<string | null>>();
const RETRY_EMPTY = 7 * 86400;

/** Готовый синопсис: описание сезона TMDB или составленный ИИ (null — не составлен / не из чего). */
export function storedSynopsis(id: number): { text: string; by: "tmdb" | "ai" } | null {
  const row = getPlot(id, "synopsis");
  return row?.text ? { text: row.text, by: row.sources === "tmdb" ? "tmdb" : "ai" } : null;
}

/** Составить синопсис, если его ещё нет (одновременные запросы ждут один и тот же). */
export function ensureSynopsis(input: SynopsisInput): Promise<string | null> {
  const row = getPlot(input.id, "synopsis");
  if (row?.text) {
    void upgradeSynopsis(input, row.tier ?? TIER.local);
    return Promise.resolve(row.text);
  }
  if (row && row.updated_at > now() - RETRY_EMPTY) return Promise.resolve(null);
  return runSynopsis(input);
}

/** Улучшить синопсис ИИ более сильной моделью (в фоне; описание TMDB не трогаем). */
async function upgradeSynopsis(input: SynopsisInput, tier: number) {
  if (tier >= TIER.tmdb || synopsisRuns.has(input.id) || !getLlmConfig().upgrade.synopsis) return;
  if ((await bestRouteTier("synopsis")) <= tier) return;
  await runSynopsis(input).catch((e) => console.warn(`[plot] улучшение синопсиса ${input.id}: ${String(e)}`));
}

function runSynopsis(input: SynopsisInput): Promise<string | null> {
  const running = synopsisRuns.get(input.id);
  if (running) return running;
  const run = (async () => {
    const { episodes, overview } = await episodesOf({ id: input.id, format: input.format, status: input.status, episodes: input.episodes, nextAiringEpisode: input.nextAiringEpisode });
    // Готовое русское описание сезона в TMDB — лучше любого пересказа
    if (overview?.ru && !isStubDescription(overview.ru)) {
      putPlot(input.id, "synopsis", overview.ru, null, "tmdb", { src: null, tier: TIER.tmdb });
      return overview.ru;
    }
    const first = episodeDigest(withCorpusText(input.id, episodes).slice(0, 3), 1200, 400);
    // Английское описание-заглушка («The third season of …») — не материал: модель начнёт сочинять
    const en = isStubDescription(input.en) ? "" : clean(input.en);
    const season = overview?.en && !isStubDescription(overview.en) ? overview.en : "";
    if (!en && !first && !season) {
      putPlot(input.id, "synopsis", "", null, "");
      return null;
    }
    if (!(await taskAvailable("synopsis"))) return null;
    const prompt = [
      `Название: ${titleOf(input.title)}${input.title.romaji ? ` (${input.title.romaji})` : ""}`,
      `Формат: ${input.format ?? "?"}, год: ${input.year ?? "?"}, серий: ${input.episodes ?? "?"}`,
      input.prequels.length ? `Продолжение: ${input.prequels.join("; ")}` : "",
      input.stub ? `Короткая пометка из русского каталога: ${clean(input.stub)}` : "",
      en ? `Описание (англ.): ${en.slice(0, 1800)}` : "",
      season ? `Описание сезона (англ.): ${season.slice(0, 1200)}` : "",
      first ? `Первые серии:\n${first}` : "",
    ].filter(Boolean).join("\n");
    const res = await runTask<{ synopsis_ru: string }>("synopsis", { schema: SYNOPSIS_SCHEMA, system: SYNOPSIS_SYSTEM, user: prompt });
    const text = res.value.synopsis_ru.trim();
    const src = recordOutput("synopsis", `anime:${input.id}`, res, { synopsis_ru: text }, { schemaV: 1, promptV: 1, inputHash: hashOf(prompt) });
    // Худший результат остаётся только в журнале: текущим не становится
    const cur = getPlot(input.id, "synopsis");
    if (!cur?.text || res.tier >= (cur.tier ?? TIER.local)) {
      putPlot(input.id, "synopsis", text, null, ["ai", en ? "anilist" : "", season ? "tmdb-season" : "", first ? "episodes" : ""].filter(Boolean).join(","), { src, tier: res.tier });
    }
    // Разбор для рекомендаций сам станет «несвежим»: синопсис входит в хэш его входа
    return getPlot(input.id, "synopsis")?.text || text;
  })().finally(() => synopsisRuns.delete(input.id));
  synopsisRuns.set(input.id, run);
  return run;
}

// ---------------------------------------------------------------- «что было раньше»

/** Предыстории по порядку (от ранней к поздней), до 4: идём по PREQUEL, предпочитая сериалы. */
export async function prequelChain(d: AnilistDetails): Promise<AnilistDetails[]> {
  const chain: AnilistDetails[] = [];
  const seen = new Set([d.id]);
  let cur = d;
  while (chain.length < 4) {
    const pre = cur.relations.filter((r) => r.relationType === "PREQUEL" && !seen.has(r.media.id))
      .sort((a, b) => Number(b.media.format === "TV") - Number(a.media.format === "TV"))[0];
    if (!pre) break;
    seen.add(pre.media.id);
    cur = structuredClone(await getDetails(pre.media.id));
    chain.unshift(cur);
  }
  await withShikimori(chain);
  return chain;
}

// Сначала план (сюжетные линии), потом текст по нему: без плана модель пересказывает серию за серией
// и склеивает несвязанные события в одно предложение, чтобы уложиться в объём
const RECAP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    threads: {
      type: "array", minItems: 1, maxItems: 5, description: "план: 2–5 главных сюжетных линий прошлых частей",
      items: {
        type: "object",
        properties: {
          name_ru: { type: "string" },
          goal_ru: { type: "string", description: "чего добиваются герои этой линии и почему" },
          turns_ru: { type: "string", description: "2–4 главных поворота — с причинами и последствиями" },
          state_ru: { type: "string", description: "к чему линия пришла к концу последней части" },
        },
        required: ["name_ru", "goal_ru", "turns_ru", "state_ru"],
      },
    },
    recap_ru: { type: "string", description: "3–5 абзацев (через пустую строку) по линиям плана, 180–350 слов" },
    points: { type: "array", items: { type: "string" }, description: "3–6 коротких пунктов: что важно помнить к началу новой части" },
  },
  required: ["threads", "recap_ru", "points"],
};

const RECAP_SYSTEM = `Ты напоминаешь зрителю, который смотрел предыдущие части давно, что в них было — перед просмотром новой. По-русски, живым связным рассказом.
Сначала составь план (threads): главные сюжетные линии, чего в них добиваются герои, главные повороты, к чему пришли. Потом напиши текст по плану.
Отбор: событие попадает в текст, только если оно меняет положение героев дальше, объясняет их мотивы или нужно, чтобы понять новую часть. Разовые бои, проходные противники, побочные эпизоды и механика мира — пропускай, даже если они есть в данных.
Связность: одно предложение — одна мысль. Соединяй события в одном предложении, только если одно вытекает из другого, и называй связь (потому что, чтобы, из-за этого, в ответ). Не нанизывай несвязанное через «и», «а также», запятые.
Точность: кто кого просит, кто кому предлагает, кто кого предал — сверяй с данными; не меняй направление действий и не приписывай причин, которых в данных нет.
Термины мира — только если без них не понять; при первом упоминании поясни в двух-трёх словах.
Опирайся только на данные. О новой части ничего не говори: её событий в данных нет — не придумывай.
Последний абзац — чем закончилась последняя часть и в каком положении герои. Имена — в принятой русской транскрипции.`;

// v3: финал предыстории — до пересказа, пересказ сезона почти без обрезки
const RECAP_V = 3;
const recapRuns = new Map<number, Promise<PlotInfo["recap"]>>();

type RecapData = { points: string[]; prequels: { id: number; title: string }[]; thin?: boolean };

function readRecap(id: number, sources?: string): PlotInfo["recap"] {
  const row = getPlot(id, "recap");
  if (!row?.text || (sources !== undefined && row.sources !== sources)) return null;
  const data: RecapData = row.data ? JSON.parse(row.data) : { points: [], prequels: [] };
  return { text: row.text, points: data.points, prequels: data.prequels, thin: Boolean(data.thin) };
}

/** Пересказ предыдущих частей: составляется по запросу и хранится, пока не сменится набор предысторий. */
export function ensureRecap(d: AnilistDetails): Promise<PlotInfo["recap"]> {
  const running = recapRuns.get(d.id);
  if (running) return running;
  const run = (async () => {
    const chain = await prequelChain(d);
    if (!chain.length) return null;
    // Готовый пересказ сезона (plot_deep) — вход лучше анонсов; появился или дописался — пересказ «раньше» составляется заново
    const deep = new Map(chain.map((p) => [p.id, seasonPlot(p.id)] as const));
    // Версия пересказа — в наборе источников: новый промпт составляет пересказ заново (старый остаётся в журнале)
    const sources = `r${RECAP_V}:` + chain.map((p) => { const x = deep.get(p.id); return x?.state ? `${p.id}@${x.state.upTo}` : String(p.id); }).join(",");
    const ready = readRecap(d.id, sources);
    if (ready) return ready;
    if (!(await taskAvailable("recap"))) throw new Error("ИИ недоступен: нет ни ключа внешнего API, ни локальной модели");
    const budget = Math.floor(6500 / chain.length);
    const parts = await Promise.all(chain.map(async (p, i) => {
      const [ru, eps] = await Promise.all([
        p.idMal ? ruDescription(p.idMal).catch(() => null) : null,
        episodesOf(p).catch(() => ({ episodes: [] as EpisodeInfo[], overview: null })),
      ]);
      const desc = ru && !isStubDescription(ru) ? clean(ru) : isStubDescription(p.description) ? "" : clean(p.description);
      const season = [eps.overview?.ru, eps.overview?.en].find((x) => x && !isStubDescription(x)) ?? "";
      // Подробные пересказы корпуса — длиннее анонсов: на серию даём долю бюджета части, но не меньше прежних 260 символов
      const room = Math.max(600, budget - Math.min(desc.length, 700) - Math.min(season.length, 700));
      const sp = deep.get(p.id);
      if (sp?.state) {
        const s = sp.state;
        const text = [
          `Часть ${i + 1}: «${titleOf(p.title)}» (${p.format ?? "?"}, ${p.seasonYear ?? "?"}, серий: ${p.episodes ?? "?"})`,
          // Чем кончилось — до длинного пересказа: при обрезке теряется середина, а не финал
          `На конец серии ${s.upTo}: ${s.ending_state_ru}`,
          s.arcs.length ? `Арки:\n${s.arcs.map((a) => `- ${a.name_ru} (${a.eps}): ${a.summary_ru}`).join("\n")}` : "",
          `Пересказ (серии 1–${s.upTo}): ${s.retelling_ru}`,
          s.characters.length ? `Персонажи: ${s.characters.slice(0, 15).map((c) => `${c.name_ru} — ${c.role_ru}`).join("; ")}` : "",
        ].filter(Boolean).join("\n");
        // Пересказ сезона уже сжат по смыслу — режем только очень длинные (сезоны по 25+ серий)
        return { text: text.slice(0, Math.max(budget, 12_000)), thin: false };
      }
      const episodes = withCorpusText(p.id, eps.episodes);
      const digest = episodeDigest(episodes, room, Math.max(260, Math.floor(room / Math.max(1, episodes.filter((e) => e.overview).length))));
      const text = [
        `Часть ${i + 1}: «${titleOf(p.title)}» (${p.format ?? "?"}, ${p.seasonYear ?? "?"}, серий: ${p.episodes ?? "?"})`,
        desc ? `Описание: ${desc.slice(0, 700)}` : "",
        season ? `Описание сезона: ${season.slice(0, 700)}` : "",
        digest ? `Серии:\n${digest}` : "",
      ].filter(Boolean).join("\n");
      // Известна только завязка части: ни описаний серий, ни описания сезона
      return { text, thin: !digest && !season };
    }));
    const thin = parts.at(-1)!.thin;
    const prompt = `Новая часть: «${titleOf(d.title)}». Перескажи всё, что было до неё.` +
      (thin ? " О последней из прошлых частей известна только завязка — так и скажи в конце, чем она кончилась, не додумывай." : "") +
      `\n\n${parts.map((x) => x.text).join("\n\n")}`;
    const res = await runTask<{ threads: unknown[]; recap_ru: string; points: string[] }>("recap", { schema: RECAP_SCHEMA, system: RECAP_SYSTEM, user: prompt, maxTokens: 4000 });
    const r = res.value;
    const prequels = chain.map((p) => ({ id: p.id, title: titleOf(p.title) }));
    const data: RecapData = { points: r.points.map((x) => x.trim()).filter(Boolean).slice(0, 6), prequels, thin };
    const src = recordOutput("recap", `anime:${d.id}`, res, { recap_ru: r.recap_ru.trim(), threads: r.threads, ...data, sources }, { schemaV: 1, promptV: RECAP_V, inputHash: hashOf(sources) });
    putPlot(d.id, "recap", r.recap_ru.trim(), data, sources, { src, tier: res.tier });
    return readRecap(d.id);
  })().finally(() => recapRuns.delete(d.id));
  recapRuns.set(d.id, run);
  return run;
}

// ---------------------------------------------------------------- всё вместе

/**
 * Пометить серии, у которых в корпусе есть подробный пересказ (Википедия, Fandom). Серий из TMDB/Kitsu нет,
 * а корпус собран — серии берём из корпуса.
 */
function withDetails(id: number, episodes: EpisodeInfo[]): EpisodeInfo[] {
  const texts = corpusOf(id);
  if (!texts.length) return episodes;
  const deep = new Map<number, { sources: string[]; chars: number }>();
  for (const t of texts) {
    if (t.depth === "teaser") continue;
    const cur = deep.get(t.ep) ?? { sources: [], chars: 0 };
    deep.set(t.ep, { sources: [...cur.sources, t.source], chars: Math.max(cur.chars, t.text.length) });
  }
  const base = episodes.length ? episodes : [...deepestByEpisode(texts).values()].map((t): EpisodeInfo => ({
    number: t.ep, title: t.title, overview: null, lang: null, airDate: null, still: null,
  }));
  return base.map((e) => ({ ...e, detail: deep.get(e.number) ?? null }));
}

export async function plotOf(d: AnilistDetails): Promise<PlotInfo> {
  const [eps, ru] = await Promise.all([
    episodesOf(d).catch(() => ({ episodes: [] as EpisodeInfo[], overview: null, source: null })),
    d.idMal ? ruDescription(d.idMal).catch(() => null) : Promise.resolve(null),
  ]);
  const stub = isStubDescription(ru);
  let synopsis = stub ? storedSynopsis(d.id) : null;
  let pending = false;
  if (stub && !synopsis) {
    // Составляем в фоне: страница не ждёт LLM, а перезапрашивает сюжет, пока pending
    const job = ensureSynopsis({
      id: d.id, title: d.title, format: d.format, year: d.seasonYear, episodes: d.episodes, status: d.status,
      nextAiringEpisode: d.nextAiringEpisode, en: d.description, stub: ru,
      prequels: d.relations.filter((r) => r.relationType === "PREQUEL").map((r) => titleOf(r.media.title)),
    }).catch((e) => { console.warn(`[plot] синопсис ${d.id}: ${String(e)}`); return null; });
    // Описание сезона TMDB находится сразу, без LLM — тогда отвечаем уже с ним
    await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
    synopsis = storedSynopsis(d.id);
    pending = !synopsis && synopsisRuns.has(d.id);
  }
  const hasPrequels = d.relations.some((r) => r.relationType === "PREQUEL");
  return {
    episodes: withDetails(d.id, eps.episodes), source: eps.source, stub, synopsis: synopsis?.text ?? null, synopsisBy: synopsis?.by ?? null,
    pending, hasPrequels, recap: hasPrequels ? readRecap(d.id) : null, season: seasonForPage(d.id),
  };
}
