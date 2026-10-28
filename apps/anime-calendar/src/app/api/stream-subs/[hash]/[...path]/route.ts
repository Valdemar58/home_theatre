import { srtToVtt } from "@/lib/player";
import { authed } from "@/server/route";
import { streamSubFile } from "@/server/stream-subs";

// Субтитры и шрифты из раздачи «Стрима» для плеера (скачаны в stream-subs.ts)
const TYPES: Record<string, string> = { ass: "text/x-ssa; charset=utf-8", ssa: "text/x-ssa; charset=utf-8", srt: "text/plain; charset=utf-8", ttf: "font/ttf", otf: "font/otf", ttc: "font/collection", woff: "font/woff", woff2: "font/woff2" };

export const GET = authed<{ hash: string; path: string[] }>(async (_req, _user, { hash, path }) => {
  const rel = path.join("/");
  const buf = await streamSubFile(hash, rel);
  if (!buf) return new Response(null, { status: 404 });
  const ext = rel.split(".").pop() ?? "";
  // SRT — в WebVTT (<track> понимает только его)
  if (ext === "srt") return new Response(srtToVtt(buf.toString("utf-8")), { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, max-age=86400" } });
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
});
