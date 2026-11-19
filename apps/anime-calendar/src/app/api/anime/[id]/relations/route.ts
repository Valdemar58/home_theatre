import { relationMap } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** Карта персонажей: персонажи и отношения на «Сюжет на серию». */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await relationMap(user.id, intParam(id, "id"))));
