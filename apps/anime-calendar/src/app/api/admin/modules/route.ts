import { adminOnly, authed, json } from "@/server/route";
import { systemModules } from "@/server/system-modules";

export const GET = authed(async (_req, user) => {
  adminOnly(user);
  const response = json(await systemModules());
  response.headers.set("Cache-Control", "no-store");
  return response;
});
