import "server-only";
import { mediaByIds } from "./anilist";
import { db, now } from "./db";
import { env } from "./env";
import { anilistEpisodeFromTvdb } from "./idmap";
import { getMedia, saveMedia, withShikimori } from "./lists";
import { jellyfin } from "./stream";
import { markEpisode } from "./watch-history";

// Серии, досмотренные в Jellyfin (и скачанные, и онлайн через TorrServer), отмечаются в списке сами:
// серия TVDB → тайтл AniList (idmap) → отметка по общим правилам (lib/entry-rules.ts: «Смотрю»,
// «Пересматриваю», «Просмотрено»). Jellyfin считает серию просмотренной примерно после 90%.
// При первом запуске берём только последние сутки (jf_played_at), более старую историю не трогаем.

type JfEpisode = {
  Id: string; SeriesId?: string; ParentIndexNumber?: number; IndexNumber?: number; Path?: string;
  UserData?: { Played?: boolean; LastPlayedDate?: string };
};

const tvdbFromPath = (p?: string) => Number(/\[tvdbid-(\d+)\]/.exec(p ?? "")?.[1]) || null;

type User = { id: number; name: string; jellyfin_id: string; jf_played_at: number | null };

// Пользователи, которых нет в Jellyfin (аккаунт удалён или это другая установка): в журнал — один раз
const missing = new Set<number>();

export async function syncJellyfinPlays(): Promise<void> {
  if (!env.jellyfinApiKey) return;
  const users = db.prepare<[], User>("SELECT id, name, jellyfin_id, jf_played_at FROM users").all();
  // Каждый пользователь отдельно: ошибка одного не останавливает остальных
  for (const u of users) {
    await syncUser(u).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 404/.test(msg)) {
        if (!missing.has(u.id)) console.warn(`[jellyfin-sync] пользователя ${u.id} (${u.name}) нет в Jellyfin — пропускаю`);
        missing.add(u.id);
        return;
      }
      console.warn(`[jellyfin-sync] пользователь ${u.id}: ${msg}`);
    });
  }
}

/**
 * Серия досмотрена (Jellyfin или плеер календаря) — отметить в списке по общим правилам. Уже отмечено дальше —
 * не откатывать (кроме пересмотра просмотренного). true — отметка изменилась.
 */
export async function markWatched(u: { id: number; name: string }, anilistId: number, episode: number, source: "jellyfin" | "player", key?: string): Promise<boolean> {
  let media = getMedia(anilistId);
  if (!media) {
    saveMedia(await withShikimori(await mediaByIds([anilistId])));
    media = getMedia(anilistId);
  }
  if (!media) return false;
  return markEpisode(u.id, anilistId, episode, source, key);
}

async function syncUser(u: User): Promise<void> {
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
  if (!fresh.length) return;

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
    if (db.prepare("SELECT key FROM watch_sync_receipts WHERE key=?").get(`jellyfin:${u.id}:${e.Id}:${at}`)) continue;
    const tvdb = tvdbFromPath(e.Path) ?? (e.SeriesId ? seriesTvdb.get(e.SeriesId) : undefined);
    if (!tvdb || e.ParentIndexNumber == null || !e.IndexNumber) continue;
    const hit = await anilistEpisodeFromTvdb(tvdb, e.ParentIndexNumber, e.IndexNumber).catch(() => null);
    if (!hit || hit.episode < 1) continue;
    if (await markWatched(u, hit.anilistId, hit.episode, "jellyfin", `jellyfin:${u.id}:${e.Id}:${at}`)) marked++;
    db.prepare("UPDATE users SET jf_played_at = ? WHERE id = ?").run(at, u.id);
  }
  db.prepare("UPDATE users SET jf_played_at = GREATEST(jf_played_at, ?) WHERE id = ?").run(fresh.at(-1)!.at, u.id);
  if (marked) console.log(`[jellyfin-sync] пользователь ${u.id}: отмечено серий ${marked}`);
}
