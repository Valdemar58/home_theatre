import { playSession, playStatus, reportProgress, stopPlayback } from "@/server/player";
import { authed, json } from "@/server/route";

// Состояние потока (раздача «Стрима», буфер) — для панели в плеере
export const GET = authed<{ sid: string }>(async (_req, user, { sid }) => json(await playStatus(playSession(sid, user.id))));

// Позиция просмотра (раз в 10 с и на паузе): сохранить, после 85% — серия просмотрена
export const POST = authed<{ sid: string }>(async (req, user, { sid }) => {
  const { pos } = (await req.json().catch(() => ({}))) as { pos?: number };
  const s = playSession(sid, user.id);
  return json(await reportProgress(user, s, Math.max(0, Number(pos) || 0)));
});

// Закрыли плеер — запомнить позицию и остановить перекодирование
export const DELETE = authed<{ sid: string }>(async (req, user, { sid }) => {
  const { pos } = (await req.json().catch(() => ({}))) as { pos?: number };
  if (Number(pos) > 0) {
    // Сессию могли уже убрать (долго не было вестей) — тогда позиция не важна
    try { await reportProgress(user, playSession(sid, user.id), Number(pos)); } catch { /* сессии нет */ }
  }
  await stopPlayback(sid, user.id);
  return json({ ok: true });
});
