import { authed, intParam, json, ApiError } from "@/server/route";
import { db } from "@/server/db";
import { correctMeeting, previewMeeting } from "@/server/meeting-history";
export const POST=authed<{id:string;sessionId:string}>(async(req,user,params)=>{
  const id=intParam(params.id,"id"),session=intParam(params.sessionId,"sessionId");
  if(!db.prepare("SELECT id FROM group_sessions WHERE id=? AND list_id=?").get(session,id)) throw new ApiError(404,"Встреча не найдена");
  const b=await req.json();
  return json(b.preview ? previewMeeting(user.id,session,b,b.revision) : correctMeeting(user.id,session,b,b.revision));
});
