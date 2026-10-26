import { authed, json } from "@/server/route";
import { tagsRu } from "@/server/tags-ru";

/** Русские названия тегов AniList: { "Isekai": "исекай", … } */
export const GET = authed(async () => json(tagsRu()));
