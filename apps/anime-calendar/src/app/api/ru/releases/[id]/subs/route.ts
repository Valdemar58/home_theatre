import { env } from "@/server/env";
import { ApiError, authed, intParam, json } from "@/server/route";
import { subsRuRelease } from "@/server/ru/releases";

/** «Субтитры»: из раздачи — только субтитры и шрифты (TorrServer), видео не качается */
export const POST = authed<{ id: string }>(async (req, _user, { id }) => {
  if (!env.torrserverUrl || !env.prowlarrApiKey) throw new ApiError(400, "Нет TorrServer или ключа Prowlarr");
  const { guid } = (await req.json().catch(() => ({}))) as { guid?: string };
  if (!guid) throw new ApiError(400, "Не выбрана раздача");
  try {
    return json(await subsRuRelease(intParam(id, "id"), guid));
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
  }
});
