import { adminOnly, authed, ApiError, json } from "@/server/route";
import { removeServerEpisode, serverDownloadStorage } from "@/server/download-storage";
export const GET=authed(async(_req,user)=>{adminOnly(user);return json(await serverDownloadStorage(user.id));});
export const DELETE=authed(async(req,user)=>{
  adminOnly(user);
  if(!req.headers.get("origin")||new URL(req.headers.get("origin")!).host!==req.headers.get("host"))throw new ApiError(403,"Откройте приложение для удаления");
  const b=await req.json();if(typeof b.key!=="string"||!/^[a-f0-9]{40}:\d+$/.test(b.key))throw new ApiError(400,"Некорректная серия");
  await removeServerEpisode(b.key);return json({ok:true});
});
