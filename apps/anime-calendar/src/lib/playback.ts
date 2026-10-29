// Готовность серий к просмотру (правила без базы и сети — для сервера, клиента и тестов).
// Источники по порядку: файл в библиотеке Jellyfin → серия «Стрима» (TorrServer, с подготовкой буфера) →
// загрузка в Sonarr → вышла, но взять неоткуда → ещё не вышла.

export type EpisodeState = "library" | "stream" | "downloading" | "aired" | "upcoming";

export type EpisodeStatus = {
  ep: number;
  state: EpisodeState;
  /** Серия в Jellyfin (библиотека или «Стрим») — её и играет плеер */
  itemId?: string;
  /** Стрим: раздача и файл в TorrServer (для «Подготовить») */
  hash?: string;
  index?: number;
  /** Стрим: буфера хватит досмотреть без остановок; загрузка/буферизация — доля и сколько ждать */
  ready?: boolean;
  preparing?: boolean;
  pct?: number;
  etaSec?: number | null;
  /** Стрим: какая доля файла уже лежит в кэше TorrServer (0–1) */
  cached?: number;
  /** Серия скачана целиком (qBittorrent) — отдаётся с диска */
  downloaded?: boolean;
};

/** Кэш раздачи TorrServer: сколько занято из ёмкости (ёмкость — на каждую раздачу). */
export type TorrentCache = { hash: string; title: string; filled: number; capacity: number; active: boolean };

export type EpisodeItem = { itemId: string; where: "library" | "stream"; hash?: string; index?: number };
export type BufferInfo = { ready: boolean; etaSec: number | null; read: number; size: number; done: boolean };
export type QueueInfo = { pct: number; etaSec: number | null };

/** Состояние каждой серии 1..total. aired — сколько вышло (null — неизвестно: вышедшими считаем те, что есть). */
export function episodeStates(input: {
  total: number;
  aired: number | null;
  items: Map<number, EpisodeItem[]>;
  buffers: Map<string, BufferInfo>;
  queue: Map<number, QueueInfo>;
}): EpisodeStatus[] {
  const out: EpisodeStatus[] = [];
  for (let ep = 1; ep <= input.total; ep++) {
    const items = input.items.get(ep) ?? [];
    const lib = items.find((i) => i.where === "library");
    const strm = items.find((i) => i.where === "stream");
    if (lib) {
      out.push({ ep, state: "library", itemId: lib.itemId });
      continue;
    }
    if (strm) {
      const b = strm.hash ? input.buffers.get(`${strm.hash}:${strm.index}`) : undefined;
      out.push({
        ep, state: "stream", itemId: strm.itemId, hash: strm.hash, index: strm.index,
        ready: Boolean(b?.ready || b?.done), preparing: Boolean(b && !b.done),
        pct: b?.size ? Math.min(1, b.read / b.size) : undefined, etaSec: b?.etaSec ?? null,
      });
      continue;
    }
    const q = input.queue.get(ep);
    if (q) {
      out.push({ ep, state: "downloading", pct: q.pct, etaSec: q.etaSec });
      continue;
    }
    out.push({ ep, state: input.aired === null || ep <= input.aired ? "aired" : "upcoming" });
  }
  return out;
}

export const playable = (s: EpisodeStatus) => s.state === "library" || s.state === "stream";

/**
 * Какую серию предложить кнопке «Смотреть»: следующую после просмотренных; всё просмотрено — первую
 * (пересмотр). null — серий нет совсем.
 */
export function watchTarget(statuses: EpisodeStatus[], watched: number): EpisodeStatus | null {
  if (!statuses.length) return null;
  const next = statuses.find((s) => s.ep > watched && s.state !== "upcoming");
  return next ?? (watched >= statuses.length ? statuses[0] : null);
}

/** Сколько ждать: «40 с», «3 мин», «1 ч 5 мин». */
export function waitText(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} с`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const m = Math.round((sec % 3600) / 60);
  return `${Math.floor(sec / 3600)} ч${m ? ` ${m} мин` : ""}`;
}

/** Самая дальняя серия, которую можно смотреть, — для уведомления «можно смотреть». */
export const lastPlayable = (statuses: EpisodeStatus[]) => statuses.reduce((n, s) => (playable(s) ? s.ep : n), 0);
