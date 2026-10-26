import "server-only";
import { mediaByIds } from "./anilist";
import { db, now } from "./db";
import { env } from "./env";
import { anilistEpisodeFromTvdb } from "./idmap";
import { getMedia, getRows, logWatch, saveMedia, upsertEntry, withShikimori } from "./lists";
import { jellyfin } from "./stream";
import { onProgress } from "./together";

// Серии, досмотренные в Jellyfin (и скачанные, и онлайн через TorrServer), отмечаются в списке сами:
// серия TVDB → тайтл AniList (idmap) → отметка по общим правилам (lib/entry-rules.ts: «Смотрю»,
// «Пересматриваю», «Просмотрено»). Jellyfin считает серию просмотренной примерно после 90%.
// При первом запуске берём только последние сутки (jf_played_at), более старую историю не трогаем.

type JfEpisode = {
  Id: string; SeriesId?: string; ParentIndexNumber?: number; IndexNumber?: number; Path?: string;
  UserData?: { Played?: boolean; LastPlayedDate?: string };
};

const tvdbFromPath = (p?: string) => Number(/\[tvdbid-(\d+)\]/.exec(p ?? "")?.[1]) || null;

export async function syncJellyfinPlays(): Promise<void> {
  if (!env.jellyfinApiKey) return;
  const users = db.prepare<[], { id: number; name: string; jellyfin_id: string; jf_played_at: number | null }>(
    "SELECT id, name, jellyfin_id, jf_played_at FROM users").all();
  for (const u of users) {
    // Первый запуск: точка отсчёта — сутки назад
    if (u.jf_played_at === null) {
      u.jf_played_at = now() - 86400;
      db.prepare("UPDATE users SET jf_played_at = ? WHERE id = ?").run(u.jf_played_at, u.id);
    }
    const res = await jellyfin<{ Items: JfEpisode[] }>(
      `/Users/${u.jellyfin_id}/Items?IncludeItemTypes=Episode&Recursive=true&IsPlayed=true&SortBy=DatePlayed&SortOrder=Descending&Limit=100&Fields=Path&EnableUserData=true`);
    const fresh = res.Items
      .map((e) => ({ e, at: e.UserData?.LastPlayedDate ? Math.floor(Date.parse(e.UserData.LastPlayedDate) / 1000) : 0 }))
      .filter((x) => x.at > u.jf_played_at!)
      .sort((a, b) => a.at - b.at);
    if (!fresh.length) continue;

    // TVDB сериала: из пути ([tvdbid-X] у «Стрима»), иначе из ProviderIds сериала
    const needSeries = [...new Set(fresh.filter((x) => !tvdbFromPath(x.e.Path) && x.e.SeriesId).map((x) => x.e.SeriesId!))];
    const seriesTvdb = new Map<string, number>();
    if (needSeries.length) {
      const s = await jellyfin<{ Items: { Id: string; ProviderIds?: Record<string, string> }[] }>(
        `/Items?Ids=${needSeries.join(",")}&Fields=ProviderIds`);
      for (const it of s.Items) if (it.ProviderIds?.Tvdb) seriesTvdb.set(it.Id, Number(it.ProviderIds.Tvdb));
    }

    let marked = 0;
    for (const { e, at } of fresh) {
      const tvdb = tvdbFromPath(e.Path) ?? (e.SeriesId ? seriesTvdb.get(e.SeriesId) : undefined);
      if (!tvdb || e.ParentIndexNumber == null || !e.IndexNumber) continue;
      const hit = await anilistEpisodeFromTvdb(tvdb, e.ParentIndexNumber, e.IndexNumber).catch(() => null);
      if (!hit || hit.episode < 1) continue;
      let media = getMedia(hit.anilistId);
      if (!media) {
        saveMedia(await withShikimori(await mediaByIds([hit.anilistId])));
        media = getMedia(hit.anilistId);
      }
      if (!media) continue;
      const entry = getRows(u.id).find((r) => r.anilist_id === hit.anilistId && !r.deleted);
      // Уже отмечено дальше — не откатываем (кроме пересмотра просмотренного)
      const rewatch = entry?.status === "completed" && media.episodes && hit.episode < media.episodes;
      if (entry && entry.episodes >= hit.episode && !rewatch && entry.status !== "planned") continue;
      upsertEntry(u.id, media, { episodes: hit.episode });
      if (!rewatch) logWatch(u.id, media, entry && entry.status !== "planned" ? entry.episodes : 0, hit.episode);
      marked++;
      // Смотрели вместе на одном экране — засчитать друзьям (сессия) или подсказать (общий список)
      if (!rewatch) await onProgress(u, hit.anilistId, entry?.episodes ?? 0, hit.episode, "jellyfin").catch((e) => console.warn(`[jellyfin-sync] вместе: ${e}`));
      db.prepare("UPDATE users SET jf_played_at = ? WHERE id = ?").run(at, u.id);
    }
    db.prepare("UPDATE users SET jf_played_at = MAX(jf_played_at, ?) WHERE id = ?").run(fresh.at(-1)!.at, u.id);
    if (marked) console.log(`[jellyfin-sync] пользователь ${u.id}: отмечено серий ${marked}`);
  }
}
