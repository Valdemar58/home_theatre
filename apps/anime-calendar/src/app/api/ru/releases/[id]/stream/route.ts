import { env } from "@/server/env";
import { ApiError, authed, intParam, json } from "@/server/route";
import { streamRuRelease, streamUrl } from "@/server/ru/releases";

const requireStream = () => {
  if (!env.torrserverUrl || !env.prowlarrApiKey) throw new ApiError(400, "Стриминг не настроен (нет TorrServer или ключа Prowlarr)");
};

/** Ссылка на сериал в Jellyfin «Стрим» (появляется после сканирования библиотеки) */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  requireStream();
  return json({ url: await streamUrl(intParam(id, "id")) });
});

/** «Смотреть сейчас»: раздача в TorrServer, серии в Jellyfin */
export const POST = authed<{ id: string }>(async (req, _user, { id }) => {
  requireStream();
  const { guid } = (await req.json().catch(() => ({}))) as { guid?: string };
  if (!guid) throw new ApiError(400, "Не выбрана раздача");
  try {
    return json(await streamRuRelease(intParam(id, "id"), guid));
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
  }
});
