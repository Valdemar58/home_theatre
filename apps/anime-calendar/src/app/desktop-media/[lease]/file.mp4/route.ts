import { authed, ApiError } from "@/server/route";
import { leaseFor, relayChunk, parseRange, CHUNK } from "@/server/desktop-stream";
export const dynamic = "force-dynamic";
export const GET = authed<{ lease: string }>(async (req, user, { lease }) => {
  const l = leaseFor(lease, user.id), range = req.headers.get("range");
  const [start, end] = parseRange(range, l.bytes); let offset = start;
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
  return new Response(body, { status: range ? 206 : 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "no-store", ...(range ? { "Content-Range": `bytes ${start}-${end}/${l.bytes}` } : {}) } });
});
