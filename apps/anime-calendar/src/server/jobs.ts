import "server-only";
import { fetchRange, monthGrid } from "@/lib/schedule";
import { getCalendar } from "./anilist";
import { purgeExpired } from "./cache";
import { ensureIdMap } from "./idmap";
import { refreshListMedia, withShikimori } from "./lists";
import { env } from "./env";
import { runImportAssistant } from "./ru/importer";
import { cleanupStreams } from "./stream";
import { syncAll } from "./sync";
import { syncAllLib } from "./anilib";
import { cleanupImages } from "./img-cache";
import { maybeRebuildAtlas } from "./reco/atlas";
import { warmReference } from "./reco/card";
import { scheduleVoices } from "./tasks";
import { prefetchWhileWatching } from "./prebuffer";
import { syncJellyfinPlays } from "./jellyfin-sync";
import { translateTags } from "./tags-ru";
import { checkNewEpisodes } from "./episode-notices";

const MINUTE = 60_000;

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[jobs] ${name}: ${String(err)}`);
  }
}

/** Прогрев кэша: текущий и следующий месяц, чтобы календарь открывался мгновенно. */
async function prewarm() {
  const d = new Date();
  for (const offset of [0, 1]) {
    const grid = monthGrid(d.getUTCFullYear(), d.getUTCMonth() + offset);
    const { from, to } = fetchRange(grid[0].key, grid.at(-1)!.key);
    const cal = await getCalendar(from, to);
    await withShikimori(Object.values(cal.media));
  }
}

let started = false;

export function startJobs() {
  if (started) return;
  started = true;
  setTimeout(() => {
    void safe("idmap", ensureIdMap);
    void safe("prewarm", prewarm);
  }, 5000);
  setInterval(() => void safe("prewarm", prewarm), 60 * MINUTE);
  // Помощник импорта раздач с RU-трекеров (если календарь подключён к Sonarr)
  if (env.sonarrApiKey) setInterval(() => void safe("ru-import", runImportAssistant), 2 * MINUTE);
  // Озвучки онгоингов из моих списков: раз в сутки, по 5 тайтлов за проход (уведомление о новых раздачах)
  if (env.sonarrApiKey && env.prowlarrApiKey) setInterval(() => void safe("voices", () => scheduleVoices()), 30 * MINUTE);
  // Досмотренные в Jellyfin серии — отметить в списке (автостатус по тем же правилам)
  if (env.jellyfinApiKey) {
    setTimeout(() => void safe("jellyfin-plays", syncJellyfinPlays), MINUTE);
    setInterval(() => void safe("jellyfin-plays", syncJellyfinPlays), 5 * MINUTE);
  }
  // Смотрят серию из «Стрима» — заранее готовим следующую
  if (env.jellyfinApiKey) setInterval(() => void safe("prefetch-next", prefetchWhileWatching), 30_000);
  // Уборка стриминга: .strm скачанных серий и раздачи TorrServer без ссылок
  if (env.jellyfinApiKey) setInterval(() => void safe("stream-cleanup", () => cleanupStreams()), 30 * MINUTE);
  setInterval(async () => {
    await safe("lists-media", () => refreshListMedia());
    await safe("shikimori-sync", syncAll);
  }, 15 * MINUTE);
  // Новые серии тайтлов из «Смотрю» и «Жду выхода» — уведомления
  setTimeout(() => void safe("episode-notices", checkNewEpisodes), 2 * MINUTE);
  setInterval(() => void safe("episode-notices", checkNewEpisodes), 10 * MINUTE);
  // AniLib: только у тех, кто подтвердил первый импорт; оценки меняются без updated_at — каждый раз весь список
  setInterval(() => void safe("anilib-sync", syncAllLib), 30 * MINUTE);
  // Кэш картинок: поэтапная очистка (копии 14 дн, оригиналы 90 дн, потолок 5 ГБ)
  setInterval(() => void safe("img-cleanup", cleanupImages), 6 * 60 * MINUTE);
  // Нейтральная выборка для прогноза «насколько понравится» (500 популярных; кэш на неделю)
  setTimeout(() => void safe("reference", warmReference), 30_000);
  setInterval(() => void safe("reference", warmReference), 24 * 60 * MINUTE);
  // Русские названия тегов AniList (LLM, один раз; дальше — только новые теги)
  setTimeout(() => void safe("tags-ru", translateTags), 2 * MINUTE);
  // Карта тайтлов: собрать, если её нет; пересобрать раз в неделю или когда в списках много новых тайтлов
  setTimeout(() => void safe("atlas", async () => maybeRebuildAtlas()), 5 * MINUTE);
  setInterval(() => void safe("atlas", async () => maybeRebuildAtlas()), 6 * 60 * MINUTE);
  setInterval(() => {
    void safe("tags-ru", translateTags);
    void safe("idmap", ensureIdMap);
    purgeExpired();
  }, 24 * 60 * MINUTE);
}
