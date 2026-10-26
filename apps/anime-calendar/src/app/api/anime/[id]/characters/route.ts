import { getDetails } from "@/server/anilist";
import { seedCharacters, titleCharacters } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** Персонажи тайтла (AniList + русские имена Shikimori); заодно — сущности графа сюжета. */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const d = await getDetails(intParam(id, "id"));
  const chars = await titleCharacters(d.id, d.idMal);
  seedCharacters(d.id, chars);
  return json(chars);
});
