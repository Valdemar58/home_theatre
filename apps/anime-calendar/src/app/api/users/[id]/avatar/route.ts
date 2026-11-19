import { cached } from "@/server/cache";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { jellyfinIdOf } from "@/server/social";
import { authed, intParam } from "@/server/route";
import { guarded } from "@/server/sources";

// Аватар из Jellyfin (если пользователь его поставил); нет — 404, клиент рисует инициалы.
// Сохраняется (проверка раз в сутки, в фоне): Jellyfin не отвечает — последний известный
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const jf = jellyfinIdOf(intParam(id, "id"));
  if (!jf || !env.jellyfinApiKey) return new Response(null, { status: 404 });
  const img = await cached<{ type: string; b64: string } | null>(`avatar:${jf}`, { fresh: 86400, source: "jellyfin", cls: "entity" }, () => guarded("jellyfin", async () => {
    const res = await fetch(`${env.jellyfinUrl}/Users/${jf}/Images/Primary?width=160&quality=90`, {
      headers: { Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500) throw new HttpError(res.status, `Jellyfin: ${res.status}`);
    if (!res.ok) return null;
    return { type: res.headers.get("content-type") ?? "image/jpeg", b64: Buffer.from(await res.arrayBuffer()).toString("base64") };
  })).catch(() => null);
  if (!img) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
  return new Response(Buffer.from(img.b64, "base64"), { headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=3600" } });
});
