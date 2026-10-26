import type { AnimeImages } from "@/lib/types";
import { getDetails } from "@/server/anilist";
import { externalIds } from "@/server/idmap";
import { mediaImages } from "@/server/media-images";
import { authed, intParam, json } from "@/server/route";

// Галерея тайтла: кадры Shikimori, фоны TMDB и AniList. Детали AniList берутся из кэша
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const anilistId = intParam(id, "id");
  const [details, ids] = await Promise.all([getDetails(anilistId), externalIds(anilistId)]);
  const result: AnimeImages = await mediaImages(details, ids);
  return json(result);
});
