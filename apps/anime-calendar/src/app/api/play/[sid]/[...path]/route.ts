import { env } from "@/server/env";
import { playSession, upstreamPath } from "@/server/player";
import { authed } from "@/server/route";

// Поток серии через календарь: плейлисты и сегменты HLS, файл целиком (Range), субтитры и шрифты.
// Запрос уходит в Jellyfin с ключом в заголовке; ответ — как есть, по мере поступления.
const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

export const GET = authed<{ sid: string; path: string[] }>(async (req, user, { sid, path }) => {
  const s = playSession(sid, user.id);
  const url = new URL(req.url);
  const up = await fetch(`${env.jellyfinUrl}${upstreamPath(s, path.join("/"), url.search)}`, {
    headers: {
      Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"`,
      ...(req.headers.get("range") ? { Range: req.headers.get("range")! } : {}),
    },
    signal: req.signal,
  });
  const headers = new Headers();
  for (const h of PASS) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Плейлисты меняются (Jellyfin дописывает сегменты) — не кэшировать; сегменты и шрифты — можно
  headers.set("Cache-Control", /\.m3u8$/.test(url.pathname) ? "no-store" : "private, max-age=3600");
  return new Response(up.body, { status: up.status, headers });
});
