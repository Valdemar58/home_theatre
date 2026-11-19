import { env } from "@/server/env";
import { adminOnly, ApiError, authed, intParam, json } from "@/server/route";
import { streamRuRelease, streamUrl } from "@/server/ru/releases";
import { episodeItems } from "@/server/playback";

const requireStream = () => {
  if (!env.torrserverUrl || !env.prowlarrApiKey) throw new ApiError(400, "Стриминг не настроен (нет TorrServer или ключа Prowlarr)");
};

/** Ссылка на сериал в Jellyfin «Стрим» (появляется после сканирования библиотеки) */
export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  requireStream();
  const hash = new URL(req.url).searchParams.get("hash");
  if (hash) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) throw new ApiError(400, "Некорректная раздача");
    const items = await episodeItems(intParam(id, "id"), true);
    const episodes = [...items].filter(([, list]) => list.some((e) => e.hash === hash.toLowerCase()))
      .map(([ep]) => ep).sort((a, b) => a - b);
    return json({ episodes });
  }
  return json({ url: await streamUrl(intParam(id, "id")) });
});

/** «Смотреть сейчас»: раздача в TorrServer, серии в Jellyfin */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  requireStream();
  const { guid } = (await req.json().catch(() => ({}))) as { guid?: string };
  if (!guid) throw new ApiError(400, "Не выбрана раздача");
  try {
    return json(await streamRuRelease(intParam(id, "id"), guid));
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
  }
});
