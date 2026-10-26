import { env } from "@/server/env";
import { jellyfinIdOf } from "@/server/social";
import { authed, intParam } from "@/server/route";

// Аватар из Jellyfin (если пользователь его поставил); нет — 404, клиент рисует инициалы
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const jf = jellyfinIdOf(intParam(id, "id"));
  if (!jf || !env.jellyfinApiKey) return new Response(null, { status: 404 });
  const res = await fetch(`${env.jellyfinUrl}/Users/${jf}/Images/Primary?width=160&quality=90`, {
    headers: { Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=3600" },
  });
});
