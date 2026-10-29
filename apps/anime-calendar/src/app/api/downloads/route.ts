import { listQueue } from "@/server/downloads";
import { prebufferProgress } from "@/server/prebuffer";
import { prepSummary } from "@/server/prep";
import { authed, json } from "@/server/route";
import { listStreams } from "@/server/stream";
import { activeTasks } from "@/server/tasks";

/** Страница «Загрузки»: онлайн-просмотр (TorrServer) и очередь Sonarr. Источник недоступен — пустой список и ошибка. */
export const GET = authed(async () => {
  const [streams, queue] = await Promise.allSettled([listStreams(), listQueue()]);
  return json({
    streams: streams.status === "fulfilled" ? streams.value : [],
    streamsError: streams.status === "rejected" ? String(streams.reason) : null,
    queue: queue.status === "fulfilled" ? queue.value : [],
    queueError: queue.status === "rejected" ? String(queue.reason) : null,
    // Подготовка серий: прогресс и задачи в очереди (ключ — «хэш:индекс»)
    prebuffer: prebufferProgress(),
    // Скачанные серии «Стрима» (qBittorrent): сколько и сколько места из лимита
    prep: prepSummary(),
    prebufferQueued: activeTasks("prebuffer").map((t) => t.key),
  });
});
