import { authed, intParam, json, ApiError } from "@/server/route";
import { ensureMedia } from "@/server/lists";
import { inactivityDays, markEpisode, personalHistory, revokeOwnEvent, setInactivity } from "@/server/watch-history";
export const GET = authed(async (req,user) => {
  const title = new URL(req.url).searchParams.get("title");
  return json({ days:inactivityDays(user.id), cycles:personalHistory(user.id,title ? intParam(title,"title") : undefined) });
});
export const POST = authed(async(req,user)=>{
  const b=await req.json();
  if(b.action==="episode") { const title=intParam(String(b.anilistId),"title"); await ensureMedia(title); markEpisode(user.id,title,intParam(String(b.ep),"ep")); }
  else if(b.action==="revoke") revokeOwnEvent(user.id,String(b.id));
  else if(b.action==="preferences") setInactivity(user.id,b.days);
  else throw new ApiError(400,"Неизвестное действие");
  return json({ok:true});
});
