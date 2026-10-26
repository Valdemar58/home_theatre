import { randomBytes } from "node:crypto";
import { shikimoriConfigured } from "@/server/env";
import { ApiError, authed, json } from "@/server/route";
import { getSession } from "@/server/session";
import { authorizeUrl } from "@/server/shikimori";

/** Ссылка на страницу авторизации Shikimori. state защищает callback от подмены. */
export const GET = authed(async () => {
  if (!shikimoriConfigured()) throw new ApiError(400, "Shikimori не настроен: задай SHIKIMORI_CLIENT_ID/SECRET в .env");
  const session = await getSession();
  const state = randomBytes(16).toString("hex");
  session.shikiState = state;
  await session.save();
  return json({ url: authorizeUrl(state) });
});
