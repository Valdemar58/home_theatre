import { eventDetails } from "@/server/plot-graph";
import { authed, intParam, json } from "@/server/route";

/** Событие: причины и последствия, ход, участники и мотивы — до серии зрителя. */
export const GET = authed<{ id: string; key: string }>(async (_req, user, { id, key }) => json(await eventDetails(user.id, intParam(id, "id"), key)));
