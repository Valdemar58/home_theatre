import type { AnimeDetails } from "@/lib/types";
import { getDetails } from "@/server/anilist";
import { externalIds } from "@/server/idmap";
import { withShikimori } from "@/server/lists";
import { authed, intParam, json } from "@/server/route";
import { plotHubShape } from "@/server/plot-graph";
import { ruDescription } from "@/server/shikimori";

// Картинки галереи отдаёт /api/anime/[id]/images — страница не ждёт Shikimori/TMDB
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const details = structuredClone(await getDetails(intParam(id, "id")));
  await withShikimori([details, ...details.relations.map((r) => r.media)]);
  const [ids, description] = await Promise.all([
    externalIds(details.id),
    details.idMal ? ruDescription(details.idMal).catch(() => null) : Promise.resolve(null),
  ]);
  const result: AnimeDetails = {
    ...details,
    description: description ?? details.description,
    externalIds: ids,
    plotHub: plotHubShape(details.id),
  };
  return json(result);
});
