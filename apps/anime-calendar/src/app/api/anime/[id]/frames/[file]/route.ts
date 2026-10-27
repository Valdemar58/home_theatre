import { frameFile } from "@/server/plot-frames";
import { authed, intParam } from "@/server/route";

/** Кадр персонажа из своей серии — только вошедшим (кадры не раздаются наружу). */
export const GET = authed<{ id: string; file: string }>(async (_req, _user, { id, file }) => {
  const body = await frameFile(intParam(id, "id"), file);
  if (!body) return new Response("Нет такого кадра", { status: 404 });
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
});
