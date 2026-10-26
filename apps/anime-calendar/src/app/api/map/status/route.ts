import { atlasStatus } from "@/server/reco/atlas";
import { authed, json } from "@/server/route";

/** Ход сборки карты */
export const GET = authed(async () => json(atlasStatus()));
