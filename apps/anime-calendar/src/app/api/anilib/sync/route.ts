import { libStatus, startSync } from "@/server/anilib";
import { ApiError, authed, json } from "@/server/route";

/** Запустить синхронизацию в фоне: { apply: false } — предпросмотр, { apply: true } — запись. */
export const POST = authed(async (req, user) => {
  const { apply } = (await req.json().catch(() => ({}))) as { apply?: boolean };
  try {
    startSync(user, Boolean(apply));
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  return json(libStatus(user));
});
