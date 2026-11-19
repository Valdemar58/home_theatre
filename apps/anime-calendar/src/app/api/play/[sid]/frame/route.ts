import { frameText } from "@/server/frame-text";
import { playSession } from "@/server/player";
import { ApiError, authed, json } from "@/server/route";

// «Перевести кадр»: { t } → надписи в кадре у этой секунды (текст, перевод, рамка в долях 0–1000)
export const POST = authed<{ sid: string }>(async (req, user, { sid }) => {
  const { t } = (await req.json().catch(() => ({}))) as { t?: number };
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw new ApiError(400, "Неверное время");
  const started = Date.now();
  const items = await frameText(playSession(sid, user.id), t);
  return json({ items, ms: Date.now() - started });
});
