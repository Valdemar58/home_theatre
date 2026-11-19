import { readFile } from "node:fs/promises";
import { srtToVtt } from "@/lib/player";
import { authed, intParam, json } from "@/server/route";
import { sdhFile } from "@/server/sdh";

// Японские субтитры серии с Jimaku для плеера: ASS — как есть (JASSUB), SRT — в WebVTT (<track>)
export const GET = authed<{ id: string; ep: string }>(async (_req, _user, { id, ep }) => {
  const f = sdhFile(intParam(id, "id"), intParam(ep, "ep"));
  if (!f) return json({ error: "Субтитров нет" }, 404);
  const text = await readFile(f.path, "utf-8");
  const ass = /\.(ass|ssa)$/i.test(f.path);
  return new Response(ass ? text : srtToVtt(text), {
    headers: { "Content-Type": ass ? "text/x-ssa; charset=utf-8" : "text/vtt; charset=utf-8", "Cache-Control": "private, max-age=600" },
  });
});
