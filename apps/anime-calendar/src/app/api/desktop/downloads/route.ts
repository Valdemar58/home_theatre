import { authed, ApiError, json } from "@/server/route";
import { deviceDownloads, enqueue, ownedDevice } from "@/server/desktop-commands";
import { desktopReleases, desktopTorrent } from "@/server/desktop-releases";
import { setOwnedGrant } from "@/server/desktop";
import { getMedia } from "@/server/lists";
export const GET = authed(async (req, user) => json(deviceDownloads(user.id, new URL(req.url).searchParams.get("device") || "")));
export const POST = authed(async (req, user) => {
  if (!req.headers.get("origin") || new URL(req.headers.get("origin")!).host !== req.headers.get("host")) throw new ApiError(403, "Откройте приложение для выполнения действия");
  const text = await req.text();
  if (text.length > 50000) throw new ApiError(413, "Слишком большой запрос");
  const b = JSON.parse(text), device = String(b.device);
  ownedDevice(user.id, device);
  if(["storage-add","storage-scan","storage-disconnect","storage-recover","storage-default","move-titles"].includes(b.action)) {
    const snapshot=deviceDownloads(user.id,device);
    if(!snapshot.capabilities?.includes("storage-volumes-v1"))throw new ApiError(409,"Обновите desktop для управления дисками");
    if(b.action==="storage-add") {
      if(snapshot.capabilities.includes("storage-discovery-v1")&&(typeof b.volume!=="string"||!snapshot.storage?.available?.some((v:{id:string})=>v.id===b.volume)))throw new ApiError(400,"Выберите обнаруженный том");
      return json(enqueue(user.id,device,b.action,{volume:b.volume}));
    }
    if(["storage-scan","storage-recover"].includes(b.action))return json(enqueue(user.id,device,b.action,{}));
    if(typeof b.target!=="string"||!snapshot.storage?.volumes?.some((v:{targetId?:string})=>v.targetId===b.target))throw new ApiError(400,"Выберите подключённый диск");
    if(b.action==="storage-default")return json(enqueue(user.id,device,b.action,{target:b.target}));
    if(b.action==="storage-disconnect")return json(enqueue(user.id,device,b.action,{target:b.target}));
    if(!Array.isArray(b.titles)||!b.titles.length||b.titles.length>100||b.titles.some((id:number)=>!Number.isSafeInteger(id)||id<1)||new Set(b.titles).size!==b.titles.length)throw new ApiError(400,"Выберите сезоны для переноса");
    const titles=b.titles.map((id:number)=>({title:id,episodes:getMedia(id)?.episodes??0}));
    if(titles.some((t:{episodes:number})=>!t.episodes))throw new ApiError(409,"Количество серий сезона пока неизвестно");
    return json(enqueue(user.id,device,b.action,{target:b.target,titles}));
  }
  if(b.target!==undefined) {
    const snapshot=deviceDownloads(user.id,device);
    if(typeof b.target!=="string"||!snapshot.storage?.volumes?.some((v:{targetId?:string})=>v.targetId===b.target))throw new ApiError(400,"Выберите подключённый диск");
  }
  if(["remove-episode","prepare-episode"].includes(b.action)) {
    const snapshot=deviceDownloads(user.id,device);
    if(!snapshot.capabilities?.includes(b.action==="prepare-episode"?"episode-prepare-v1":"episode-delete-v1"))throw new ApiError(409,"Обновите desktop для управления отдельными сериями");
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
    return json(enqueue(user.id, device, "inspect", { ...source, title: b.title, titleName: b.titleName, releaseName: source.title, episodes: b.episodes,target:b.target }));
  }
  if (!["start", "pause", "resume", "cancel"].includes(b.action) || typeof b.job !== "string" || !/^[a-f0-9-]{36}$/.test(b.job)) throw new ApiError(400, "Некорректное действие");
  if (b.action === "start" && (!Array.isArray(b.selections) || !b.selections.length || b.selections.length > 500 || b.selections.some((s: {index:number;episode:number}) => !Number.isSafeInteger(s.index) || s.index < 0 || !Number.isSafeInteger(s.episode) || s.episode < 1 || s.episode > 10000))) throw new ApiError(400, "Выберите серии и проверьте их номера");
  return json(enqueue(user.id, device, b.action, { job: b.job, selections: b.selections, autoPrepare: true,target:b.target }));
});
