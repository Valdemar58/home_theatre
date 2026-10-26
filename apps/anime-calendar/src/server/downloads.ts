import "server-only";
import { env } from "./env";
import { sonarrDelete, sonarrGet } from "./ru/arr";
import { jellyfinSeries, linksFor } from "./stream";

// Очередь загрузок Sonarr (qBittorrent): прогресс, ошибки, отмена.

type QueueRecord = {
  id: number; title: string; size: number; sizeleft: number; timeleft?: string; status: string;
  trackedDownloadState?: string; trackedDownloadStatus?: string; errorMessage?: string;
  statusMessages?: { title: string; messages: string[] }[]; downloadClient?: string; added?: string;
  series?: { title: string; tvdbId: number; images?: { coverType: string; remoteUrl?: string }[] };
  episode?: { seasonNumber: number; episodeNumber: number; title?: string };
};

export type QueueItem = {
  id: number;
  title: string;
  series: string | null;
  poster: string | null;
  episode: string | null;
  size: number;
  done: number;
  timeleft: string | null;
  state: string;
  /** Что-то не так: текст ошибки/предупреждения */
  problem: string | null;
  client: string | null;
  addedAt: number | null;
  anilistId: number | null;
  /** Сериал уже есть в Jellyfin (скачанные серии) */
  jellyfinUrl: string | null;
};

const STATE_RU: Record<string, string> = {
  downloading: "Загружается",
  importPending: "Ждёт импорта",
  importing: "Импорт",
  imported: "Импортировано",
  failedPending: "Ошибка",
  failed: "Ошибка",
  ignored: "Пропущено",
  queued: "В очереди",
  paused: "Пауза",
  completed: "Скачано",
  delay: "Отложено",
  warning: "Проблема",
};

const RU_ERRORS: [RegExp, string][] = [
  [/missing files/i, "qBittorrent не находит файлы раздачи (например, после переезда) — нужна перепроверка или удаление"],
  [/stalled/i, "Нет сидов — загрузка стоит"],
];

export async function listQueue(): Promise<QueueItem[]> {
  if (!env.sonarrApiKey) return [];
  const q = await sonarrGet<{ records: QueueRecord[] }>("/api/v3/queue?pageSize=200&includeSeries=true&includeEpisode=true");
  const jf = await jellyfinSeries().catch(() => []);
  return Promise.all(q.records.map(async (r) => {
    const raw = r.errorMessage || r.statusMessages?.flatMap((m) => m.messages).join("; ") || null;
    const problem = raw ? (RU_ERRORS.find(([re]) => re.test(raw))?.[1] ?? raw) : null;
    const state = r.status === "warning" || problem ? "warning" : (r.trackedDownloadState ?? r.status);
    return {
      id: r.id,
      title: r.title,
      series: r.series?.title ?? null,
      poster: r.series?.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? null,
      episode: r.episode ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")}` : null,
      size: r.size,
      done: Math.max(0, r.size - r.sizeleft),
      timeleft: r.timeleft ?? null,
      state: STATE_RU[state] ?? state,
      problem,
      client: r.downloadClient ?? null,
      addedAt: r.added ? Math.floor(Date.parse(r.added) / 1000) : null,
      ...(await linksFor(r.series?.tvdbId ?? null, r.episode?.seasonNumber ?? 1, jf, "library", r.episode?.episodeNumber)),
    };
  }));
}

/** Отменить загрузку: убрать из очереди Sonarr и из qBittorrent (вместе со скачанным). */
export async function removeFromQueue(id: number, blocklist: boolean): Promise<void> {
  await sonarrDelete(`/api/v3/queue/${id}?removeFromClient=true&blocklist=${blocklist}&skipRedownload=true`);
}
