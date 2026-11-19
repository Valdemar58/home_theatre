import { deviceByToken, requireDesktopProtocol } from "@/server/desktop";
import { hostState, hostAnswer, fulfill, CHUNK } from "@/server/desktop-stream";
import { ApiError, json } from "@/server/route";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    requireDesktopProtocol(req);
    const d = deviceByToken((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    // Short poll also carries revocations; bounded, no outstanding waiter per host.
    return json(hostState(d.id));
  } catch (e) { return json({ error: (e as Error).message }, e instanceof ApiError ? e.status : 500); }
}
export async function POST(req: Request) {
  try {
    requireDesktopProtocol(req);
    const d = deviceByToken((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    const q = new URL(req.url).searchParams;
    const max = q.has("job") ? CHUNK : 40000;
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new ApiError(413, "Слишком большой ответ"); } chunks.push(value); }
    const bytes = Buffer.concat(chunks);
    if (q.has("job")) fulfill(d.id, q.get("job")!, bytes, req.headers.get("x-host-error") ? "Хост не смог прочитать подготовленный файл" : undefined, Number(q.get("generation") || 1));
    else { const b = JSON.parse(bytes.toString()); hostAnswer(d.id, String(b.lease), b.answer, b.generation, b.negotiation); }
    return json({ ok: true });
  } catch (e) { return json({ error: (e as Error).message }, e instanceof ApiError ? e.status : 500); }
}
