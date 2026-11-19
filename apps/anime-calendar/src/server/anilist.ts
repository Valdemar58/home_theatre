import "server-only";
import type { Filters } from "@/lib/filters";
import type { AnimeDetails, Airing, CalendarResponse, MediaLite } from "@/lib/types";
import { cached, getCached, setCached } from "./cache";
import { now } from "./db";
import { freshFor } from "@/lib/freshness";
import { expectOk, fetchWithRetry, RateLimiter } from "./http";
import { guarded } from "./sources";

const ENDPOINT = "https://graphql.anilist.co";
// Лимит AniList сейчас 30 запросов/мин; короткие пачки проходят быстро,
// дальше троттлер ждёт сброса по заголовкам X-RateLimit-*
const limiter = new RateLimiter(250);

export const MEDIA_FIELDS = `
  id idMal format status episodes duration season seasonYear countryOfOrigin source isAdult
  averageScore popularity genres
  title { romaji english native }
  coverImage { large color }
  bannerImage
  studios(isMain: true) { nodes { name } }
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { episode airingAt }
`;

export type RawMedia = Omit<MediaLite, "title" | "studios" | "malScore"> & {
  title: { romaji: string | null; english: string | null; native: string | null };
  studios: { nodes: { name: string }[] } | null;
};

export function toLite(raw: RawMedia): MediaLite {
  return {
    ...raw,
    genres: raw.genres ?? [],
    isAdult: Boolean(raw.isAdult),
    malScore: null,
    popularity: raw.popularity ?? 0,
    title: { ...raw.title, ru: null },
    studios: raw.studios?.nodes.map((s) => s.name) ?? [],
  };
}

/** Запросы AniList ждут в очереди: фоновое сохранение архива уступает место запросам страниц. */
export const anilistBusy = () => limiter.pending > 0;

export function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return guarded("anilist", () => gqlRaw<T>(query, variables));
}

async function gqlRaw<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetchWithRetry(
    ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    limiter,
    {
      onResponse: (r) => {
        const remaining = Number(r.headers.get("x-ratelimit-remaining"));
        const reset = Number(r.headers.get("x-ratelimit-reset"));
        if (r.headers.has("x-ratelimit-remaining") && remaining <= 1) {
          limiter.pauseUntil(reset > 0 ? reset * 1000 + 500 : Date.now() + 60_000);
        }
      },
    },
  );
  await expectOk(res, "AniList");
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`AniList: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data;
}

// ---------------------------------------------------------------- календарь

const WEEK = 7 * 86400;
/** Начало UTC-недели (понедельник 00:00) для момента времени */
const weekStart = (ts: number) => {
  const d = new Date(ts * 1000);
  const offset = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset) / 1000;
};

const AIRING_QUERY = `
query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      episode airingAt media { ${MEDIA_FIELDS} }
    }
  }
}`;

type WeekChunk = { media: MediaLite[]; airings: Airing[] };

async function fetchWeek(start: number): Promise<WeekChunk> {
  const media = new Map<number, MediaLite>();
  const airings: Airing[] = [];
  for (let page = 1; page <= 40; page++) {
    const data = await gql<{
      Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { episode: number; airingAt: number; media: RawMedia | null }[] };
    }>(AIRING_QUERY, { page, from: start - 1, to: start + WEEK });
    for (const a of data.Page.airingSchedules) {
      if (!a.media) continue;
      media.set(a.media.id, toLite(a.media));
      airings.push({ mediaId: a.media.id, episode: a.episode, airingAt: a.airingAt });
    }
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return { media: [...media.values()], airings };
}

function getWeek(start: number): Promise<WeekChunk> {
  // Прошедшие недели не меняются — хранятся и не перепроверяются; текущие и будущие — раз в 3 часа
  const ttl = start + WEEK < now() - 86400 ? 10 * 365 * 86400 : 3 * 3600;
  return cached(`airing:${start}`, { fresh: ttl, source: "anilist" }, () => fetchWeek(start));
}

export async function getCalendar(from: number, to: number): Promise<CalendarResponse> {
  const media: Record<number, MediaLite> = {};
  const airings: Airing[] = [];
  for (let start = weekStart(from); start < to; start += WEEK) {
    const chunk = await getWeek(start);
    for (const m of chunk.media) media[m.id] = m;
    for (const a of chunk.airings) if (a.airingAt >= from && a.airingAt < to) airings.push(a);
  }
  return { media, airings };
}

// ---------------------------------------------------------------- карточка

const DETAILS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${MEDIA_FIELDS}
    coverXL: coverImage { extraLarge }
    description(asHtml: false)
    synonyms
    trailer { id site }
    tags { name rank isMediaSpoiler }
    airingSchedule(perPage: 50) { nodes { episode airingAt } }
    relations { edges { relationType node { type ${MEDIA_FIELDS} } } }
  }
}`;

type RawDetails = RawMedia & {
  coverXL: { extraLarge: string | null } | null;
  description: string | null;
  synonyms: string[];
  trailer: { id: string; site: string } | null;
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[];
  airingSchedule: { nodes: { episode: number; airingAt: number }[] };
  relations: { edges: { relationType: string; node: RawMedia & { type: string } }[] };
};

export type AnilistDetails = Omit<AnimeDetails, "externalIds" | "images" | "backdrop">;

/** Страница тайтла. wait — дождаться обновления устаревшего (фоновое сохранение архива), иначе устаревшее — сразу. */
export function getDetails(id: number, opts: { wait?: boolean } = {}): Promise<AnilistDetails> {
  // Вышедший давно тайтл проверяется раз в 90 дней и в фоне, онгоинг — раз в сутки
  return cached<AnilistDetails>(`media:v2:${id}`, { fresh: (v) => freshFor(v), source: "anilist", swr: !opts.wait }, async () => {
    let m: RawDetails;
    try {
      ({ Media: m } = await gql<{ Media: RawDetails }>(DETAILS_QUERY, { id }));
    } catch (err) {
      // AniList недоступен: отдаём запись старого формата из кэша, если она есть
      const old = getCached<AnilistDetails>(`media:${id}`, true);
      if (old) return { ...old, coverXL: old.coverXL ?? null };
      throw err;
    }
    return {
      ...toLite(m),
      coverXL: m.coverXL?.extraLarge ?? null,
      description: m.description,
      synonyms: m.synonyms ?? [],
      trailer: m.trailer,
      tags: (m.tags ?? []).map((t) => ({ name: t.name, rank: t.rank, spoiler: t.isMediaSpoiler })),
      schedule: m.airingSchedule.nodes,
      relations: m.relations.edges
        .filter((e) => e.node.type === "ANIME")
        .map((e) => ({ relationType: e.relationType, media: toLite(e.node) })),
    };
  });
}

// ---------------------------------------------------------------- каталог

const BROWSE_QUERY = `
query ($page: Int, $season: MediaSeason, $year: Int, $search: String, $sort: [MediaSort],
       $format: [MediaFormat], $genreIn: [String], $genreNotIn: [String], $country: CountryCode,
       $source: [MediaSource], $score: Int, $popularity: Int, $adult: Boolean, $status: MediaStatus, $malIds: [Int],
       $startFrom: FuzzyDateInt, $startTo: FuzzyDateInt, $statusIn: [MediaStatus], $episodes: Int) {
  Page(page: $page, perPage: 40) {
    pageInfo { hasNextPage }
    media(type: ANIME, season: $season, seasonYear: $year, search: $search, sort: $sort,
          format_in: $format, genre_in: $genreIn, genre_not_in: $genreNotIn, countryOfOrigin: $country,
          source_in: $source, averageScore_greater: $score, popularity_greater: $popularity,
          isAdult: $adult, status: $status, idMal_in: $malIds,
          startDate_greater: $startFrom, startDate_lesser: $startTo, status_in: $statusIn, episodes_greater: $episodes) { ${MEDIA_FIELDS} }
  }
}`;

export type BrowseParams = {
  page: number;
  season?: string;
  year?: number;
  status?: string;
  sort?: string;
  filters: Filters;
  /** Поиск сделан на стороне (Shikimori, по-русски): только эти тайтлы, в этом порядке */
  malIds?: number[];
};

export function browse(p: BrowseParams): Promise<{ media: MediaLite[]; hasNextPage: boolean }> {
  const f = p.filters;
  // Один год — точнее через сезонный год AniList; диапазон — по дате начала показа
  const oneYear = f.yearFrom && f.yearFrom === f.yearTo ? f.yearFrom : 0;
  const variables = {
    page: p.page,
    season: p.season || (f.seasons.length === 1 ? f.seasons[0] : undefined),
    year: p.year || oneYear || undefined,
    startFrom: !oneYear && f.yearFrom ? f.yearFrom * 10000 : undefined,
    startTo: !oneYear && f.yearTo ? (f.yearTo + 1) * 10000 : undefined,
    status: p.status || undefined,
    search: p.malIds ? undefined : f.q.trim() || undefined,
    malIds: p.malIds,
    sort: [p.sort || (f.q.trim() && !p.malIds ? "SEARCH_MATCH" : "POPULARITY_DESC")],
    format: f.formats.length ? f.formats : undefined,
    genreIn: f.genresIn.length ? f.genresIn : undefined,
    genreNotIn: f.genresEx.length ? f.genresEx : undefined,
    // AniList фильтрует только по одной стране
    country: f.countries.length === 1 ? f.countries[0] : undefined,
    source: f.sources.length ? f.sources : undefined,
    // Точный фильтр по оценке MAL делает клиент; здесь грубый отсев по AniList с запасом
    score: f.minScore ? f.minScore - 6 : undefined,
    popularity: f.minPopularity || undefined,
    adult: f.hideAdult ? false : undefined,
    statusIn: f.statuses.length ? f.statuses : undefined,
    episodes: f.minEpisodes ? f.minEpisodes - 1 : undefined,
  };
  return cached(`browse:${JSON.stringify(variables)}`, { fresh: 6 * 3600, source: "anilist" }, async () => {
    const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: RawMedia[] } }>(BROWSE_QUERY, variables);
    const media = data.Page.media.map(toLite);
    // Порядок релевантности внешнего поиска (если сортировку не выбрали)
    if (p.malIds && !p.sort) {
      const rank = new Map(p.malIds.map((id, i) => [id, i]));
      media.sort((a, b) => (rank.get(a.idMal ?? 0) ?? 1e9) - (rank.get(b.idMal ?? 0) ?? 1e9));
    }
    return { media, hasNextPage: data.Page.pageInfo.hasNextPage };
  });
}

export function genres(): Promise<string[]> {
  return cached("genres", { fresh: 7 * 86400, source: "anilist" }, async () =>
    (await gql<{ GenreCollection: string[] }>("{ GenreCollection }")).GenreCollection);
}

// ---------------------------------------------------------------- пачки по ID

const BY_IDS_QUERY = `
query ($ids: [Int], $malIds: [Int], $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: ANIME, id_in: $ids, idMal_in: $malIds) {
      ${MEDIA_FIELDS}
      airingSchedule(notYetAired: true, perPage: 50) { nodes { episode airingAt } }
    }
  }
}`;

type RawWithSchedule = RawMedia & { airingSchedule: { nodes: { episode: number; airingAt: number }[] } };

/** Пачка тайтлов с датой финала (для страницы списков). */
async function byIds(key: "ids" | "malIds", values: number[]): Promise<MediaLite[]> {
  const out: MediaLite[] = [];
  for (let i = 0; i < values.length; i += 50) {
    const data = await gql<{ Page: { media: RawWithSchedule[] } }>(BY_IDS_QUERY, { [key]: values.slice(i, i + 50), page: 1 });
    for (const raw of data.Page.media) {
      const { airingSchedule, ...rest } = raw;
      const finale = rest.episodes ? airingSchedule.nodes.find((n) => n.episode === rest.episodes) : undefined;
      const m = { ...toLite(rest), finaleAt: finale?.airingAt ?? null };
      // Карточка — в хранилище навсегда: по ней ищем без сети и знаем, что тайтл есть в архиве
      setCached(`lite:${m.id}`, m, freshFor(m));
      out.push(m);
    }
  }
  return out;
}

export const mediaByIds = (ids: number[]) => byIds("ids", ids);
export const mediaByMalIds = (malIds: number[]) => byIds("malIds", malIds);
