import "server-only";
import { ewma, readiness } from "@/lib/buffer";
import { env } from "./env";
import { db } from "./db";
import { jellyfinNowPlaying, listStreams, strmEpisodes, streamAnilistId, streamMinutes, torrentFile } from "./stream";
import { registerHandler, startTask } from "./tasks";

// «Подготовить серию»: фоновая задача читает серию из TorrServer с начала — так же, как читал бы
// Jellyfin, — и TorrServer складывает её в дисковый кэш. По сглаженной скорости считаем, когда
// можно включать и досмотреть без остановок (lib/buffer.ts), и шлём уведомление.
// Ключ задачи: «<хэш>:<индекс файла>».
//
// Следующая серия готовится сама, на одну вперёд (весь сезон не выкачиваем):
//  • по цепочке — серию подготовили по кнопке, после неё берётся следующая;
//  • по просмотру — раз в 30 с смотрим, что играет в Jellyfin из «Стрима», и готовим следующую.

export type PrebufferProgress = {
  key: string;
  hash: string;
  index: number;
  code: string;
  size: number;
  read: number;
  /** Сглаженная скорость, байт/с */
  speed: number;
  /** Сколько байт/с тратит просмотр */
  rate: number;
  ready: boolean;
  etaSec: number | null;
  readyAt: number | null;
  done: boolean;
  updatedAt: number;
};

const progress = new Map<string, PrebufferProgress>();
const KEEP_MS = 3 * 3600_000;

/** Прогресс подготовки (для страницы «Загрузки»); завершённые держим 3 ч. */
export function prebufferProgress(): PrebufferProgress[] {
  const now = Date.now();
  for (const [k, p] of progress) if (now - p.updatedAt > KEEP_MS) progress.delete(k);
  return [...progress.values()];
}

const SAMPLE_MS = 2000;
registerHandler("prebuffer", {
  noun: "Серия готова",
  anilistId: (key) => streamAnilistId(key.split(":")[0]),
  title: async (key) => {
    const [hash, idx] = key.split(":");
    const ep = strmEpisodes(hash).find((e) => e.index === Number(idx));
    const file = await torrentFile(hash, Number(idx)).catch(() => null);
    return `${file?.title ?? "раздача"} ${ep?.code ?? `#${idx}`}`;
  },
  fresh: () => false,
  href: () => "/downloads",
  run: async (key, signal, ctx) => {
    const [hash, idx] = key.split(":");
    const index = Number(idx);
    const file = await torrentFile(hash, index);
    if (!file) throw new Error("файл не найден в раздаче");
    const code = strmEpisodes(hash).find((e) => e.index === index)?.code ?? `#${index}`;
    const rate = file.length / ((await streamMinutes(hash)) * 60);
    const p: PrebufferProgress = {
      key, hash, index, code, size: file.length, read: 0, speed: 0, rate,
      ready: false, etaSec: null, readyAt: null, done: false, updatedAt: Date.now(),
    };
    progress.set(key, p);
    // Отменили — прогресс больше не показываем (в кэше TorrServer прочитанное остаётся)
    signal.addEventListener("abort", () => progress.delete(key));

    const res = await fetch(`${env.torrserverUrl}/stream/${encodeURIComponent(file.path.split("/").pop()!)}?link=${hash}&index=${index}&play`, { signal });
    if (!res.ok || !res.body) throw new Error(`TorrServer: HTTP ${res.status}`);
    const reader = res.body.getReader();
    let speed: number | null = null;
    let lastAt = Date.now();
    let lastRead = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        p.read += value.byteLength;
        const now = Date.now();
        if (now - lastAt >= SAMPLE_MS) {
          speed = ewma(speed, ((p.read - lastRead) * 1000) / (now - lastAt));
          lastAt = now;
          lastRead = p.read;
          const r = readiness({ size: p.size, read: p.read, speed, rate });
          Object.assign(p, { speed, ready: r.ready, etaSec: r.etaSec, updatedAt: now });
          if (r.ready && !p.readyAt) {
            p.readyAt = now;
            ctx.notify(`${code}: можно включать — при текущей скорости досмотрите без остановок`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    Object.assign(p, { done: p.read >= p.size, ready: true, etaSec: 0, updatedAt: Date.now() });
    // Подготовили по кнопке — следом следующую (она уже не тянет за собой дальше)
    if (ctx.origin === "user") await prepareNext(hash, index, ctx.userIds);
    if (!p.readyAt) ctx.notify(`${code}: серия целиком в кэше — смотрите без остановок`);
    p.readyAt ??= Date.now();
    return { summary: `${code}: серия целиком в кэше`, isNew: false, silent: true };
  },
});

/** Серия, следующая за index в этой раздаче (по коду S01E05 → S01E06). */
function nextIndex(hash: string, index: number): number | null {
  const eps = strmEpisodes(hash);
  const i = eps.findIndex((e) => e.index === index);
  return i >= 0 && i + 1 < eps.length ? eps[i + 1].index : null;
}

/** Поставить подготовку следующей серии (если она ещё не готовится и не готова). Уведомит, когда можно включать. */
async function prepareNext(hash: string, index: number, userIds: number[]) {
  const next = nextIndex(hash, index);
  if (next === null) return;
  const key = `${hash}:${next}`;
  if (progress.get(key)?.done) return;
  for (const userId of userIds.length ? userIds : [undefined]) {
    await startTask("prebuffer", key, { origin: "auto", userId, notify: true }).catch((e) => console.warn(`[prebuffer] ${key}: ${String(e)}`));
  }
}

/**
 * Что сейчас смотрят из «Стрима» (Jellyfin и плеер календаря — player) — готовим следующую серию (раз в 30 с из jobs.ts).
 * Только когда это не отнимет скорость у текущей: она уже целиком в кэше или раздача качает
 * минимум вдвое быстрее, чем нужно для просмотра.
 */
export async function prefetchWhileWatching(player: { hash: string; index: number; userId: number }[] = []) {
  const jf = await jellyfinNowPlaying().catch(() => []);
  const playing = [
    ...jf.map(({ hash, index, jellyfinUserId }) => {
      const id = jellyfinUserId.replace(/-/g, "").toLowerCase();
      const user = db.prepare<[string], { id: number }>("SELECT id FROM users WHERE lower(replace(jellyfin_id, '-', '')) = ?").get(id);
      return { hash, index, userId: user?.id };
    }),
    ...player,
  ];
  if (!playing.length) return;
  const streams = await listStreams();
  for (const { hash, index, userId } of playing) {
    const s = streams.find((x) => x.hash === hash);
    const cached = progress.get(`${hash}:${index}`)?.done;
    if (!cached && !(s?.rate && s.speed >= 2 * s.rate)) continue;
    await prepareNext(hash, index, userId ? [userId] : []);
  }
}
