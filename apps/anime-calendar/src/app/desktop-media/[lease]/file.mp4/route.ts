import { authed, ApiError } from "@/server/route";
import { leaseFor, relayChunk, parseRange, CHUNK } from "@/server/desktop-stream";
export const dynamic = "force-dynamic";
const nativeWarnings = new Map<number, number>();
function mediaHeaders(bytes: number, range: string | null, start: number, end: number) {
  return { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "no-store", ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes}` } : {}) };
}
// Metadata requests must not start a relay stream (including Next's implicit HEAD).
export const HEAD = authed<{ lease: string }>(async (req, user, { lease }) => {
  const l = leaseFor(lease, user.id), range = req.headers.get("range");
  const [start, end] = parseRange(range, l.bytes);
  return new Response(null, { status: range ? 206 : 200, headers: mediaHeaders(l.bytes, range, start, end) });
});
export const GET = authed<{ lease: string }>(async (req, user, { lease }) => {
  const l = leaseFor(lease, user.id), range = req.headers.get("range");
  const [start, end] = parseRange(range, l.bytes); let offset = start;
  if (process.env.DESKTOP_RELAY_ENABLED === "0") {
    const now = Date.now();
    if (now - (nativeWarnings.get(user.id) ?? 0) >= 60000) {
      if (nativeWarnings.size >= 128) nativeWarnings.delete(nativeWarnings.keys().next().value!);
      nativeWarnings.set(user.id, now);
      console.warn("DESKTOP_NATIVE_ROUTE_DISABLED", { user: user.id, start, end });
    }
    throw new ApiError(503, "Браузер запросил видео через сервер, но ретрансляция отключена. Переподключите прямой видеоканал.");
  }
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const body = new ReadableStream({
    async pull(c) {
      try { if (offset > end) { c.close(); return; } let b: Uint8Array;
        while (true) {
          try { b = await relayChunk(l, offset, Math.min(CHUNK, end - offset + 1), abort.signal); break; }
          catch (e) { if (abort.signal.aborted || !(e instanceof ApiError) || ![429,502,503,504].includes(e.status)) throw e; await new Promise(resolve => setTimeout(resolve, 500)); }
        } offset += b.length; c.enqueue(b); }
      catch (e) { c.error(e); }
    }, cancel() { abort.abort(); },
  });
  return new Response(body, { status: range ? 206 : 200, headers: mediaHeaders(l.bytes, range, start, end) });
});
