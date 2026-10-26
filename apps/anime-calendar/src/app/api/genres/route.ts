import { genres } from "@/server/anilist";
import { authed, json } from "@/server/route";

export const GET = authed(async () => json(await genres()));
