import { homeData } from "@/server/home";
import { authed, json } from "@/server/route";
export const GET = authed(async (_req,user) => json(homeData(user.id)));
