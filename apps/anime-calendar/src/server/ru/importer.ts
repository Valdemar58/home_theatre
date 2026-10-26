import "server-only";
import { getCached, setCached } from "../cache";
import { sonarrEpisodes, sonarrGet, sonarrPost } from "./arr";
import { assignEpisodes, localEpisode, refFromTitle } from "./episode";

// Помощник импорта: раздачи с RU-трекеров внутри называются как угодно
// («Slime S3 [01].avi»), и Sonarr не может понять, какая серия в каком файле.
// Для таких загрузок с нашего индексатора сами сопоставляем файлы с сериями
// и запускаем ручной импорт Sonarr через API.

export const INDEXER_NAME = "RU трекеры (anime-calendar)";

type QueueRecord = {
  id: number;
  seriesId: number;
  downloadId?: string;
  title: string;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title: string; messages: string[] }[];
  indexer?: string;
};

type HistoryRecord = { sourceTitle: string; quality: unknown; languages: unknown[]; eventType: string };

type ManualImportItem = {
  path: string;
  folderName?: string;
  name: string;
  size: number;
  quality: unknown;
  languages: unknown[];
  releaseGroup?: string;
  rejections?: { reason: string }[];
};

/** Загрузка закончилась, но Sonarr не смог импортировать её сам */
const stuck = (r: QueueRecord) =>
  r.status === "completed" &&
  (r.trackedDownloadState === "importBlocked" ||
    (r.trackedDownloadState === "importPending" && r.trackedDownloadStatus === "warning"));

async function importDownload(downloadId: string, seriesId: number): Promise<string> {
  const history = await sonarrGet<{ records: HistoryRecord[] }>(
    `/api/v3/history?page=1&pageSize=20&downloadId=${encodeURIComponent(downloadId)}`);
  const grabbed = history.records.find((h) => h.eventType === "grabbed");
  if (!grabbed) return "нет записи о скачивании в истории";
  const ref = refFromTitle(grabbed.sourceTitle);
  if (!ref) return `не разобрано название «${grabbed.sourceTitle}»`;

  const files = await sonarrGet<ManualImportItem[]>(
    `/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&seriesId=${seriesId}&filterExistingFiles=false`);
  const episodes = await sonarrEpisodes(seriesId);
  const locals = files.map((f) => localEpisode(f.name || f.path));
  const assigned = assignEpisodes(locals, ref);

  const used = new Set<number>();
  const toImport = [];
  const skipped: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const a = assigned[i];
    const ep = !a
      ? undefined
      : "absolute" in a
        ? episodes.find((e) => e.absoluteEpisodeNumber === a.absolute)
        : episodes.find((e) => e.seasonNumber === a.season && e.episodeNumber === a.episode);
    if (!ep || used.has(ep.id)) {
      skipped.push(files[i].name);
      continue;
    }
    used.add(ep.id);
    toImport.push({
      path: files[i].path,
      folderName: files[i].folderName,
      seriesId,
      episodeIds: [ep.id],
      // Качество берём из раздачи: в имени файла его часто нет (Sonarr решит, что это SDTV)
      quality: grabbed.quality,
      languages: grabbed.languages?.length ? grabbed.languages : files[i].languages,
      releaseGroup: files[i].releaseGroup ?? "",
      downloadId,
      indexerFlags: 0,
      releaseType: "singleEpisode",
    });
  }
  if (!toImport.length) return `не удалось сопоставить ни одного файла (${files.length} шт.)`;
  await sonarrPost("/api/v3/command", { name: "ManualImport", files: toImport, importMode: "auto" });
  return `импортировано ${toImport.length} файлов${skipped.length ? `, пропущено ${skipped.length}: ${skipped.slice(0, 3).join(", ")}` : ""}`;
}

/** Проверить очередь Sonarr и разобрать застрявшие загрузки с нашего индексатора. */
export async function runImportAssistant(): Promise<void> {
  const queue = await sonarrGet<{ records: QueueRecord[] }>("/api/v3/queue?page=1&pageSize=500");
  const done = new Set<string>();
  for (const r of queue.records) {
    if (!r.downloadId || done.has(r.downloadId) || r.indexer !== INDEXER_NAME || !stuck(r)) continue;
    done.add(r.downloadId);
    // Не повторяем попытку чаще раза в 30 минут: если не вышло, разбираться руками
    const key = `ru:import:${r.downloadId}`;
    if (getCached<string>(key)) continue;
    try {
      const result = await importDownload(r.downloadId, r.seriesId);
      setCached(key, result, 30 * 60);
      console.log(`[ru] импорт «${r.title}»: ${result}`);
    } catch (err) {
      setCached(key, String(err), 30 * 60);
      console.warn(`[ru] импорт «${r.title}»: ${String(err)}`);
    }
  }
}
