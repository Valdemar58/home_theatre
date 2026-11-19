import "server-only";
import { cached } from "../cache";
import { env } from "../env";
import { expectOk, fetchWithRetry, RateLimiter } from "../http";

// Клиенты Sonarr и Prowlarr для RU-индексатора.

const sonarrLimiter = new RateLimiter(0);
// Поиск на трекерах идёт через FlareSolverr и сам по себе медленный, не нагружаем его параллельно
const prowlarrLimiter = new RateLimiter(500);

async function getJson<T>(base: string, key: string, path: string, limiter: RateLimiter, timeoutMs = 30_000): Promise<T> {
  const res = await fetchWithRetry(`${base}${path}`, { headers: { "X-Api-Key": key, Accept: "application/json" } }, limiter, {
    retries: 1,
    timeoutMs,
  });
  await expectOk(res, `${base}${path.split("?")[0]}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- Sonarr

export type SonarrSeries = {
  id: number;
  title: string;
  tvdbId: number;
  year: number;
  seriesType: "standard" | "anime" | "daily";
  alternateTitles?: { title: string; seasonNumber?: number; sceneSeasonNumber?: number }[];
};

export type SonarrEpisode = { id: number; seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber?: number };

export const sonarrSeries = () =>
  cached("ru:sonarr-series", 600, () => getJson<SonarrSeries[]>(env.sonarrUrl, env.sonarrApiKey, "/api/v3/series", sonarrLimiter));

export async function seriesByTvdb(tvdbId: number): Promise<SonarrSeries | undefined> {
  return (await sonarrSeries()).find((s) => s.tvdbId === tvdbId);
}

export const sonarrEpisodes = (seriesId: number) =>
  cached(`ru:sonarr-episodes:${seriesId}`, 3600, () =>
    getJson<SonarrEpisode[]>(env.sonarrUrl, env.sonarrApiKey, `/api/v3/episode?seriesId=${seriesId}`, sonarrLimiter));

/** GET к Sonarr без кэша (очередь, история, ручной импорт) */
export const sonarrGet = <T>(path: string) => getJson<T>(env.sonarrUrl, env.sonarrApiKey, path, sonarrLimiter, 60_000);

async function sonarrSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(
    `${env.sonarrUrl}${path}`,
    { method, headers: { "X-Api-Key": env.sonarrApiKey, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    sonarrLimiter,
    { retries: 0, timeoutMs: 60_000 },
  );
  await expectOk(res, `Sonarr ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const sonarrPost = <T>(path: string, body: unknown) => sonarrSend<T>("POST", path, body);
export const sonarrPut = <T>(path: string, body: unknown) => sonarrSend<T>("PUT", path, body);
export const sonarrDelete = (path: string) => sonarrSend<null>("DELETE", path, undefined);

// ---------------------------------------------------------------- Prowlarr

export type ProwlarrRelease = {
  guid: string;
  title: string;
  size: number;
  publishDate: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoUrl?: string;
  indexerId: number;
  indexer: string;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  categories: { id: number }[];
};

type ProwlarrIndexer = { id: number; name: string; enable: boolean; tags: number[]; language?: string };

/** Нерусские трекеры (Nyaa, 1337x…): оригинал, английские и мультиязычные раздачи (IDEAS #88). */
export const origIndexers = () =>
  cached("ru:prowlarr-orig-indexers", (list: { id: number }[]) => (list.length ? 600 : 30), async () =>
    (await getJson<ProwlarrIndexer[]>(env.prowlarrUrl, env.prowlarrApiKey, "/api/v1/indexer", prowlarrLimiter))
      .filter((i) => i.enable && !/^ru/i.test(i.language ?? "")).map((i) => ({ id: i.id, name: i.name })));

/** Поиск на нерусских трекерах: аниме (5070) и ТВ (5000), для фильма — ещё фильмы (2000). */
export async function searchOrig(query: string, movie = false): Promise<ProwlarrRelease[]> {
  const indexers = await origIndexers();
  if (!indexers.length) return [];
  const params = new URLSearchParams({ query, type: "search", limit: "100" });
  for (const i of indexers) params.append("indexerIds", String(i.id));
  for (const c of movie ? ["5070", "2000"] : ["5070", "5000"]) params.append("categories", c);
  return cached(`orig:search:${params}`, (r: ProwlarrRelease[]) => (r.length ? 15 * 60 : 60), () =>
    getJson<ProwlarrRelease[]>(env.prowlarrUrl, env.prowlarrApiKey, `/api/v1/search?${params}`, prowlarrLimiter, 120_000));
}

/** Индексаторы Prowlarr с тегом ru (RuTracker, Kinozal...). */
export const ruIndexers = () =>
  cached("ru:prowlarr-indexers", (list: { id: number }[]) => (list.length ? 600 : 30), async () => {
    const [tags, indexers] = await Promise.all([
      getJson<{ id: number; label: string }[]>(env.prowlarrUrl, env.prowlarrApiKey, "/api/v1/tag", prowlarrLimiter),
      getJson<ProwlarrIndexer[]>(env.prowlarrUrl, env.prowlarrApiKey, "/api/v1/indexer", prowlarrLimiter),
    ]);
    const tag = tags.find((t) => t.label === env.ruIndexerTag)?.id;
    return indexers.filter((i) => i.enable && tag !== undefined && i.tags.includes(tag)).map((i) => ({ id: i.id, name: i.name }));
  });

/** Поиск на RU-трекерах. Пустой запрос — свежие раздачи (для RSS). */
export async function searchRu(query: string): Promise<ProwlarrRelease[]> {
  const indexers = await ruIndexers();
  if (!indexers.length) return [];
  const params = new URLSearchParams({ query, type: "search", limit: "100" });
  for (const i of indexers) params.append("indexerIds", String(i.id));
  // Категории: ТВ (5000) и аниме (5070); фильмы ищет Radarr напрямую через Prowlarr
  params.append("categories", "5000");
  params.append("categories", "5070");
  return cached(`ru:search:${params}`, (r: ProwlarrRelease[]) => (r.length ? 15 * 60 : 60), () =>
    getJson<ProwlarrRelease[]>(env.prowlarrUrl, env.prowlarrApiKey, `/api/v1/search?${params}`, prowlarrLimiter, 120_000));
}
