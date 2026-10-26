import { friendPicks } from "@/server/social";
import { authed, json } from "@/server/route";

export const GET = authed(async (_req, user) => json(await friendPicks(user.id)));
