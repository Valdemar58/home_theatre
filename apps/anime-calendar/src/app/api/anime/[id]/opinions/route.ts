import { opinionsOn } from "@/server/social";
import { authed, intParam, json } from "@/server/route";

export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await opinionsOn(user.id, intParam(id, "id"))));
