import { adminOnly, authed, json } from "@/server/route";
import { featureFlags } from "@/server/feature-flags";

export const GET = authed(async (_request, user) => {
  adminOnly(user);
  const response = json(featureFlags().status());
  response.headers.set("Cache-Control", "no-store");
  return response;
});
