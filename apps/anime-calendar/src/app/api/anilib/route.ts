import { libStatus, linkProfile, startSync, unlinkProfile } from "@/server/anilib";
import { ApiError, authed, json } from "@/server/route";
import { getUserById } from "@/server/session";

/** Состояние подключения AniLib и текущей синхронизации (для опроса из настроек). */
export const GET = authed(async (_req, user) => json(libStatus(user)));

/** Подключить профиль по ссылке и сразу построить предпросмотр. */
export const POST = authed(async (req, user) => {
  const { profile } = (await req.json().catch(() => ({}))) as { profile?: string };
  if (!profile) throw new ApiError(400, "Нужна ссылка на профиль AniLib");
  try {
    await linkProfile(user, profile);
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  const fresh = getUserById(user.id)!;
  startSync(fresh, false);
  return json(libStatus(fresh));
});

export const DELETE = authed(async (_req, user) => {
  unlinkProfile(user);
  return json({ ok: true });
});
