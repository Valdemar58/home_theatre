import { authed } from "@/server/route";
import { upscaleEvents } from "@/server/upscale";

/** Поток событий ИИ-апскейла (SSE): «картинка готова» — открытые вкладки подменяют её сами. */
export const GET = authed(async (req) => {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctl) {
      const send = (e: { url: string; state: string }) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Комментарий раз в 25 с — прокси и браузер не рвут «молчащее» соединение
      const ping = setInterval(() => ctl.enqueue(enc.encode(": ping\n\n")), 25_000);
      upscaleEvents.on("change", send);
      cleanup = () => { clearInterval(ping); upscaleEvents.off("change", send); };
      req.signal.addEventListener("abort", () => { cleanup(); try { ctl.close(); } catch { /* уже закрыт */ } });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
});
