import { after } from "next/server";
import { listWithMedia, refreshListMedia } from "@/server/lists";
import { authed, json } from "@/server/route";

export const GET = authed(async (_req, user) => {
  // Устаревшие снимки (серии, дата финала) обновляются после ответа, чтобы не тормозить страницу
  after(() => refreshListMedia().catch((e) => console.warn(`[lists] ${e}`)));
  return json(listWithMedia(user.id));
});
