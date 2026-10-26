import "server-only";
import type { Filters } from "@/lib/filters";
import type { MediaLite } from "@/lib/types";
import { browse, type BrowseParams } from "./anilist";
import { withShikimori } from "./lists";
import { shikiSearch } from "./shikimori";

// Каталог и поиск. По-русски ищет Shikimori (AniList знает только латиницу и японский),
// найденные MAL id догружаются из AniList одним запросом — уже с фильтрами каталога.

const CYRILLIC = /\p{Script=Cyrillic}/u;
const PAGE = 40; // = perPage каталога AniList

export async function searchCatalog(p: BrowseParams): Promise<{ media: MediaLite[]; hasNextPage: boolean }> {
  const q = p.filters.q.trim();
  let result: { media: MediaLite[]; hasNextPage: boolean };
  if (q && CYRILLIC.test(q)) {
    const malIds = await shikiSearch(q, PAGE, p.page);
    result = malIds.length
      ? { media: (await browse({ ...p, page: 1, malIds })).media, hasNextPage: malIds.length === PAGE }
      : { media: [], hasNextPage: false };
  } else {
    result = await browse(p);
  }
  const media = structuredClone(result.media);
  await withShikimori(media);
  return { media, hasNextPage: result.hasNextPage };
}

/** Подсказки в строке поиска: первые 8 из того же поиска (кэш общий с каталогом). */
export async function suggest(q: string, filters: Filters): Promise<MediaLite[]> {
  if (q.trim().length < 2) return [];
  return (await searchCatalog({ page: 1, filters: { ...filters, q } })).media.slice(0, 8);
}
