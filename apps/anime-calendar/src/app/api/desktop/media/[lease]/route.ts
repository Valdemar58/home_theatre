import { authed, json } from "@/server/route";
import { leaseFor, relayChunk, CHUNK } from "@/server/desktop-stream";
export const dynamic = "force-dynamic";
export const GET = authed<{ lease: string }>(async (req, user, { lease }) => {
  const l = leaseFor(lease, user.id), q = new URL(req.url).searchParams;
  if (!q.has("offset")) return json({ bytes: l.bytes, duration: l.duration });
  const offset = Number(q.get("offset")), length = Number(q.get("length") || CHUNK);
  const b = await relayChunk(l, offset, length, req.signal);
  return new Response(b as BodyInit, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Length": String(b.length) } });
});
