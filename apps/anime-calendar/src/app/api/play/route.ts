import type { PlayCaps } from "@/lib/player";
import { startPlayback } from "@/server/player";
import { isRemote } from "@/server/remote";
import { ApiError, authed, json } from "@/server/route";

/** Качество «Авто» для просмотра из интернета, бит/с. */
const REMOTE_BITRATE = 6e6;

// Начать просмотр серии: { anilistId, ep, caps, audio?, voice? (озвучка раздачи «Стрима»), start?, replace? } → PlayInfo (поток, дорожки, шрифты, главы)
export const POST = authed(async (req, user) => {
  const b = (await req.json().catch(() => ({}))) as { anilistId?: number; ep?: number; source?: string; caps?: PlayCaps; audio?: number | null; voice?: string | null; start?: number | null; replace?: string | null };
  if (!Number.isInteger(b.anilistId) || !Number.isInteger(b.ep) || !b.caps) throw new ApiError(400, "Неверный запрос");
  // Качество «Авто» (0): дома — исходное, из интернета — 6 Мбит/с (домашний канал на отдачу и сеть друга)
  if (b.source !== undefined && (typeof b.source !== "string" || !/^[a-f0-9]{40}$/i.test(b.source))) throw new ApiError(400, "Некорректный источник");
  const asked = Number(b.caps.maxBitrate) || 0;
  const maxBitrate = asked ? Math.min(120e6, Math.max(1e6, asked)) : isRemote(req) ? REMOTE_BITRATE : 120e6;
  const caps: PlayCaps = { hevc: Boolean(b.caps.hevc), av1: Boolean(b.caps.av1), maxBitrate };
  return json(await startPlayback(user, b.anilistId!, b.ep!, { caps, source: b.source?.toLowerCase(), audio: b.audio, voice: typeof b.voice === "string" ? b.voice.slice(0, 80) : null, start: b.start, replace: b.replace }));
});
