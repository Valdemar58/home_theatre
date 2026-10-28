import { ApiError, authed, json } from "@/server/route";
import { dropTorrentCache, removeStream } from "@/server/stream";

// Кэш раздачи TorrServer: «сбросить» — освободить скачанное (раздача и ссылки остаются), «убрать» — раздачу целиком
export const POST = authed(async (req) => {
  const { hash, action } = (await req.json().catch(() => ({}))) as { hash?: string; action?: string };
  if (typeof hash !== "string" || !/^[0-9a-f]{40}$/.test(hash)) throw new ApiError(400, "Неверная раздача");
  if (action === "drop") await dropTorrentCache(hash);
  else if (action === "remove") await removeStream(hash);
  else throw new ApiError(400, "Неизвестное действие");
  return json({ ok: true });
});
