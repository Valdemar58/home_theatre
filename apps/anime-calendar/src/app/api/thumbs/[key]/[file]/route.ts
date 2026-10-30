import fs from "node:fs";
import { ApiError, authed } from "@/server/route";
import { thumbFile } from "@/server/thumbs";

/** Плитка миниатюр шкалы скачанной серии: /api/thumbs/<хэш>-<номер>/<n>.jpg (server/thumbs.ts). */
export const GET = authed<{ key: string; file: string }>(async (_req, _user, { key, file }) => {
  const n = /^(\d+)\.jpg$/.exec(file)?.[1];
  const f = n !== undefined ? thumbFile(key, Number(n)) : null;
  if (!f) throw new ApiError(404, "Нет такой миниатюры");
  return new Response(fs.readFileSync(f), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
});
