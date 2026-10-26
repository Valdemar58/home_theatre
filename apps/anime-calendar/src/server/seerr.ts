import "server-only";
import type { MediaLite, SeerrStatus } from "@/lib/types";
import { cached } from "./cache";
import { env, seerrConfigured } from "./env";
import { expectOk, fetchWithRetry, RateLimiter } from "./http";
import { externalIds } from "./idmap";

const limiter = new RateLimiter(0);

async function seerr<T>(path: string, init: RequestInit & { json?: unknown; asUser?: number } = {}): Promise<T> {
  const { json, asUser, ...rest } = init;
  const h: Record<string, string> = { "X-Api-Key": env.seerrApiKey, Accept: "application/json" };
  if (json !== undefined) h["Content-Type"] = "application/json";
  // Действовать от имени пользователя Seerr (запрос будет записан на него)
  if (asUser) h["X-Api-User"] = String(asUser);
  const res = await fetchWithRetry(
    env.seerrUrl + path,
    { ...rest, headers: h, body: json !== undefined ? JSON.stringify(json) : rest.body },
    limiter,
    { retries: 1 },
  );
  await expectOk(res, `Seerr ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

type SeerrMediaInfo = { status: number; seasons?: { seasonNumber: number; status: number }[] } | null;
type SeerrTv = {
  id: number;
  name: string;
  seasons: { seasonNumber: number; name: string; episodeCount: number }[];
  mediaInfo?: SeerrMediaInfo;
};
type SeerrMovie = { id: number; title: string; mediaInfo?: SeerrMediaInfo };
type SearchResult = { id: number; mediaType: string; name?: string; title?: string; firstAirDate?: string; releaseDate?: string };

const isMovieFormat = (m: MediaLite) => m.format === "MOVIE";

/** Найти тайтл в Seerr: сначала по таблице соответствий, потом поиском по названию. */
async function resolve(m: MediaLite): Promise<{ type: "tv" | "movie"; tmdbId: number; season: number | null; by: "mapping" | "search" } | null> {
  const ids = await externalIds(m.id);
  if (ids.tmdbMovie && isMovieFormat(m)) return { type: "movie", tmdbId: ids.tmdbMovie, season: null, by: "mapping" };
  if (ids.tmdbTv) return { type: "tv", tmdbId: ids.tmdbTv, season: ids.tmdbSeason, by: "mapping" };
  if (ids.tmdbMovie) return { type: "movie", tmdbId: ids.tmdbMovie, season: null, by: "mapping" };

  const wanted = isMovieFormat(m) ? "movie" : "tv";
  for (const q of [m.title.english, m.title.romaji].filter(Boolean) as string[]) {
    const data = await cached(`seerr-search:${q}`, 86400, () =>
      seerr<{ results: SearchResult[] }>(`/api/v1/search?query=${strictEncode(q)}&page=1&language=ru`));
    const year = m.seasonYear ?? m.startDate.year;
    const hit = data.results.find((r) => {
      if (r.mediaType !== wanted) return false;
      const y = Number((r.firstAirDate ?? r.releaseDate ?? "").slice(0, 4));
      // Для сериала год первого сезона может быть раньше, чем у текущего сезона
      return !year || !y || (wanted === "movie" ? Math.abs(y - year) <= 1 : y <= year + 1);
    });
    if (hit) return { type: wanted, tmdbId: hit.id, season: null, by: "search" };
  }
  return null;
}


/** Seerr требует закодировать и `!'()*` — encodeURIComponent их оставляет («Этот замечательный мир!» давал 400). */
const strictEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function seerrStatus(m: MediaLite): Promise<SeerrStatus> {
  if (!seerrConfigured()) return { configured: false, found: false };
  const r = await resolve(m);
  if (!r) return { configured: true, found: false };
  const url = `${env.seerrPublicUrl}/${r.type}/${r.tmdbId}`;
  if (r.type === "movie") {
    const movie = await seerr<SeerrMovie>(`/api/v1/movie/${r.tmdbId}?language=ru`);
    return {
      configured: true, found: true, matchedBy: r.by, mediaType: "movie", tmdbId: r.tmdbId,
      title: movie.title, status: movie.mediaInfo?.status ?? 1, url,
    };
  }
  const tv = await seerr<SeerrTv>(`/api/v1/tv/${r.tmdbId}?language=ru`);
  const seasonStatus = new Map(tv.mediaInfo?.seasons?.map((s) => [s.seasonNumber, s.status]) ?? []);
  const seasons = tv.seasons
    .filter((s) => s.seasonNumber > 0)
    .map((s) => ({ seasonNumber: s.seasonNumber, name: s.name, episodeCount: s.episodeCount, status: seasonStatus.get(s.seasonNumber) ?? 1 }));
  return {
    configured: true, found: true, matchedBy: r.by, mediaType: "tv", tmdbId: r.tmdbId, title: tv.name,
    status: tv.mediaInfo?.status ?? 1, seasons,
    suggestedSeason: r.season ?? seasons.at(-1)?.seasonNumber ?? null,
    url,
  };
}

type SeerrUser = { id: number; jellyfinUserId?: string | null };

/** ID пользователя Seerr для Jellyfin-аккаунта (чтобы запрос был записан на него). */
async function seerrUserId(jellyfinId: string): Promise<number | undefined> {
  const users = await cached("seerr-users", 3600, async () =>
    (await seerr<{ results: SeerrUser[] }>("/api/v1/user?take=500")).results);
  return users.find((u) => u.jellyfinUserId?.replace(/-/g, "") === jellyfinId.replace(/-/g, ""))?.id;
}

export async function seerrRequest(
  m: MediaLite,
  jellyfinId: string,
  seasons: number[],
): Promise<{ ok: true; message: string }> {
  const r = await resolve(m);
  if (!r) throw new Error("Тайтл не найден в Seerr");
  const asUser = await seerrUserId(jellyfinId).catch(() => undefined);
  const body =
    r.type === "movie"
      ? { mediaType: "movie", mediaId: r.tmdbId }
      : { mediaType: "tv", mediaId: r.tmdbId, seasons };
  await seerr("/api/v1/request", { method: "POST", json: body, asUser });
  return { ok: true, message: asUser ? "Запрос отправлен" : "Запрос отправлен (от имени администратора)" };
}
