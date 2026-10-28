import "server-only";
import type { AnimeVideo, GalleryImage } from "@/lib/types";
import type { AnilistDetails } from "./anilist";
import { cached } from "./cache";
import { env, seerrConfigured } from "./env";
import { HttpError } from "./http";
import type { ExternalIds } from "./idmap";
import { guarded } from "./sources";

// Картинки для страницы тайтла: галерея и широкий фон.
// AniList — баннер, TMDB (через Seerr) — фон, Shikimori — кадры из аниме. Постеры — только в шапке страницы.

const TMDB_IMG = "https://image.tmdb.org/t/p";

/** Фон и постер TMDB через Seerr (у Seerr уже есть ключ TMDB). */
function tmdbImages(ids: ExternalIds): Promise<{ backdrop: string | null; poster: string | null }> {
  const path = ids.tmdbTv ? `/api/v1/tv/${ids.tmdbTv}` : ids.tmdbMovie ? `/api/v1/movie/${ids.tmdbMovie}` : null;
  if (!path || !seerrConfigured()) return Promise.resolve({ backdrop: null, poster: null });
  // Картинки вышедшего тайтла почти не меняются: проверяем раз в 30 дней; сбой не сохраняется как «картинок нет»
  return cached(`tmdb-img:${path}`, { fresh: 30 * 86400, source: "seerr" }, () => guarded("seerr", async () => {
    // Без language: с ним Seerr для части тайтлов отвечает ошибкой
    const res = await fetch(`${env.seerrUrl}${path}`, {
      headers: { "X-Api-Key": env.seerrApiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, `Seerr ${path}: ${res.status}`);
    if (!res.ok) return { backdrop: null, poster: null };
    const d = (await res.json()) as { backdropPath?: string | null; posterPath?: string | null };
    return { backdrop: d.backdropPath ?? null, poster: d.posterPath ?? null };
  }));
}

type ShikiMedia = {
  screenshots: { originalUrl: string; x332Url: string }[];
  videos: { kind: AnimeVideo["kind"]; name: string | null; url: string; playerUrl: string; imageUrl: string | null }[];
};

/** Кадры и видео (OP/ED/трейлеры) с Shikimori одним запросом (ID Shikimori = MAL ID). */
function shikiMedia(malId: number): Promise<ShikiMedia> {
  return cached(`shiki-media:${malId}`, { fresh: 30 * 86400, source: "shikimori" }, () => guarded("shikimori", async () => {
    const res = await fetch(`${env.shikiUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": env.shikiAppName },
      body: JSON.stringify({
        query: `{ animes(ids: "${malId}", limit: 1) { screenshots { originalUrl x332Url } videos { kind name url playerUrl imageUrl } } }`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(res.status, `Shikimori: ${res.status}`);
    const d = (await res.json()) as { data?: { animes: ShikiMedia[] } };
    return d.data?.animes[0] ?? { screenshots: [], videos: [] };
  }));
}

// «//youtube.com/embed/…» → «https://…»
const https = (u: string | null) => (u ? (u.startsWith("//") ? `https:${u}` : u) : null);

/** Видео для карточки; если у Shikimori ничего нет — трейлер AniList. */
function videosOf(details: AnilistDetails, shiki: ShikiMedia["videos"]): AnimeVideo[] {
  const videos: AnimeVideo[] = shiki
    .filter((v) => v.playerUrl)
    .map((v) => ({ kind: v.kind, name: v.name, url: v.url, player: https(v.playerUrl)!, image: https(v.imageUrl) }));
  if (!videos.length && details.trailer?.site === "youtube") {
    const id = details.trailer.id;
    videos.push({
      kind: "pv", name: "Трейлер", url: `https://www.youtube.com/watch?v=${id}`,
      player: `https://www.youtube.com/embed/${id}`, image: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    });
  }
  return videos;
}

export async function mediaImages(
  details: AnilistDetails,
  ids: ExternalIds,
): Promise<{ images: GalleryImage[]; backdrop: string | null; videos: AnimeVideo[] }> {
  const empty: ShikiMedia = { screenshots: [], videos: [] };
  const [tmdb, shiki] = await Promise.all([
    tmdbImages(ids).catch(() => ({ backdrop: null, poster: null })),
    details.idMal ? shikiMedia(details.idMal).catch(() => empty) : Promise.resolve(empty),
  ]);
  const shots = shiki.screenshots;

  // Постеры (AniList, TMDB) в галерею не берём: главный — в шапке страницы (по клику — на весь экран),
  // а постер TMDB почти всегда тот же арт с другой обрезкой или надписью — дубли в начале «Кадров»
  const images: GalleryImage[] = [];
  for (const s of shots) images.push({ url: s.originalUrl, thumb: s.x332Url, kind: "screenshot", source: "Shikimori" });
  if (tmdb.backdrop) images.push({ url: `${TMDB_IMG}/original${tmdb.backdrop}`, thumb: `${TMDB_IMG}/w780${tmdb.backdrop}`, kind: "backdrop", source: "TMDB" });
  if (details.bannerImage) images.push({ url: details.bannerImage, thumb: details.bannerImage, kind: "banner", source: "AniList" });

  // Фон: баннер AniList → фон TMDB → кадр Shikimori (иначе страница покажет размытый постер)
  const backdrop =
    details.bannerImage ??
    (tmdb.backdrop ? `${TMDB_IMG}/original${tmdb.backdrop}` : null) ??
    shots[0]?.originalUrl ??
    null;
  return { images, backdrop, videos: videosOf(details, shiki.videos) };
}
