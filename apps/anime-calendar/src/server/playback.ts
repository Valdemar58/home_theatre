import "server-only";
import fs from "node:fs";
import type { EpisodeItem } from "@/lib/playback";
import { env } from "./env";
import { mappingForAnilist } from "./idmap";
import { seriesByTvdb, sonarrEpisodes } from "./ru/arr";
import { guarded } from "./sources";
import { jellyfin, jellyfinSeries } from "./stream";

// Серии тайтла AniList в Jellyfin: сериал по TVDB (библиотека и «Стрим»), серия — по сезону и сдвигу из
// сопоставления; сквозная нумерация («a») — через номера Sonarr. Отсюда берут плеер, готовность серий и кадры.

export type JfEpisodeItem = EpisodeItem & {
  /** Серия «Стрима»: ссылка на поток TorrServer из .strm */
  strm?: string;
  runtimeSec?: number;
};

type JfEpisode = { Id: string; IndexNumber?: number; ParentIndexNumber?: number; Path?: string; RunTimeTicks?: number };

const TTL = 60_000;
const memo = new Map<number, { at: number; items: Map<number, JfEpisodeItem[]> }>();

/** Серии тайтла: номер AniList → элементы Jellyfin (кэш 1 мин). Нет ключа Jellyfin или сопоставления — пусто. */
export async function episodeItems(anilistId: number): Promise<Map<number, JfEpisodeItem[]>> {
  const hit = memo.get(anilistId);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const items = await load(anilistId);
  memo.set(anilistId, { at: Date.now(), items });
  return items;
}

/** Сбросить кэш (после «Смотреть» — новая папка «Стрима»). */
export const forgetEpisodeItems = (anilistId: number) => memo.delete(anilistId);

async function load(anilistId: number): Promise<Map<number, JfEpisodeItem[]>> {
  const out = new Map<number, JfEpisodeItem[]>();
  const m = env.jellyfinApiKey ? await mappingForAnilist(anilistId) : null;
  if (!m) return out;
  const series = (await guarded("jellyfin", () => jellyfinSeries()))
    .filter((s) => s.ProviderIds?.Tvdb === String(m.tvdb) || s.Path?.includes(`[tvdbid-${m.tvdb}]`));
  if (!series.length) return out;

  // Номер серии AniList по серии Jellyfin: сезон TVDB со сдвигом или сквозной номер Sonarr
  let toAnilist: (e: JfEpisode) => number | null;
  if (m.season === "a") {
    const s = env.sonarrApiKey ? await seriesByTvdb(m.tvdb).catch(() => undefined) : undefined;
    const abs = new Map((s ? await sonarrEpisodes(s.id).catch(() => []) : [])
      .filter((e) => e.absoluteEpisodeNumber)
      .map((e) => [`${e.seasonNumber}:${e.episodeNumber}`, e.absoluteEpisodeNumber!]));
    toAnilist = (e) => {
      const a = abs.get(`${e.ParentIndexNumber}:${e.IndexNumber}`);
      return a ? a - m.offset : null;
    };
  } else {
    toAnilist = (e) => (e.ParentIndexNumber === m.season && e.IndexNumber ? e.IndexNumber - m.offset : null);
  }

  for (const s of series) {
    const season = m.season === "a" ? "" : `&season=${m.season}`;
    const r = await guarded("jellyfin", () => jellyfin<{ Items: JfEpisode[] }>(`/Shows/${s.Id}/Episodes?Fields=Path${season}`)).catch(() => null);
    for (const e of r?.Items ?? []) {
      const ep = toAnilist(e);
      if (!ep || ep < 1) continue;
      const item: JfEpisodeItem = { itemId: e.Id, where: "library", runtimeSec: e.RunTimeTicks ? e.RunTimeTicks / 1e7 : undefined };
      // Серия «Стрима»: в .strm — ссылка на TorrServer (раздача и файл), файл виден и нам (та же папка)
      if (e.Path?.endsWith(".strm")) {
        const local = e.Path.replace(env.jellyfinStreamPath, env.streamDir);
        const url = fs.existsSync(local) ? fs.readFileSync(local, "utf-8").trim() : "";
        if (!url) continue;
        Object.assign(item, {
          where: "stream", strm: url,
          hash: /link=([0-9a-f]{40})/.exec(url)?.[1], index: Number(/[?&]index=(\d+)/.exec(url)?.[1]) || undefined,
        });
      }
      out.set(ep, [...(out.get(ep) ?? []), item]);
    }
  }
  return out;
}

/** Видео серии для ffmpeg: файл библиотеки — поток Jellyfin с ключом, серия «Стрима» — ссылка TorrServer. */
export async function episodeSource(anilistId: number, ep: number): Promise<{ url: string; headers: string } | null> {
  const items = (await episodeItems(anilistId)).get(ep) ?? [];
  const lib = items.find((i) => i.where === "library");
  if (lib) return { url: `${env.jellyfinUrl}/Videos/${lib.itemId}/stream?static=true`, headers: `Authorization: MediaBrowser Token="${env.jellyfinApiKey}"\r\n` };
  const strm = items.find((i) => i.strm);
  return strm ? { url: strm.strm!, headers: "" } : null;
}
