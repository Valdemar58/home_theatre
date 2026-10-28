import type { PlayCaps } from "@/lib/player";
import { startPlayback } from "@/server/player";
import { ApiError, authed, json } from "@/server/route";

// Начать просмотр серии: { anilistId, ep, caps, audio?, start?, replace? } → PlayInfo (поток, дорожки, шрифты, главы)
export const POST = authed(async (req, user) => {
  const b = (await req.json().catch(() => ({}))) as { anilistId?: number; ep?: number; caps?: PlayCaps; audio?: number | null; start?: number | null; replace?: string | null };
  if (!Number.isInteger(b.anilistId) || !Number.isInteger(b.ep) || !b.caps) throw new ApiError(400, "Неверный запрос");
  const caps: PlayCaps = { hevc: Boolean(b.caps.hevc), av1: Boolean(b.caps.av1), maxBitrate: Math.min(120e6, Math.max(1e6, Number(b.caps.maxBitrate) || 40e6)) };
  return json(await startPlayback(user, b.anilistId!, b.ep!, { caps, audio: b.audio, start: b.start, replace: b.replace }));
});
