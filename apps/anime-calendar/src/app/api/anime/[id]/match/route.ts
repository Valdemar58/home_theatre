import { matchFor } from "@/server/reco/card";
import { authed, intParam, json } from "@/server/route";

/** «Насколько мне понравится» для карточки тайтла. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await matchFor(user.id, intParam(id, "id"))));
