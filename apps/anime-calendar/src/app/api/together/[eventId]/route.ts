import { eventFor, undoTogether } from "@/server/together";
import { ApiError, authed, intParam, json } from "@/server/route";

export const GET = authed<{ eventId: string }>(async (_req, user, { eventId }) => {
  const ev = eventFor(user.id, intParam(eventId, "eventId"));
  if (!ev) throw new ApiError(404, "Отметка не найдена");
  return json(ev);
});

/** Отменить отметку «вместе». */
export const POST = authed<{ eventId: string }>(async (_req, user, { eventId }) => json(undoTogether(user.id, intParam(eventId, "eventId"))));
