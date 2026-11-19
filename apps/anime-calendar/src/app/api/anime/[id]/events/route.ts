import { titleEvents } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** События тайтла по аркам — только те, что зритель уже видел (по «Сюжету на серию»). */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await titleEvents(user.id, intParam(id, "id"))));
