import { authed, ApiError, json } from "@/server/route";
import { deviceDownloads, enqueue, ownedDevice } from "@/server/desktop-commands";
import { desktopReleases, desktopTorrent } from "@/server/desktop-releases";
import { setOwnedGrant } from "@/server/desktop";
export const GET = authed(async (req, user) => json(deviceDownloads(user.id, new URL(req.url).searchParams.get("device") || "")));
export const POST = authed(async (req, user) => {
  if (!req.headers.get("origin") || new URL(req.headers.get("origin")!).host !== req.headers.get("host")) throw new ApiError(403, "Откройте приложение для выполнения действия");
  const text = await req.text();
  if (text.length > 50000) throw new ApiError(413, "Слишком большой запрос");
  const b = JSON.parse(text), device = String(b.device);
  ownedDevice(user.id, device);
  if(b.action==="remove-episode") {
    const snapshot=deviceDownloads(user.id,device);
    if(!snapshot.capabilities?.includes("episode-delete-v1"))throw new ApiError(409,"Обновите desktop для удаления отдельных серий");
    if(b.library!==undefined) {
      if(typeof b.library!=="string" || !/^[a-f0-9-]{16,36}$/.test(b.library))throw new ApiError(400,"Некорректная серия");
      return json(enqueue(user.id,device,b.action,{library:b.library}));
    }
    if(typeof b.job!=="string" || !/^[a-f0-9-]{36}$/.test(b.job) || !Number.isSafeInteger(b.index) || b.index<0 || b.index>=5000)throw new ApiError(400,"Некорректная серия");
    return json(enqueue(user.id,device,b.action,{job:b.job,index:b.index}));
  }
  if (b.action === "grant") {
    if (typeof b.enabled !== "boolean") throw new ApiError(400, "Некорректное разрешение");
    setOwnedGrant(user.id, device, b.room, b.title, b.enabled);
    return json({ ok: true });
  }
  if (b.action === "search") return json(await desktopReleases(device, String(b.query || "")));
  if (b.action === "inspect") {
    if (!Number.isSafeInteger(b.title) || b.title < 1 || typeof b.titleName !== "string" || b.titleName.length > 250) throw new ApiError(400, "Выберите тайтл");
    const source = await desktopTorrent(device, String(b.release));
    if (b.episodes !== undefined && (!Array.isArray(b.episodes) || !b.episodes.length || b.episodes.length > 500 || b.episodes.some((n: number) => !Number.isSafeInteger(n) || n < 1 || n > 10000) || new Set(b.episodes).size !== b.episodes.length)) throw new ApiError(400, "Некорректные номера серий");
    return json(enqueue(user.id, device, "inspect", { ...source, title: b.title, titleName: b.titleName, releaseName: source.title, episodes: b.episodes }));
  }
  if (!["start", "pause", "resume", "cancel"].includes(b.action) || typeof b.job !== "string" || !/^[a-f0-9-]{36}$/.test(b.job)) throw new ApiError(400, "Некорректное действие");
  if (b.action === "start" && (!Array.isArray(b.selections) || !b.selections.length || b.selections.length > 500 || b.selections.some((s: {index:number;episode:number}) => !Number.isSafeInteger(s.index) || s.index < 0 || !Number.isSafeInteger(s.episode) || s.episode < 1 || s.episode > 10000))) throw new ApiError(400, "Выберите серии и проверьте их номера");
  return json(enqueue(user.id, device, b.action, { job: b.job, selections: b.selections, autoPrepare: true }));
});
