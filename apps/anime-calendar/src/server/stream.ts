import "server-only";
import fs from "node:fs";
import path from "node:path";
import { byteToTime, elementSize, mkvCues, mkvHead } from "@/lib/mkv-index";
import { piecesToRanges } from "@/lib/player";
import { env } from "./env";
import { anilistForTvdb, mappingForAnilist } from "./idmap";
import { sonarrEpisodes, sonarrGet, type ProwlarrRelease } from "./ru/arr";
import { assignEpisodes, localEpisode } from "./ru/episode";
import type { EpisodeRefLike } from "./ru/title";

// «Смотреть сейчас»: раздача добавляется в TorrServer, а в библиотеку Jellyfin «Стрим»
// кладутся .strm-файлы со ссылками на поток. Jellyfin сам транскодирует (NVENC),
// дорожки внутри mkv выбираются в плеере. Озвучки раздачи отдельными файлами — ссылками рядом с .strm
// («<серия>.ru.<Студия>.mka» → .voices/, stream-voices.ts) — Jellyfin сводит их с видео сам.

export const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm)$/i;
// Спешлы и бонусы в отдельных папках нумеруются заново и путают сопоставление
export const EXTRAS = /(^|\/)(specials?|sp|extras?|bonus|ova|nced|ncop|menus?|trailers?)(\/|$)/i;

export type TsFile = { id: number; path: string; length: number };
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

export const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();

/** Файлы рядом с .strm серии (озвучки «<серия>.ru.<Студия>.mka»). */
export function strmSiblings(strm: string): string[] {
  const dir = path.dirname(strm);
  const base = `${path.basename(strm, ".strm")}.`;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(base) && !f.endsWith(".strm")).map((f) => path.join(dir, f)) : [];
}

/** Убрать серию «Стрима»: .strm и озвучки рядом. */
function removeStrm(strm: string) {
  for (const f of [strm, ...strmSiblings(strm)]) fs.rmSync(f, { force: true });
}
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
  const { files, targets } = await targetsOf(torrent, opts.ref, mapping.tvdb);

  const name = safe(opts.seriesTitle);
  const folder = path.join(env.streamDir, `${name}${opts.year ? ` (${opts.year})` : ""} [tvdbid-${mapping.tvdb}]`);
  let created = 0;
  const placed: { strm: string; index: number }[] = [];
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const target = targets[i];
    if (!target) {
      skipped++;
      continue;
    }
    const dir = path.join(folder, `Season ${pad(target.season)}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name} - S${pad(target.season)}E${pad(target.episode)}.strm`);
    const url = `${env.torrserverInternalUrl}/stream/${encodeURIComponent(path.basename(files[i].path))}?link=${torrent.hash}&index=${files[i].id}&play`;
    // Другая раздача — озвучки рядом были под старое видео
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim() !== url) for (const v of strmSiblings(file)) fs.rmSync(v, { force: true });
    fs.writeFileSync(file, url + "\n");
    placed.push({ strm: file, index: files[i].id });
    created++;
  }
  // Ссылки на озвучки раздачи отдельными файлами — до первого запуска серий (звук качается по выбору)
  const { placeVoiceSlots } = await import("./stream-voices");
  try {
    placeVoiceSlots(torrent.file_stats ?? [], torrent.hash, placed);
  } catch (e) {
    console.warn(`[stream] ссылки на озвучки: ${String(e)}`);
  }
  await refreshJellyfin(path.basename(folder)).catch((e) => console.warn(`[stream] обновление Jellyfin: ${String(e)}`));
  // Русские субтитры и шрифты раздачи — в фон (мегабайты, без видео)
  const { syncStreamSubsSoon } = await import("./stream-subs");
  syncStreamSubsSoon(torrent.hash);
  return { episodes: created, skipped, folder: path.basename(folder) };
}

/**
 * Видео раздачи → серия TVDB (сезон, номер) по ref — тот же расчёт, что для Sonarr. Абсолютная нумерация (длинные
 * сериалы) — через эпизоды Sonarr.
 */
async function targetsOf(torrent: TsTorrent, ref: EpisodeRefLike, tvdb: number) {
  const files = (torrent.file_stats ?? []).filter((f) => VIDEO.test(f.path) && !EXTRAS.test(f.path));
  if (!files.length) throw new Error("В раздаче не найдено видеофайлов");
  let absolute: Map<number, { season: number; episode: number }> | null = null;
  if (ref.kind === "absolute") {
    const series = (await sonarrGet<{ id: number; tvdbId: number }[]>("/api/v3/series")).find((s) => s.tvdbId === tvdb);
    if (!series) throw new Error("Для сериалов со сквозной нумерацией сначала добавь сериал в Sonarr (кнопка «Скачать»)");
    absolute = new Map((await sonarrEpisodes(series.id))
      .filter((e) => e.absoluteEpisodeNumber)
      .map((e) => [e.absoluteEpisodeNumber!, { season: e.seasonNumber, episode: e.episodeNumber }]));
  }
  const assigned = assignEpisodes(files.map((f) => localEpisode(f.path)), ref);
  const targets = assigned.map((a) => (!a ? null : "absolute" in a ? absolute?.get(a.absolute) ?? null : a));
  return { files, targets };
}

/**
 * Субтитры из другой раздачи: добавить её в TorrServer (видео не читаем), сопоставить видео с сериями тайтла и скачать
 * только субтитры и шрифты. Возвращает раздачу и «серия тайтла → файл раздачи» (для плеера). Раздача без ссылок
 * «Стрима» уйдёт при уборке, скачанное останется.
 */
export async function releaseSubsTorrent(opts: { anilistId: number; release: ProwlarrRelease; ref: EpisodeRefLike; title: string }) {
  const mapping = await mappingForAnilist(opts.anilistId);
  if (!mapping) throw new Error("Тайтл не сопоставлен с TVDB");
  const torrent = await addTorrent(opts.release, opts.title, null);
  const { files, targets } = await targetsOf(torrent, opts.ref, mapping.tvdb);
  const episodes: Record<number, number> = {};
  files.forEach((f, i) => {
    const t = targets[i];
    if (t && (mapping.season === "a" || t.season === mapping.season) && t.episode - mapping.offset >= 1) episodes[t.episode - mapping.offset] = f.id;
  });
  return { hash: torrent.hash, episodes };
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
    if (dir.startsWith(".")) continue;
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
        // Озвучка («<серия>.ru.<Студия>.mka») без своей серии — убрать; с серией — уходит вместе с ней
        if (!f.endsWith(".strm")) {
          if (!fs.existsSync(path.join(sdir, `${f.replace(/\.(ru|en|ja)\.[^.]+\.[^.]+(\.part)?$/, "")}.strm`))) fs.rmSync(file, { force: true });
          continue;
        }
        const code = /S\d{2}E\d{2,4}/.exec(f)?.[0];
        const old = Date.now() - fs.statSync(file).mtimeMs > maxAgeDays * 86400_000;
        if ((code && downloaded.has(code)) || old) {
          removeStrm(file);
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
  // Звук озвучек раздач без ссылок
  const { dropVoices, placeVoiceSlots, VOICES_DIR } = await import("./stream-voices");
  const voices = path.join(env.streamDir, VOICES_DIR);
  for (const hash of fs.existsSync(voices) ? fs.readdirSync(voices) : []) if (/^[0-9a-f]{40}$/.test(hash) && !usedHashes.has(hash)) dropVoices(hash);
  // Раздачи, добавленные до ссылок на озвучки, — завести их всем сериям (один раз: папка .voices/<хэш> — отметка)
  for (const hash of usedHashes) {
    if (fs.existsSync(path.join(voices, hash))) continue;
    const files = await torrentFiles(hash).catch(() => null);
    try {
      if (files) placeVoiceSlots(files, hash, strmEpisodes(hash).map((e) => ({ strm: e.file, index: e.index })));
    } catch (e) {
      console.warn(`[stream] ссылки на озвучки ${hash}: ${String(e)}`);
    }
  }
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
    if (dir.startsWith(".")) continue;
    const root = path.join(env.streamDir, dir);
    if (!fs.statSync(root).isDirectory()) continue;
    for (const season of fs.readdirSync(root)) {
      const sdir = path.join(root, season);
      if (!fs.statSync(sdir).isDirectory()) continue;
      for (const f of fs.readdirSync(sdir)) {
        if (!f.endsWith(".strm")) continue;
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

/** Кэш раздачи: куски, размер куска, файлы, занято/ёмкость (один запрос на раздачу). */
async function cacheOf(hash: string) {
  return ts<{ PiecesLength?: number; Pieces?: Record<string, { Id: number; Completed?: boolean }> | null; Torrent?: TsTorrent; Capacity?: number; Filled?: number }>(
    "/cache", { action: "get", hash });
}

/** Доля каждого файла раздачи в кэше TorrServer: индекс файла → 0–1. */
export async function torrentFilesCached(hash: string): Promise<{ files: Map<number, number>; filled: number; capacity: number }> {
  const c = await cacheOf(hash);
  const files = [...(c.Torrent?.file_stats ?? [])].sort((a, b) => a.id - b.id);
  const done = Object.values(c.Pieces ?? {}).filter((p) => p.Completed).map((p) => p.Id);
  const out = new Map<number, number>();
  let offset = 0;
  for (const f of files) {
    if (c.PiecesLength && f.length) out.set(f.id, piecesToRanges(done, c.PiecesLength, offset, f.length).reduce((s, [a, b]) => s + b - a, 0));
    offset += f.length;
  }
  return { files: out, filled: c.Filled ?? 0, capacity: c.Capacity ?? 0 };
}

/**
 * Раздачи TorrServer и их кэш (для предупреждения «кэш заполнен»). Кэш спрашиваем только у активных: запрос будит
 * раздачу, а у спящей кэш в памяти и так пуст.
 */
export async function torrentCaches(): Promise<{ hash: string; title: string; filled: number; capacity: number; active: boolean }[]> {
  const list = await ts<(TsTorrent & { stat?: number })[]>("/torrents", { action: "list" });
  return Promise.all(list.map(async (t) => {
    const active = t.stat !== undefined && t.stat >= 1 && t.stat <= 3;
    const c = active ? await cacheOf(t.hash).catch(() => null) : null;
    return { hash: t.hash, title: t.title, filled: c?.Filled ?? 0, capacity: c?.Capacity ?? 0, active };
  }));
}

/** Сбросить кэш раздачи (в памяти — освобождается целиком; удалить из кэша одну серию TorrServer не умеет). */
export async function dropTorrentCache(hash: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error("неверный хэш");
  await ts("/torrents", { action: "drop", hash });
}

/** Часть файла раздачи через TorrServer (Range; без &play он отдаёт пустой ответ). */
async function tsRange(hash: string, index: number, from: number, to: number): Promise<Uint8Array> {
  const res = await fetch(`${env.torrserverUrl}/stream/file.mkv?link=${hash}&index=${index}&play`, {
    headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`TorrServer: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Индекс MKV по файлу раздачи — один раз за жизнь процесса (файл раздачи не меняется)
const mkvMaps = new Map<string, Promise<{ t: number; pos: number }[] | null>>();
function mkvPoints(hash: string, index: number): Promise<{ t: number; pos: number }[] | null> {
  const key = `${hash}:${index}`;
  let p = mkvMaps.get(key);
  if (!p) {
    p = (async () => {
      const h = mkvHead(await tsRange(hash, index, 0, 256 * 1024 - 1));
      if (!h?.cues) return null;
      const size = elementSize(await tsRange(hash, index, h.cues, h.cues + 15));
      if (!size || size > 16 * 1024 * 1024) return null;
      const pts = mkvCues(await tsRange(hash, index, h.cues, h.cues + size - 1), h.segment, h.timecodeScale);
      return pts.length > 1 ? pts : null;
    })().catch((e) => {
      console.warn(`[stream] индекс MKV ${key}: ${String(e)}`);
      mkvMaps.delete(key);
      return null;
    });
    mkvMaps.set(key, p);
  }
  return p;
}

/**
 * Какие части файла раздачи уже скачаны в кэш TorrServer — доли длительности (для полоски в плеере). У MKV — по индексу
 * Cues (точно), иначе пропорционально размеру.
 */
export async function torrentCached(hash: string, index: number, duration?: number): Promise<[number, number][]> {
  const c = await cacheOf(hash);
  const files = [...(c.Torrent?.file_stats ?? [])].sort((a, b) => a.id - b.id);
  const file = files.find((f) => f.id === index);
  if (!file || !c.PiecesLength) return [];
  // Файлы идут в раздаче подряд по порядку: смещение — сумма предыдущих
  const offset = files.filter((f) => f.id < index).reduce((s, f) => s + f.length, 0);
  const done = Object.values(c.Pieces ?? {}).filter((p) => p.Completed).map((p) => p.Id);
  const ranges = piecesToRanges(done, c.PiecesLength, offset, file.length);
  const pts = duration && /\.mkv$/i.test(file.path) ? await mkvPoints(hash, index) : null;
  if (!pts || !duration) return ranges;
  const toTime = byteToTime(pts, file.length, duration);
  return ranges.map(([a, b]) => [toTime(a * file.length) / duration, toTime(b * file.length) / duration]);
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
  for (const f of l?.files ?? []) removeStrm(f);
  if (l) {
    const root = path.join(env.streamDir, l.folder);
    for (const season of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const sdir = path.join(root, season);
      if (fs.statSync(sdir).isDirectory() && !fs.readdirSync(sdir).length) fs.rmdirSync(sdir);
    }
    if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  }
  await ts("/torrents", { action: "rem", hash });
  (await import("./stream-voices")).dropVoices(hash);
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

/** Все файлы раздачи (будит раздачу): субтитры, шрифты, озвучки рядом с видео. */
export async function torrentFiles(hash: string): Promise<TsFile[]> {
  return (await ts<TsTorrent>("/torrents", { action: "get", hash })).file_stats ?? [];
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
