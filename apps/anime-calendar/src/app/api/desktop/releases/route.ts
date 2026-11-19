import { deviceByToken, requireDesktopProtocol } from "@/server/desktop";
import { desktopReleases, desktopTorrent } from "@/server/desktop-releases";
import { ApiError, json } from "@/server/route";
export async function POST(req: Request) {
  try {
    const device = deviceByToken((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    requireDesktopProtocol(req);
    const text = await req.text();
    if (text.length > 2000) throw new ApiError(413, "Слишком большой запрос");
    const body = JSON.parse(text);
    return json(body.action === "torrent"
      ? await desktopTorrent(device.id, String(body.id))
      : await desktopReleases(device.id, String(body.query || "")));
  } catch (e) { return json({ error: e instanceof ApiError ? e.message : "Поиск раздачи не выполнен. Повторите попытку." }, e instanceof ApiError ? e.status : 502); }
}
