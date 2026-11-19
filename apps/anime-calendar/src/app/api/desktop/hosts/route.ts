import { roomHosts } from "@/server/desktop";
import { authed, intParam, json } from "@/server/route";
export const GET = authed(async (req, user) =>
  json(
    roomHosts(
      intParam(new URL(req.url).searchParams.get("room"), "room"),
      user.id,
    ),
  ),
);
