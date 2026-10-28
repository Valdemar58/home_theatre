import { episodeStatus } from "@/server/availability";
import { authed, intParam, json } from "@/server/route";

// Готовность серий тайтла к просмотру: библиотека, «Стрим» (буфер), загрузка, вышла/не вышла
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => json(await episodeStatus(intParam(id, "id"))));
