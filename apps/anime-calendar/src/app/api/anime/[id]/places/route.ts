import { titlePlaces } from "@/server/plot-places";
import { authed, intParam, json } from "@/server/route";

/** Места тайтла на «Сюжет на серию». */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await titlePlaces(user.id, intParam(id, "id"))));
