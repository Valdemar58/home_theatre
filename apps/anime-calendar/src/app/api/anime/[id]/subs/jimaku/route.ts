import { authed, intParam, json } from "@/server/route";
import { fetchJimaku } from "@/server/sdh";

// «Найти на Jimaku»: скачать японские субтитры серий тайтла (до 3 мин; уже скачанные не трогаются)
export const POST = authed<{ id: string }>(async (_req, _user, { id }) => json(await fetchJimaku(intParam(id, "id"))));
