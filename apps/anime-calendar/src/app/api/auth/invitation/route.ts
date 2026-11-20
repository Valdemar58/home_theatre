import { authenticatedUser } from "@/server/session";
import { acceptAccountInvitation, authBody, authLimit, sameOrigin } from "@/server/local-accounts";
import { accountEndpoint } from "@/server/account-http";
import { ApiError, json } from "@/server/route";
export const POST=(req:Request)=>accountEndpoint(async()=>{
  sameOrigin(req);authLimit(req,"accept-invitation");
  const user=await authenticatedUser();if(!user)throw new ApiError(401,"Войдите в аккаунт");
  const body=await authBody(req);return json(acceptAccountInvitation(user.id,body.token));
});
