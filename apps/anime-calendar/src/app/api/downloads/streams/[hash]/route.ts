import { authed, json } from "@/server/route";
import { removeStream } from "@/server/stream";

/** Убрать онлайн-просмотр (раздача TorrServer + ссылки в библиотеке «Стрим»). */
export const DELETE = authed<{ hash: string }>(async (_req, _user, { hash }) => {
  await removeStream(hash);
  return json({ ok: true });
});
