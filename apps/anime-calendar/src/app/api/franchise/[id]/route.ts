import { franchiseOf } from "@/server/franchise";
import { authed, intParam, json } from "@/server/route";

/** Франшиза любого своего тайтла: сезоны, фильмы и OVA по порядку, мой прогресс, арки сюжета. */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await franchiseOf(user.id, intParam(id, "id"))));
