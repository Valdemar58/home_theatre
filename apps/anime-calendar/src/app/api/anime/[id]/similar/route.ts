import { similarFor } from "@/server/reco/card";
import { authed, intParam, json } from "@/server/route";

/** «Похожее» для карточки тайтла: непросмотренное, затем просмотренное. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await similarFor(user.id, intParam(id, "id"))));
