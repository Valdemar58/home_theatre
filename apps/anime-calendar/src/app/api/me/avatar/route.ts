import { env } from "@/server/env";
import { ApiError, authed, json } from "@/server/route";

// Аватар хранится в Jellyfin — один и тот же в календаре, Jellyfin и Seerr.
// Тело запроса — готовая картинка (клиент уже обрезал до квадрата и сжал).

const MAX = 2 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

const jf = (path: string, init: RequestInit) => fetch(`${env.jellyfinUrl}${path}`, {
  ...init,
  headers: { Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"`, ...(init.headers ?? {}) },
  signal: AbortSignal.timeout(15_000),
});

export const POST = authed(async (req, user) => {
  const type = req.headers.get("content-type") ?? "";
  if (!TYPES.includes(type)) throw new ApiError(400, "Нужна картинка JPEG, PNG или WebP");
  const body = Buffer.from(await req.arrayBuffer());
  if (!body.length || body.length > MAX) throw new ApiError(400, "Картинка пустая или больше 2 МБ");
  // Jellyfin ждёт картинку в base64
  const res = await jf(`/UserImage?userId=${user.jellyfin_id}`, { method: "POST", headers: { "Content-Type": type }, body: body.toString("base64") });
  if (!res.ok) throw new ApiError(502, `Jellyfin: HTTP ${res.status}`);
  return json({ ok: true });
});

export const DELETE = authed(async (_req, user) => {
  const res = await jf(`/UserImage?userId=${user.jellyfin_id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new ApiError(502, `Jellyfin: HTTP ${res.status}`);
  return json({ ok: true });
});
