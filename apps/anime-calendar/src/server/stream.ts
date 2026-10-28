import "server-only";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { anilistForTvdb, mappingForAnilist } from "./idmap";
import { sonarrEpisodes, sonarrGet, type ProwlarrRelease } from "./ru/arr";
import { assignEpisodes, localEpisode } from "./ru/episode";
import type { EpisodeRefLike } from "./ru/title";

// «Смотреть сейчас»: раздача добавляется в TorrServer, а в библиотеку Jellyfin «Стрим»
// кладутся .strm-файлы со ссылками на поток. Jellyfin сам транскодирует (NVENC),
// дорожки внутри mkv выбираются в плеере. Внешние .mka при стриминге недоступны.

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm)$/i;
// Спешлы и бонусы в отдельных папках нумеруются заново и путают сопоставление
const EXTRAS = /(^|\/)(specials?|sp|extras?|bonus|ova|nced|ncop|menus?|trailers?)(\/|$)/i;

type TsFile = { id: number; path: string; length: number };
type TsTorrent = { hash: string; title: string; file_stats?: TsFile[]; timestamp?: number };

async function ts<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.torrserverUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`TorrServer ${pathname}: HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Скачать .torrent через Prowlarr (у него есть вход на трекер) и загрузить в TorrServer. */
async function addTorrent(release: ProwlarrRelease, title: string, poster: string | null): Promise<TsTorrent> {
  if (!release.downloadUrl) throw new Error("У раздачи нет ссылки на .torrent");
  const torrent = await fetch(release.downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!torrent.ok) throw new Error(`Не удалось скачать .torrent: HTTP ${torrent.status}`);
  const form = new FormData();
  form.append("save", "true");
  form.append("title", title);
  if (poster) form.append("poster", poster);
  form.append("file", new Blob([await torrent.arrayBuffer()], { type: "application/x-bittorrent" }), "release.torrent");
  const res = await fetch(`${env.torrserverUrl}/torrent/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`TorrServer upload: HTTP ${res.status}`);
  return (await res.json()) as TsTorrent;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

export type StreamResult = { episodes: number; skipped: number; folder: string };

/**
 * Создать .strm-ссылки на серии раздачи. ref — какие серии в нумерации TVDB
 * (тот же расчёт, что для Sonarr), seriesTitle/tvdb — для папки сериала в Jellyfin.
 */
export async function streamRelease(opts: {
  anilistId: number;
  release: ProwlarrRelease;
  ref: EpisodeRefLike;
  seriesTitle: string;
  year: number | null;
  poster: string | null;
}): Promise<StreamResult> {
  const mapping = await mappingForAnilist(opts.anilistId);
  if (!mapping) throw new Error("Тайтл не сопоставлен с TVDB");
  const torrent = await addTorrent(opts.release, opts.seriesTitle, opts.poster);
  const files = (torrent.file_stats ?? []).filter((f) => VIDEO.test(f.path) && !EXTRAS.test(f.path));
  if (!files.length) throw new Error("В раздаче не найдено видеофайлов");

  // Абсолютная нумерация (длинные сериалы): переводим через эпизоды Sonarr
  let absolute: Map<number, { season: number; episode: number }> | null = null;
  if (opts.ref.kind === "absolute") {
    const series = (await sonarrGet<{ id: number; tvdbId: number }[]>("/api/v3/series")).find((s) => s.tvdbId === mapping.tvdb);
    if (!series) throw new Error("Для сериалов со сквозной нумерацией сначала добавь сериал в Sonarr (кнопка «Скачать»)");
    absolute = new Map((await sonarrEpisodes(series.id))
      .filter((e) => e.absoluteEpisodeNumber)
      .map((e) => [e.absoluteEpisodeNumber!, { season: e.seasonNumber, episode: e.episodeNumber }]));
  }

  const name = safe(opts.seriesTitle);
  const folder = path.join(env.streamDir, `${name}${opts.year ? ` (${opts.year})` : ""} [tvdbid-${mapping.tvdb}]`);
  const assigned = assignEpisodes(files.map((f) => localEpisode(f.path)), opts.ref);
  let created = 0;
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const a = assigned[i];
    const target = !a ? null : "absolute" in a ? absolute?.get(a.absolute) ?? null : a;
    if (!target) {
      skipped++;
      continue;
    }
    const dir = path.join(folder, `Season ${pad(target.season)}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name} - S${pad(target.season)}E${pad(target.episode)}.strm`);
    const url = `${env.torrserverInternalUrl}/stream/${encodeURIComponent(path.basename(files[i].path))}?link=${torrent.hash}&index=${files[i].id}&play`;
    fs.writeFileSync(file, url + "\n");
    created++;
  }
  await refreshJellyfin(path.basename(folder)).catch((e) => console.warn(`[stream] обновление Jellyfin: ${String(e)}`));
  return { episodes: created, skipped, folder: path.basename(folder) };
}

// ---------------------------------------------------------------- Jellyfin

export async function jellyfin<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.jellyfinUrl}${pathname}`, {
    ...init,
    // Jellyfin 12 принимает ключ только в заголовке Authorization (X-Emby-Token и ?api_key больше не работают)
    headers: { Authorization: `MediaBrowser Token="${env.jellyfinApiKey}"`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jellyfin ${pathname}: HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function streamLibraryId(): Promise<string | null> {
  const libs = await jellyfin<{ Name: string; ItemId: string; Locations: string[] }[]>("/Library/VirtualFolders");
  return libs.find((l) => l.Locations.some((p) => p.replace(/\/+$/, "").endsWith("/stream")))?.ItemId ?? null;
}

/**
 * Сообщить Jellyfin о новой/изменённой папке сериала (точечное сканирование).
 * Обновление самой библиотеки (/Items/{id}/Refresh) новые папки не находит.
 */
async function refreshJellyfin(folder?: string) {
  if (!env.jellyfinApiKey) return;
  if (!folder) {
    await jellyfin("/Library/Refresh", { method: "POST" });
    return;
  }
  await jellyfin("/Library/Media/Updated", {
    method: "POST",
    body: JSON.stringify({ Updates: [{ Path: `${env.jellyfinStreamPath}/${folder}`, UpdateType: "Created" }] }),
  });
}

/** Ссылка на сериал в библиотеке «Стрим», когда Jellyfin его отсканировал. */
export async function streamSeriesUrl(tvdb: number): Promise<string | null> {
  if (!env.jellyfinApiKey) return null;
  const lib = await streamLibraryId();
  if (!lib) return null;
  const items = await jellyfin<{ Items: { Id: string; Path?: string }[] }>(
    `/Items?ParentId=${lib}&IncludeItemTypes=Series&Recursive=true&Fields=Path`);
  const item = items.Items.find((i) => i.Path?.includes(`[tvdbid-${tvdb}]`));
  return item ? `${env.jellyfinPublicUrl}/web/#/details?id=${item.Id}` : null;
}

// ---------------------------------------------------------------- уборка

/** Удалить .strm серий, которые Sonarr уже скачал, и раздачи TorrServer без ссылок. */
export async function cleanupStreams(maxAgeDays = 14): Promise<void> {
  if (!fs.existsSync(env.streamDir)) return;
  const series = env.sonarrApiKey ? await sonarrGet<{ id: number; tvdbId: number }[]>("/api/v3/series").catch(() => []) : [];
  const usedHashes = new Set<string>();
  for (const dir of fs.readdirSync(env.streamDir)) {
    const tvdb = Number(/\[tvdbid-(\d+)\]/.exec(dir)?.[1]);
    const s = series.find((x) => x.tvdbId === tvdb);
    const downloaded = new Set<string>();
    if (s) {
      const eps = await sonarrGet<{ seasonNumber: number; episodeNumber: number; hasFile: boolean }[]>(
        `/api/v3/episode?seriesId=${s.id}`).catch(() => []);
      for (const e of eps) if (e.hasFile) downloaded.add(`S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`);
    }
    const root = path.join(env.streamDir, dir);
    for (const season of fs.readdirSync(root)) {
      const sdir = path.join(root, season);
      if (!fs.statSync(sdir).isDirectory()) continue;
      for (const f of fs.readdirSync(sdir)) {
        const file = path.join(sdir, f);
        const code = /S\d{2}E\d{2,4}/.exec(f)?.[0];
        const old = Date.now() - fs.statSync(file).mtimeMs > maxAgeDays * 86400_000;
        if ((code && downloaded.has(code)) || old) {
          fs.rmSync(file);
          continue;
        }
        const hash = /link=([0-9a-f]{40})/.exec(fs.readFileSync(file, "utf-8"))?.[1];
        if (hash) usedHashes.add(hash);
      }
      if (!fs.readdirSync(sdir).length) fs.rmdirSync(sdir);
    }
    if (!fs.readdirSync(root).length) fs.rmdirSync(root);
  }
  // Раздачи TorrServer, на которые больше нет ссылок
  const list = await ts<TsTorrent[]>("/torrents", { action: "list" }).catch(() => []);
  for (const t of list) if (!usedHashes.has(t.hash)) await ts("/torrents", { action: "rem", hash: t.hash }).catch(() => undefined);
  await refreshJellyfin().catch(() => undefined);
}

// ---------------------------------------------------------------- страница «Загрузки»

type TsStats = TsTorrent & {
  poster?: string; stat_string?: string; torrent_size?: number; preloaded_bytes?: number; loaded_size?: number;
  download_speed?: number; active_peers?: number; total_peers?: number; connected_seeders?: number;
};

export type StreamItem = {
  hash: string;
  title: string;
  poster: string | null;
  state: string;
  size: number;
  /** Сколько уже в кэше TorrServer (он качает куски под просмотр, а не всё) */
  cached: number;
  speed: number;
  peers: number;
  seeders: number;
  addedAt: number | null;
  /** Папка в библиотеке «Стрим» и число серий-ссылок */
  folder: string | null;
  episodes: number;
  anilistId: number | null;
  jellyfinUrl: string | null;
  /** Сколько байт/с нужно для просмотра без остановок (средняя серия; только у активных раздач) */
  rate: number | null;
  /** Серии в библиотеке «Стрим» (для «Подготовить серию») */
  files: StrmEpisode[];
};

/** .strm-файлы по хэшу раздачи: папка сериала → файлы. */
function strmByHash(): Map<string, { folder: string; season: number; files: string[] }> {
  const out = new Map<string, { folder: string; season: number; files: string[] }>();
  if (!fs.existsSync(env.streamDir)) return out;
  for (const dir of fs.readdirSync(env.streamDir)) {
    const root = path.join(env.streamDir, dir);
    if (!fs.statSync(root).isDirectory()) continue;
    for (const season of fs.readdirSync(root)) {
      const sdir = path.join(root, season);
      if (!fs.statSync(sdir).isDirectory()) continue;
      for (const f of fs.readdirSync(sdir)) {
        const file = path.join(sdir, f);
        const hash = /link=([0-9a-f]{40})/.exec(fs.readFileSync(file, "utf-8"))?.[1];
        if (!hash) continue;
        const e = out.get(hash) ?? { folder: dir, season: Number(/\d+/.exec(season)?.[0] ?? 1), files: [] };
        e.files.push(file);
        out.set(hash, e);
      }
    }
  }
  return out;
}

export const STATE_RU: Record<string, string> = {
  "Torrent added": "Добавлена",
  "Torrent getting info": "Получаю данные",
  "Torrent preload": "Буферизация",
  "Torrent working": "Раздаётся",
  "Torrent closed": "Остановлена",
  "Torrent in db": "Не активна",
};

/** Раздачи TorrServer (онлайн-просмотр) со статистикой. */
export async function listStreams(): Promise<StreamItem[]> {
  const list = await ts<(TsStats & { stat?: number })[]>("/torrents", { action: "list" });
  const links = strmByHash();
  const jf = await jellyfinSeries().catch(() => []);
  const items = await Promise.all(list.map(async (t) => {
    // «get» будит раздачу в TorrServer (начинает качать) — подробности спрашиваем только у уже активных
    // (stat: 1 — получаю данные, 2 — буферизация, 3 — работает; 5 — лежит в базе)
    const active = t.stat !== undefined && t.stat >= 1 && t.stat <= 3;
    const g = active ? await ts<TsStats>("/torrents", { action: "get", hash: t.hash }).catch(() => t) : t;
    const l = links.get(t.hash);
    return {
      hash: t.hash,
      title: g.title || t.title,
      poster: g.poster || null,
      state: STATE_RU[g.stat_string ?? ""] ?? g.stat_string ?? "—",
      size: g.torrent_size ?? 0,
      cached: g.preloaded_bytes ?? g.loaded_size ?? 0,
      speed: g.download_speed ?? 0,
      peers: g.active_peers ?? 0,
      seeders: g.connected_seeders ?? 0,
      addedAt: g.timestamp ?? t.timestamp ?? null,
      folder: l?.folder ?? null,
      episodes: l?.files.length ?? 0,
      ...(await linksFor(l ? Number(/\[tvdbid-(\d+)\]/.exec(l.folder)?.[1]) || null : null, l?.season ?? 1, jf, "stream")),
      rate: active ? playbackRate((g as TsTorrent).file_stats, await streamMinutes(t.hash)) : null,
      files: strmEpisodes(t.hash),
    } satisfies StreamItem;
  }));
  return items.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

/** Раздача серии сейчас (для плеера): состояние, скорость, пиры, размер файла. Будит раздачу — только для играющей серии. */
export async function torrentStats(hash: string, index: number) {
  const t = await ts<TsStats>("/torrents", { action: "get", hash });
  return {
    state: STATE_RU[t.stat_string ?? ""] ?? t.stat_string ?? "—",
    speed: t.download_speed ?? 0,
    peers: t.active_peers ?? 0,
    seeders: t.connected_seeders ?? 0,
    totalPeers: t.total_peers ?? 0,
    fileSize: t.file_stats?.find((f) => f.id === index)?.length ?? null,
  };
}

/** Нужная для просмотра скорость: средний размер видеофайла ÷ длительность серии. */
export function playbackRate(files: { path: string; length: number }[] | undefined, minutes: number): number | null {
  const video = (files ?? []).filter((f) => VIDEO.test(f.path) && !EXTRAS.test(f.path));
  if (!video.length) return null;
  return video.reduce((s, f) => s + f.length, 0) / video.length / (minutes * 60);
}

/** Убрать онлайн-просмотр: раздача из TorrServer, ссылки из библиотеки «Стрим», обновить Jellyfin. */
export async function removeStream(hash: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error("неверный хэш");
  const l = strmByHash().get(hash);
  for (const f of l?.files ?? []) fs.rmSync(f, { force: true });
  if (l) {
    const root = path.join(env.streamDir, l.folder);
    for (const season of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const sdir = path.join(root, season);
      if (fs.statSync(sdir).isDirectory() && !fs.readdirSync(sdir).length) fs.rmdirSync(sdir);
    }
    if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  }
  await ts("/torrents", { action: "rem", hash });
  await refreshJellyfin().catch(() => undefined);
}

type JfSeries = { Id: string; Path?: string; ProviderIds?: Record<string, string> };

/** Все сериалы Jellyfin (для ссылок со страницы «Загрузки»), кэш 1 мин. */
let jfCache: { at: number; items: JfSeries[] } | null = null;
export async function jellyfinSeries(): Promise<JfSeries[]> {
  if (!env.jellyfinApiKey) return [];
  if (jfCache && Date.now() - jfCache.at < 60_000) return jfCache.items;
  const r = await jellyfin<{ Items: JfSeries[] }>("/Items?IncludeItemTypes=Series&Recursive=true&Fields=Path,ProviderIds");
  jfCache = { at: Date.now(), items: r.Items };
  return r.Items;
}

/**
 * Страница тайтла и сериал в Jellyfin по TVDB. where: "stream" — из библиотеки «Стрим»,
 * "library" — скачанный (любая другая библиотека).
 */
export async function linksFor(tvdb: number | null, season: number, jf: JfSeries[], where: "stream" | "library", episode?: number) {
  if (!tvdb) return { anilistId: null, jellyfinUrl: null };
  const isStream = (i: JfSeries) => Boolean(i.Path?.includes(`${env.jellyfinStreamPath}/`));
  const item = jf.find((i) => (i.ProviderIds?.Tvdb === String(tvdb) || i.Path?.includes(`[tvdbid-${tvdb}]`)) && isStream(i) === (where === "stream"));
  return {
    anilistId: await anilistForTvdb(tvdb, season, episode).catch(() => null),
    jellyfinUrl: item ? `${env.jellyfinPublicUrl}/web/#/details?id=${item.Id}` : null,
  };
}

// ---------------------------------------------------------------- подготовка серии (prebuffer.ts)

export type StrmEpisode = { index: number; code: string; file: string };

/** Серии раздачи в библиотеке «Стрим»: индекс файла в TorrServer и код S01E05. */
export function strmEpisodes(hash: string): StrmEpisode[] {
  const l = strmByHash().get(hash);
  if (!l) return [];
  return l.files.flatMap((file) => {
    const index = Number(/[?&]index=(\d+)/.exec(fs.readFileSync(file, "utf-8"))?.[1]);
    const code = /S\d{2}E\d{2,4}/.exec(path.basename(file))?.[0] ?? path.basename(file, ".strm");
    return index ? [{ index, code, file }] : [];
  }).sort((a, b) => a.code.localeCompare(b.code));
}

/** Тайтл AniList раздачи (по папке [tvdbid-X]/Season NN). */
export async function streamAnilistId(hash: string): Promise<number | null> {
  const l = strmByHash().get(hash);
  const tvdb = l ? Number(/\[tvdbid-(\d+)\]/.exec(l.folder)?.[1]) : 0;
  return tvdb ? anilistForTvdb(tvdb, l!.season).catch(() => null) : null;
}

/** Файл раздачи по индексу (будит раздачу — только для подготовки серии). */
export async function torrentFile(hash: string, index: number): Promise<{ title: string; length: number; path: string } | null> {
  const t = await ts<TsTorrent>("/torrents", { action: "get", hash });
  const f = t.file_stats?.find((x) => x.id === index);
  return f ? { title: t.title, length: f.length, path: f.path } : null;
}

/** Длительность серии раздачи, мин (AniList; если не опознана — 24). */
export async function streamMinutes(hash: string): Promise<number> {
  const id = await streamAnilistId(hash);
  if (!id) return 24;
  const { getMedia } = await import("./lists");
  const { getDetails } = await import("./anilist");
  const m = getMedia(id) ?? (await getDetails(id).catch(() => null));
  return m?.duration || 24;
}

/** Что сейчас играет в Jellyfin из библиотеки «Стрим»: раздача, файл и пользователь Jellyfin. */
export async function jellyfinNowPlaying(): Promise<{ hash: string; index: number; jellyfinUserId: string }[]> {
  if (!env.jellyfinApiKey) return [];
  const sessions = await jellyfin<{ UserId?: string; NowPlayingItem?: { Id: string; Path?: string } }[]>("/Sessions?activeWithinSeconds=120");
  const out: { hash: string; index: number; jellyfinUserId: string }[] = [];
  for (const s of sessions) {
    const item = s.NowPlayingItem;
    if (!item || !s.UserId) continue;
    const p = item.Path ?? (await jellyfin<{ Items: { Path?: string }[] }>(`/Items?Ids=${item.Id}&Fields=Path`).catch(() => null))?.Items[0]?.Path;
    // Путь Jellyfin (/data/media/stream/…) → наш (STREAM_DIR/…)
    if (!p?.startsWith(`${env.jellyfinStreamPath}/`) || !p.endsWith(".strm")) continue;
    const local = path.join(env.streamDir, p.slice(env.jellyfinStreamPath.length + 1));
    const link = fs.existsSync(local) ? fs.readFileSync(local, "utf-8") : "";
    const hash = /link=([0-9a-f]{40})/.exec(link)?.[1];
    const index = Number(/[?&]index=(\d+)/.exec(link)?.[1]);
    if (hash && index) out.push({ hash, index, jellyfinUserId: s.UserId });
  }
  return out;
}
