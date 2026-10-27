import { characterDetails, viewerCursor } from "@/server/plot-graph";
import { authed, json } from "@/server/route";

/** Персонаж (число — AniList, «e123» — сущность разбора серий): всё — только до серии, которую зритель досмотрел. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await characterDetails(id, viewerCursor(user.id))));
