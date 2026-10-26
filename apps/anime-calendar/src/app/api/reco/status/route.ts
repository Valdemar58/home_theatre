import { authed, json } from "@/server/route";
import { queueStatus } from "@/server/reco/profile";

export const GET = authed(async () => json(await queueStatus()));
