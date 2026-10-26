import "server-only";
import { described, episodeDigest, fillEpisodes, isStubDescription, seasonEpisodes, type RawEpisode } from "@/lib/plot";
import type { EpisodeInfo, MediaLite, PlotInfo } from "@/lib/types";
import { getDetails, type AnilistDetails } from "./anilist";
import { cached } from "./cache";
import { db, now } from "./db";
import { env, seerrConfigured } from "./env";
import { externalIds, mappingForAnilist } from "./idmap";
import { runTask, taskAvailable } from "./llm";
import type { JsonSchema } from "@/lib/json-lite";
import { withShikimori } from "./lists";
import { ruDescription } from "./shikimori";

// Сюжет тайтла: серии (TMDB через Seerr — по-русски, иначе по-английски; запасной источник — Kitsu),
// синопсис от локальной LLM вместо заглушек Shikimori и пересказ предыдущих сезонов без спойлеров нового.

const TMDB_IMG = "https://image.tmdb.org/t/p";
const KITSU = "https://kitsu.app/api/edge";

// «…/t/p/original//abc.jpg» → «…/t/p/w780/abc.jpg»: оригиналы кадров тяжёлые
const still = (p: string | null | undefined) => (p ? `${TMDB_IMG}/w780/${p.replace(/^.*\/(?=[^/]+$)/, "")}` : null);

async function seerr<T>(path: string): Promise<T | null> {
  const res = await fetch(`${env.seerrUrl}${path}`, { headers: { "X-Api-Key": env.seerrApiKey }, signal: AbortSignal.timeout(15_000) });
  return res.ok ? ((await res.json()) as T) : null;
}

type TmdbSeason = { overview?: string | null; episodes?: { episodeNumber: number; name: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[] };

/** Серии и описание сезона TMDB на языке (en — без language: так Seerr отвечает для любых тайтлов). */
function tmdbSeason(tv: number, season: number, lang: "ru" | "en"): Promise<{ overview: string | null; episodes: RawEpisode[] }> {
  return cached(`tmdb-season:v2:${tv}:${season}:${lang}`, 86400, async () => {
    const d = await seerr<TmdbSeason>(`/api/v1/tv/${tv}/season/${season}${lang === "ru" ? "?language=ru" : ""}`).catch(() => null);
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

/** Серии тайтла AniList из TMDB: сезон из anime-lists, сдвиг частей сезона — по TVDB. */
async function tmdbEpisodes(anilistId: number, count: number | null): Promise<Episodes> {
  if (!seerrConfigured()) return { episodes: [], overview: null };
  const [ids, m] = await Promise.all([externalIds(anilistId), mappingForAnilist(anilistId)]);
  if (!ids.tmdbTv) return { episodes: [], overview: null };
  // Абсолютная нумерация (длинные сериалы): склеиваем сезоны TMDB подряд и вырезаем свои серии
  if (!ids.tmdbSeason && m?.season === "a") {
    const tv = await seerr<{ seasons?: { seasonNumber: number; episodeCount: number }[] }>(`/api/v1/tv/${ids.tmdbTv}`).catch(() => null);
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
  // Описание сезона — только если тайтл и есть весь сезон (у второй части оно про обе)
  return { episodes: seasonEpisodes(b.ru, b.en, offset, count), overview: offset ? null : b.overview };
}

type KitsuEpisode = { attributes: { number: number | null; canonicalTitle: string | null; synopsis: string | null; airdate: string | null; thumbnail: { original?: string } | null } };

/** Серии из Kitsu (английские): там, где TMDB ничего не знает. */
function kitsuEpisodes(anilistId: number, count: number | null): Promise<EpisodeInfo[]> {
  return cached(`kitsu-eps:${anilistId}`, 86400, async () => {
    const map = await fetch(`${KITSU}/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null) as { included?: { id: string; type: string }[] } | null;
    const kitsuId = map?.included?.find((x) => x.type === "anime")?.id;
    if (!kitsuId) return [];
    const raw: RawEpisode[] = [];
    const pages = Math.min(5, Math.ceil((count ?? 40) / 20));
    for (let p = 0; p < pages; p++) {
      const d = await fetch(`${KITSU}/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=${p * 20}&sort=number`, { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null) as { data?: KitsuEpisode[] } | null;
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

/** Серии тайтла (кэш: у выходящих — полдня, у вышедших — неделя). */
export function episodesOf(d: Pick<MediaLite, "id" | "format" | "status" | "episodes" | "nextAiringEpisode">): Promise<Episodes & { source: PlotInfo["source"] }> {
  if (d.format === "MOVIE") return Promise.resolve({ episodes: [], overview: null, source: null });
  const ttl = d.status === "RELEASING" || d.status === "NOT_YET_RELEASED" ? 12 * 3600 : 7 * 86400;
  return cached(`plot-eps:v2:${d.id}`, ttl, async () => {
    const count = episodeCount(d);
    const { episodes: tmdb, overview } = await tmdbEpisodes(d.id, count).catch((): Episodes => ({ episodes: [], overview: null }));
    // Kitsu — если в TMDB серий нет или описано меньше половины
    if (tmdb.length && described(tmdb) * 2 >= tmdb.length) return { episodes: tmdb, overview, source: "TMDB" as const };
    const kitsu = await kitsuEpisodes(d.id, count).catch(() => [] as EpisodeInfo[]);
    if (!tmdb.length) return { episodes: kitsu, overview, source: kitsu.length ? ("Kitsu" as const) : null };
    return { episodes: fillEpisodes(tmdb, kitsu), overview, source: "TMDB" as const };
  });
}

// ---------------------------------------------------------------- хранилище

type PlotRow = { text: string; data: string | null; sources: string | null; updated_at: number };
const getPlot = (id: number, kind: "synopsis" | "recap") =>
  db.prepare<[number, string], PlotRow>("SELECT text, data, sources, updated_at FROM anime_plot WHERE anilist_id = ? AND kind = ?").get(id, kind);
function putPlot(id: number, kind: "synopsis" | "recap", text: string, data: unknown, sources: string) {
  db.prepare(`INSERT INTO anime_plot (anilist_id, kind, text, data, sources, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(anilist_id, kind) DO UPDATE SET text = excluded.text, data = excluded.data, sources = excluded.sources, updated_at = excluded.updated_at`)
    .run(id, kind, text, data === null ? null : JSON.stringify(data), sources, now());
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
  if (row?.text) return Promise.resolve(row.text);
  if (row && row.updated_at > now() - RETRY_EMPTY) return Promise.resolve(null);
  const running = synopsisRuns.get(input.id);
  if (running) return running;
  const run = (async () => {
    const { episodes, overview } = await episodesOf({ id: input.id, format: input.format, status: input.status, episodes: input.episodes, nextAiringEpisode: input.nextAiringEpisode });
    // Готовое русское описание сезона в TMDB — лучше любого пересказа
    if (overview?.ru && !isStubDescription(overview.ru)) {
      putPlot(input.id, "synopsis", overview.ru, null, "tmdb");
      return overview.ru;
    }
    const first = episodeDigest(episodes.slice(0, 3), 1200, 400);
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
    const { value: r } = await runTask<{ synopsis_ru: string }>("synopsis", { schema: SYNOPSIS_SCHEMA, system: SYNOPSIS_SYSTEM, user: prompt });
    const text = r.synopsis_ru.trim();
    putPlot(input.id, "synopsis", text, null, ["ai", en ? "anilist" : "", season ? "tmdb-season" : "", first ? "episodes" : ""].filter(Boolean).join(","));
    // Анализ для рекомендаций делался по заглушке — пусть пересчитается по новому описанию
    db.prepare("UPDATE anime_profile SET analysis = NULL WHERE anilist_id = ?").run(input.id);
    return text;
  })().finally(() => synopsisRuns.delete(input.id));
  synopsisRuns.set(input.id, run);
  return run;
}

// ---------------------------------------------------------------- «что было раньше»

/** Предыстории по порядку (от ранней к поздней), до 4: идём по PREQUEL, предпочитая сериалы. */
async function prequelChain(d: AnilistDetails): Promise<AnilistDetails[]> {
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

const RECAP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    recap_ru: { type: "string", description: "8–14 предложений: что произошло в предыдущих частях по порядку и на чём всё остановилось" },
    points: { type: "array", items: { type: "string" }, description: "3–6 коротких пунктов: что важно помнить к началу новой части" },
  },
  required: ["recap_ru", "points"],
};

const RECAP_SYSTEM = `Ты пересказываешь зрителю предыдущие части аниме перед просмотром новой — по-русски, связно и по порядку.
Опирайся только на данные. О новой части ничего не говори: её событий в данных нет — не придумывай.
Главное — чем закончилась последняя часть и в каком положении герои. Имена — в принятой русской транскрипции.`;

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
    const sources = chain.map((p) => p.id).join(",");
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
      const digest = episodeDigest(eps.episodes, Math.max(600, budget - Math.min(desc.length, 700) - Math.min(season.length, 700)));
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
    const { value: r } = await runTask<{ recap_ru: string; points: string[] }>("recap", { schema: RECAP_SCHEMA, system: RECAP_SYSTEM, user: prompt });
    const prequels = chain.map((p) => ({ id: p.id, title: titleOf(p.title) }));
    const data: RecapData = { points: r.points.map((x) => x.trim()).filter(Boolean).slice(0, 6), prequels, thin };
    putPlot(d.id, "recap", r.recap_ru.trim(), data, sources);
    return readRecap(d.id);
  })().finally(() => recapRuns.delete(d.id));
  recapRuns.set(d.id, run);
  return run;
}

// ---------------------------------------------------------------- всё вместе

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
    episodes: eps.episodes, source: eps.source, stub, synopsis: synopsis?.text ?? null, synopsisBy: synopsis?.by ?? null,
    pending, hasPrequels, recap: hasPrequels ? readRecap(d.id) : null,
  };
}
