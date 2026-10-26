import { characterDetails, viewerCursor } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** Персонаж: появления во всех тайтлах; отношения и события — только до серии, которую зритель досмотрел. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) =>
  json(await characterDetails(intParam(id, "id"), viewerCursor(user.id))));
