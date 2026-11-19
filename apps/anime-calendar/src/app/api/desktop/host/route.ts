import {
  deviceByToken,
  grantsFor,
  heartbeat,
  requireDesktopProtocol,
  hostRooms,
  setGrant,
} from "@/server/desktop";
import { ApiError, json } from "@/server/route";
import { suggest } from "@/server/search";
import { parseFilters } from "@/lib/filters";
export async function POST(req: Request) {
  try {
    const d = deviceByToken(
      (req.headers.get("authorization") || "").replace(/^Bearer /, ""),
    );
    if (Number(req.headers.get("content-length")) > 250000)
      throw new ApiError(413, "Слишком много данных");
    const text = await req.text();
    if (text.length > 250000) throw new ApiError(413, "Слишком много данных");
    const b = JSON.parse(text);
    if (b.action === "search") {
      if (
        typeof b.query !== "string" ||
        b.query.length < 2 ||
        b.query.length > 100
      )
        throw new ApiError(400, "Введите от 2 до 100 символов");
      return json({
        media: await suggest(b.query, parseFilters(new URLSearchParams())),
      });
    }
    if (b.action === "heartbeat") { requireDesktopProtocol(req); heartbeat(d, b.files); }
    else if (b.action === "grant" && typeof b.enabled === "boolean")
      setGrant(d, b.room, b.title, b.enabled);
    else throw new ApiError(400, "Неизвестное действие");
    return json({ deviceId: d.id, rooms: hostRooms(d.user_id!), grants: grantsFor(d.id) });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Ошибка хоста" },
      e instanceof ApiError ? e.status : 400,
    );
  }
}
