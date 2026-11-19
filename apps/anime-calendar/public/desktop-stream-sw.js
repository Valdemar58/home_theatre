// Only desktop media requests are intercepted. No caching or offline application shell.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
function ask(client, lease, offset, length, signal) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cancel = () => { channel.port1.postMessage({ cancel: true }); channel.port1.close(); clearTimeout(timeout); reject(new Error("Range cancelled")); };
    const expired = () => { signal.removeEventListener("abort", cancel); channel.port1.postMessage({ cancel: true }); channel.port1.close(); reject(new Error("Viewer unavailable")); };
    let timeout = setTimeout(expired, 30000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timeout); if (data.waiting) { timeout = setTimeout(expired, 30000); return; } signal.removeEventListener("abort", cancel); channel.port1.close(); data.error ? reject(new Error(data.error)) : resolve(data.bytes); };
    signal.addEventListener("abort", cancel, { once: true });
    client.postMessage({ type: "desktop-range", lease, offset, length }, [channel.port2]);
  });
}
async function serve(event, lease) {
  const meta = await fetch(`/api/desktop/media/${lease}`, { cache: "no-store", signal: event.request.signal });
  if (!meta.ok) return meta;
  const { bytes } = await meta.json(), range = event.request.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (range && (!m || (!m[1] && !m[2]))) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes}` } });
  let start = m ? m[1] ? Number(m[1]) : Math.max(0, bytes - Number(m[2])) : 0;
  const end = m && m[1] && m[2] ? Math.min(bytes - 1, Number(m[2])) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes}` } });
  const length = end - start + 1, client = await self.clients.get(event.clientId);
  const controller = new AbortController();
  event.request.signal.addEventListener("abort", () => controller.abort(), { once: true });
  const body = new ReadableStream({
    async pull(c) {
      try {
        if (start > end) { c.close(); return; }
        const n = Math.min(1024 * 1024, end - start + 1);
        let data;
        if (client) data = await ask(client, lease, start, n, controller.signal);
        else { const r = await fetch(`/api/desktop/media/${lease}?offset=${start}&length=${n}`, { signal: controller.signal, cache: "no-store" }); if (!r.ok) throw new Error("Host unavailable"); data = await r.arrayBuffer(); }
        if (data.byteLength !== n) throw new Error("Incomplete media range");
        if (controller.signal.aborted) return;
        start += n; c.enqueue(new Uint8Array(data));
      } catch (e) { if (!controller.signal.aborted) c.error(e); }
    }, cancel() { controller.abort(); },
  });
  return new Response(body, { status: range ? 206 : 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Length": String(length), ...(range ? { "Content-Range": `bytes ${end - length + 1}-${end}/${bytes}` } : {}) } });
}
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url), m = /^\/desktop-media\/([a-f0-9]{32})\/file\.mp4$/.exec(url.pathname);
  if (url.origin === self.location.origin && m && event.request.method === "GET") event.respondWith(serve(event, m[1]));
});
