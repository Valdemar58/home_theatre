import { sessionGuard } from "@/server/session";
import {
  roomEvents,
  roomListener,
  roomPresence,
  roomView,
} from "@/server/rooms";
import { authed } from "@/server/route";

/** Поток событий комнаты (SSE): снимок при подключении и после каждого изменения. Подключён — «в сети». */
export const GET = authed<{ rid: string }>(async (req, user, { rid }) => {
  const allowed = await sessionGuard();
  const m = roomListener(user.id, rid);
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctl) {
      const send = () => {
        if (!allowed()) {
          cleanup();
          try {
            ctl.close();
          } catch {}
          return;
        }
        try {
          ctl.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ ...roomView(user.id, rid), now: Date.now() })}\n\n`,
            ),
          );
        } catch {
          // Комната закончилась (или поток уже закрыт)
          try {
            ctl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ id: rid, ended: true })}\n\n`,
              ),
            );
          } catch {
            /* закрыт */
          }
        }
      };
      // Reconcile authoritative state even if a job event was missed. This also keeps the connection alive.
      const ping = setInterval(send, 1000);
      roomEvents.on(rid, send);
      // В сети — только вошедшие (приглашённый пока смотрит со стороны)
      const joined = m.status === "joined";
      if (joined) roomPresence(user.id, rid, true);
      cleanup = () => {
        clearInterval(ping);
        roomEvents.off(rid, send);
        if (joined) {
          try {
            roomPresence(user.id, rid, false);
          } catch {
            /* reconnect after database recovery */
          }
        }
        cleanup = () => {};
      };
      send();
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          ctl.close();
        } catch {
          /* уже закрыт */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
});
