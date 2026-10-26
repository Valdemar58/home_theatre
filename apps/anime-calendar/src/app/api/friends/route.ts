import { friendAction, people } from "@/server/social";
import { ApiError, authed, json } from "@/server/route";

const ACTIONS = ["request", "accept", "decline", "cancel", "remove"] as const;

export const GET = authed(async (_req, user) => json(await people(user.id)));

export const POST = authed(async (req, user) => {
  const { userId, action } = (await req.json()) as { userId: number; action: (typeof ACTIONS)[number] };
  if (!ACTIONS.includes(action)) throw new ApiError(400, "Неизвестное действие");
  friendAction(user, Number(userId), action);
  return json(await people(user.id));
});
