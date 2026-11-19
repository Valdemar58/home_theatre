import { playSession, playStatus, reportProgress, stopPlayback } from "@/server/player";
import { authed, json } from "@/server/route";

// Состояние потока (раздача «Стрима», буфер) — для панели в плеере
export const GET = authed<{ sid: string }>(async (_req, user, { sid }) => json(await playStatus(playSession(sid, user.id))));

// Position resumes playback; played intervals alone count towards the 80% threshold.
export const POST = authed<{ sid: string }>(async (req, user, { sid }) => {
  const { pos, played, room } = (await req.json().catch(() => ({}))) as { pos?: number; played?: unknown; room?: { id: string; revision: number } };
  const s = playSession(sid, user.id);
  return json(await reportProgress(user, s, Number.isFinite(pos) ? Math.max(0, Number(pos)) : 0, played, room));
});

// Закрыли плеер — запомнить позицию и остановить перекодирование
export const DELETE = authed<{ sid: string }>(async (req, user, { sid }) => {
  const { pos, played } = (await req.json().catch(() => ({}))) as { pos?: number; played?: unknown };
  if (Number(pos) > 0) {
    // Сессию могли уже убрать (долго не было вестей) — тогда позиция не важна
    try { await reportProgress(user, playSession(sid, user.id), Number(pos), played); } catch { /* сессии нет */ }
  }
  await stopPlayback(sid, user.id);
  return json({ ok: true });
});
