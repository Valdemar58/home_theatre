import { mediaByIds } from "@/server/anilist";
import { getMedia } from "@/server/lists";
import { ApiError, authed, intParam, json } from "@/server/route";
import { seerrRequest, seerrStatus } from "@/server/seerr";

async function media(id: number) {
  const m = getMedia(id) ?? (await mediaByIds([id]))[0];
  if (!m) throw new ApiError(404, "Тайтл не найден");
  return m;
}

export const GET = authed<{ id: string }>(async (_req, _user, { id }) =>
  json(await seerrStatus(await media(intParam(id, "id")))));

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const { seasons } = (await req.json().catch(() => ({}))) as { seasons?: number[] };
  const list = (seasons ?? []).filter((s) => Number.isInteger(s) && s > 0);
  const m = await media(intParam(id, "id"));
  if (m.format !== "MOVIE" && !list.length) throw new ApiError(400, "Выбери хотя бы один сезон");
  return json(await seerrRequest(m, user.jellyfin_id, list));
});
