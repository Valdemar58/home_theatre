import { installationBinding } from "@/server/desktop";
import { authed, ApiError, json } from "@/server/route";
export const POST=authed(async(req,user)=>{
  if(!req.headers.get("origin") || new URL(req.headers.get("origin")!).host!==req.headers.get("host")) throw new ApiError(403,"Действие доступно только в приложении этого сервера");
  const b=await req.json();
  return json(installationBinding(user.id,b.key,b.label,b.platform,b.action,b.previousToken));
});
