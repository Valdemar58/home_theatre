import { placeDetails } from "@/server/plot-places";
import { authed, intParam, json } from "@/server/route";

/** Страница места на «Сюжет на серию». */
export const GET = authed<{ id: string; pid: string }>(async (_req, user, { id, pid }) => json(await placeDetails(user.id, intParam(id, "id"), intParam(pid, "pid"))));
