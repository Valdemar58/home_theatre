import { playSession } from "@/server/player";
import { ApiError, authed } from "@/server/route";
import { signsTrack } from "@/server/signs";

// Надписи из полной дорожки (<номер исходной>.ass): из русской — сразу, с переводом — ждёт модель (первый раз)
export const GET = authed<{ sid: string; file: string }>(async (_req, user, { sid, file }) => {
  const m = /^(\d+)\.ass$/.exec(file);
  if (!m) throw new ApiError(404, "Нет такого файла");
  const { text, count } = await signsTrack(playSession(sid, user.id), Number(m[1]));
  return new Response(text, { headers: { "Content-Type": "text/x-ssa; charset=utf-8", "Cache-Control": "private, max-age=3600", "X-Signs-Count": String(count) } });
});
