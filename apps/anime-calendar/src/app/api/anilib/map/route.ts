import { mapManually } from "@/server/anilib";
import { ApiError, authed, json } from "@/server/route";

/** Ручное сопоставление тайтла AniLib с AniList: { libMediaId, anilist: ссылка или id }. */
export const POST = authed(async (req, user) => {
  const { libMediaId, anilist } = (await req.json().catch(() => ({}))) as { libMediaId?: number; anilist?: string };
  if (!libMediaId || !anilist) throw new ApiError(400, "Нужны libMediaId и anilist");
  try {
    await mapManually(user, libMediaId, String(anilist));
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  return json({ ok: true });
});
