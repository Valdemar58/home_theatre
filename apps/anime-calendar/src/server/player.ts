import "server-only";
import { randomBytes } from "node:crypto";
import {
  chapterLabel, deviceProfile, isSignsTitle, JIMAKU_SUB, STREAM_SUB, pickAudio, pickSub, trackLabel, WATCHED_SHARE,
  type PlayCaps, type PlayInfo, type PlayStatus, type PlaySub, type PlayTrack,
} from "@/lib/player";
import { ApiError } from "./route";
import { db, now } from "./db";
import { markWatched } from "./jellyfin-sync";
import { episodeItems } from "./playback";
import { guarded } from "./sources";
import { segmentsFromChapters } from "@/lib/fingerprint";
import { prebufferProgress } from "./prebuffer";
import { ensureSegments, itemKey, storedSegments } from "./segments";
import { releaseTag, streamSubs, subsForVideo, syncStreamSubsSoon } from "./stream-subs";
import { sdhFile } from "./sdh";
import { dropTorrentCache, jellyfin, torrentCached, torrentStats } from "./stream";
import { episodeStatus } from "./availability";

// Плеер календаря: сессия просмотра серии. Jellyfin решает по профилю браузера, что отдать как есть, а что
// перекодировать (HEVC 10 бит → копия, если браузер умеет; FLAC → AAC), и отдаёт HLS. Браузер ходит только
// в календарь (/api/play/<sid>/…): ключ Jellyfin остаётся на сервере, плейлисты Jellyfin относительные.
// У каждой сессии свой DeviceId — перекодирования разных зрителей не мешают друг другу.

type MediaStream = {
  Type: "Video" | "Audio" | "Subtitle" | "Attachment" | string;
  Index: number; Codec?: string; Language?: string; Title?: string; IsDefault?: boolean; IsForced?: boolean; IsExternal?: boolean;
};
type MediaSource = {
  Id: string; RunTimeTicks?: number; SupportsDirectPlay?: boolean; TranscodingUrl?: string; TranscodeReasons?: string[];
  MediaStreams: MediaStream[]; MediaAttachments?: { Index: number; FileName?: string; MimeType?: string }[];
};

export type PlaySession = {
  sid: string;
  userId: number;
  anilistId: number;
  ep: number;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  deviceId: string;
  /** Серия «Стрима»: раздача и файл в TorrServer (состояние для плеера) */
  stream: { hash: string; index: number } | null;
  /** Путь и запрос HLS у Jellyfin (/videos/<id>/master.m3u8?...) или null — файл как есть */
  hlsPath: string | null;
  duration: number;
  marked: boolean;
  /** Когда последний раз сообщили позицию в Jellyfin */
  jfAt: number;
  seenAt: number;
};

const g = globalThis as unknown as { __playSessions?: Map<string, PlaySession> };
const sessions = (g.__playSessions ??= new Map());
// Плеер шлёт позицию раз в 10 с (и на паузе): дольше 3 мин тишины — вкладку закрыли
const IDLE_MS = 3 * 60_000;

export function playSession(sid: string, userId: number): PlaySession {
  const s = sessions.get(sid);
  if (!s || s.userId !== userId) throw new ApiError(404, "Сессия просмотра закончилась — откройте серию заново");
  s.seenAt = Date.now();
  return s;
}

/** Начать (или перезапустить с другой озвучкой/с позиции) просмотр серии. */
export async function startPlayback(user: { id: number; jellyfin_id: string }, anilistId: number, ep: number, opts: {
  caps: PlayCaps; audio?: number | null; start?: number | null; replace?: string | null;
}): Promise<PlayInfo> {
  const items = (await episodeItems(anilistId)).get(ep) ?? [];
  const item = items.find((i) => i.where === "library") ?? items[0];
  if (!item) throw new ApiError(404, "Этой серии нет ни в библиотеке, ни в «Стриме»");
  // Сменили озвучку — старое перекодирование больше не нужно
  if (opts.replace) await stopPlayback(opts.replace, user.id).catch(() => undefined);

  const saved = db.prepare<[number, number, number], { pos: number; dur: number | null }>(
    "SELECT pos, dur FROM playback_pos WHERE user_id = ? AND anilist_id = ? AND ep = ?").get(user.id, anilistId, ep);
  // Досмотрено почти до конца — сначала
  const resume = saved && (!saved.dur || saved.pos < saved.dur * WATCHED_SHARE) ? saved.pos : 0;
  const start = Math.max(0, opts.start ?? resume);

  // Студия озвучки, отмеченная у тайтла, — дорожка по умолчанию
  const voice = db.prepare<[number, number], { voice: string | null }>("SELECT voice FROM list_entries WHERE user_id = ? AND anilist_id = ?").get(user.id, anilistId)?.voice ?? null;
  const jf = await jellyfinUser(user.jellyfin_id);
  const probe = await info(item.itemId, jf, opts.caps, start, opts.audio ?? undefined);
  const audio = probe.MediaStreams.filter((m) => m.Type === "Audio").map(track);
  const audioIndex = opts.audio ?? pickAudio(audio, voice);
  // Озвучка не та, что Jellyfin выбрал сам, — второй запрос уже с нужной дорожкой (перекодирование звука под неё)
  const ms = audioIndex !== null && opts.audio == null && audioIndex !== defaultAudio(probe) ? await info(item.itemId, jf, opts.caps, start, audioIndex) : probe;

  const sid = randomBytes(9).toString("base64url");
  const deviceId = `ac-${sid}`;
  const playSessionId = new URLSearchParams(ms.TranscodingUrl?.split("?")[1] ?? "").get("PlaySessionId") ?? sid;
  const hlsPath = ms.TranscodingUrl && !ms.SupportsDirectPlay
    ? ms.TranscodingUrl.replace(/([?&])ApiKey=[^&]*&?/i, "$1").replace(/([?&])DeviceId=[^&]*/i, `$1DeviceId=${deviceId}`)
    : null;
  const duration = (ms.RunTimeTicks ?? 0) / 1e7 || (item.runtimeSec ?? 0);
  sessions.set(sid, {
    sid, userId: user.id, anilistId, ep, itemId: item.itemId, mediaSourceId: ms.Id, playSessionId, deviceId, hlsPath,
    stream: item.hash && item.index ? { hash: item.hash, index: item.index } : null,
    duration, marked: false, jfAt: 0, seenAt: Date.now(),
  });

  const base = `/api/play/${sid}`;
  const subs: PlaySub[] = ms.MediaStreams.filter((m) => m.Type === "Subtitle" && isText(m.Codec)).map((m) => {
    const ass = /^(ass|ssa)$/i.test(m.Codec ?? "");
    return {
      ...track(m), url: `${base}/sub/${m.Index}.${ass ? "ass" : "vtt"}`, ass,
      forced: Boolean(m.IsForced), signs: Boolean(m.IsForced) || isSignsTitle(m.Title ?? null), external: Boolean(m.IsExternal),
    };
  });
  const extVoices: string[] = [];
  // Русские субтитры из раздачи «Стрима» («RUS Subs/[Студия]») со шрифтами раздачи; ещё не скачаны — в фон
  const fonts = (ms.MediaAttachments ?? []).filter((a) => /font|ttf|otf|woff/i.test(`${a.MimeType} ${a.FileName}`)).map((a) => `${base}/font/${a.Index}`);
  if (item.hash && item.index) {
    const m = streamSubs(item.hash);
    if (!m) syncStreamSubsSoon(item.hash);
    const url = (f: string) => `/api/stream-subs/${item.hash}/${f}`;
    (m ? subsForVideo(m, item.index) : []).forEach((x, i) => subs.push({
      index: STREAM_SUB + i, lang: "rus", codec: x.file.split(".").pop() ?? "ass", title: x.group,
      label: `Русский · ${x.group ?? "из раздачи"}${x.signs ? " (надписи)" : ""}`, url: url(x.file), ass: !x.file.endsWith(".srt"),
      forced: false, signs: x.signs, external: true, torrent: true,
    }));
    if (m?.subs.length) fonts.push(...m.fonts.map(url));
    extVoices.push(...(m?.voices ?? []));
  }
  // Субтитры, взятые из других раздач («Озвучки» → «Субтитры»): та же серия, тайминг — сдвигом
  for (const r of db.prepare<[number], { hash: string; title: string; episodes: string }>("SELECT hash, title, episodes FROM release_subs WHERE anilist_id = ?").all(anilistId)) {
    const video = (JSON.parse(r.episodes) as Record<string, number>)[ep];
    const m = video !== undefined && r.hash !== item.hash ? streamSubs(r.hash) : null;
    const own = m ? subsForVideo(m, video) : [];
    own.forEach((x) => subs.push({
      index: STREAM_SUB + subs.length, lang: "rus", codec: x.file.split(".").pop() ?? "ass", title: x.group,
      label: `Русский · ${x.group ?? releaseTag(r.title) ?? "другая раздача"}${x.signs ? " (надписи)" : ""} · другая раздача`, url: `/api/stream-subs/${r.hash}/${x.file}`,
      ass: !x.file.endsWith(".srt"), forced: false, signs: x.signs, external: true, torrent: true,
    }));
    if (own.length) fonts.push(...m!.fonts.map((f) => `/api/stream-subs/${r.hash}/${f}`));
  }
  // Японские субтитры с Jimaku (скачаны для «Глубокого разбора» или кнопкой в плеере): тайминг другого релиза — есть сдвиг
  const jp = sdhFile(anilistId, ep);
  if (jp) {
    const ass = /\.(ass|ssa)$/i.test(jp.path);
    subs.push({
      index: JIMAKU_SUB, lang: "jpn", codec: ass ? "ass" : "srt", title: "Jimaku", label: "Японский · Jimaku (для слабослышащих)",
      url: `/api/anime/${anilistId}/subs/${ep}`, ass, forced: false, signs: false, external: true, jimaku: true,
    });
  }
  const meta = await chaptersOf(item.itemId, ms.Id);
  const chapters = meta.chapters.filter((c) => c.start < duration);
  const trickplay = meta.trickplay && { ...meta.trickplay, url: `${base}/trickplay/${meta.trickplay.width}` };
  // Опенинг и эндинг: главы файла точнее всего; нет глав — найденные по звуку (нет отпечатка — поиск в фон)
  const byChapters = segmentsFromChapters(chapters, duration);
  const key = itemKey(item);
  if (!byChapters.length) ensureSegments(anilistId, key);
  const segments = byChapters.length ? byChapters : storedSegments(key);
  return {
    sid,
    src: hlsPath ? `${base}/${hlsPath.replace(/^\/videos\/[^/]+\//i, "")}` : `${base}/stream`,
    hls: Boolean(hlsPath),
    stream: Boolean(item.hash && item.index),
    duration,
    start,
    audio,
    audioIndex,
    subs,
    subIndex: pickSub(subs, audio.find((a) => a.index === audioIndex)),
    fonts,
    chapters,
    trickplay,
    segments,
    extVoices,
    // Причины — в ответе или (Jellyfin 12) только в ссылке потока
    transcode: ms.TranscodeReasons?.length ? ms.TranscodeReasons : (new URLSearchParams(ms.TranscodingUrl?.split("?")[1] ?? "").get("TranscodeReasons")?.split(",").filter(Boolean) ?? []),
  };
}

const isText = (codec?: string) => /^(ass|ssa|srt|subrip|vtt|webvtt|mov_text|text)$/i.test(codec ?? "");
const track = (m: MediaStream): PlayTrack => ({
  index: m.Index, lang: m.Language ?? null, codec: m.Codec ?? "", title: m.Title ?? null,
  label: trackLabel(m.Language ?? null, m.Title ?? null, m.Codec ?? ""),
});
const defaultAudio = (ms: MediaSource) => {
  const a = ms.MediaStreams.filter((m) => m.Type === "Audio");
  return (a.find((m) => m.IsDefault) ?? a[0])?.Index ?? null;
};

/**
 * Пользователь Jellyfin для PlaybackInfo (без него Jellyfin отвечает 400): свой, а у друзей без аккаунта Jellyfin
 * (или без доступа к библиотекам) — администратор календаря; поток от этого не зависит.
 */
async function jellyfinUser(own: string): Promise<string> {
  const ok = await jellyfin(`/Users/${own}`).then(() => true).catch(() => false);
  if (ok) return own;
  const admin = db.prepare<[], { jellyfin_id: string }>("SELECT jellyfin_id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1").get();
  if (!admin) throw new ApiError(403, "Нет пользователя Jellyfin, от имени которого смотреть");
  return admin.jellyfin_id;
}

async function info(itemId: string, userId: string, caps: PlayCaps, start: number, audio?: number): Promise<MediaSource> {
  const r = await guarded("jellyfin", () => jellyfin<{ MediaSources: MediaSource[] }>(`/Items/${itemId}/PlaybackInfo?userId=${userId}`, {
    method: "POST",
    body: JSON.stringify({
      DeviceProfile: deviceProfile(caps), MaxStreamingBitrate: caps.maxBitrate, StartTimeTicks: Math.round(start * 1e7),
      AudioStreamIndex: audio, SubtitleStreamIndex: -1, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true,
      AutoOpenLiveStream: true,
    }),
  }));
  const ms = r.MediaSources[0];
  if (!ms) throw new ApiError(502, "Jellyfin не отдал видео серии");
  return ms;
}

type TrickInfo = { Width: number; Height: number; TileWidth: number; TileHeight: number; ThumbnailCount: number; Interval: number };

/** Главы и миниатюры шкалы (trickplay Jellyfin — есть, если библиотека их делает; у «Стрима» — нет). */
async function chaptersOf(itemId: string, mediaSourceId: string) {
  const r = await jellyfin<{ Items: { Chapters?: { Name?: string; StartPositionTicks: number }[]; Trickplay?: Record<string, Record<string, TrickInfo>> }[] }>(
    `/Items?Ids=${itemId}&Fields=Chapters,Trickplay`).catch(() => null);
  const it = r?.Items[0];
  // Самая мелкая ширина — для подсказки на шкале хватает
  const t = Object.values(it?.Trickplay?.[mediaSourceId] ?? Object.values(it?.Trickplay ?? {})[0] ?? {}).sort((a, b) => a.Width - b.Width)[0];
  return {
    // Названия глав — по-русски (Intro → «Вступление», Part A → «Часть A»)
    chapters: (it?.Chapters ?? []).map((c) => ({ name: chapterLabel(c.Name ?? ""), start: c.StartPositionTicks / 1e7 })),
    trickplay: t ? { width: t.Width, height: t.Height, cols: t.TileWidth, rows: t.TileHeight, count: t.ThumbnailCount, interval: t.Interval } : null,
  };
}

/** Адрес у Jellyfin для запроса браузера к /api/play/<sid>/<rest>. */
export function upstreamPath(s: PlaySession, rest: string, search: string): string {
  const sub = /^sub\/(\d+)\.(ass|vtt)$/.exec(rest);
  if (sub) return `/Videos/${s.itemId}/${s.mediaSourceId}/Subtitles/${sub[1]}/0/Stream.${sub[2]}`;
  const trick = /^trickplay\/(\d+)\/(\d+)\.jpg$/.exec(rest);
  if (trick) return `/Videos/${s.itemId}/Trickplay/${trick[1]}/${trick[2]}.jpg?mediaSourceId=${s.mediaSourceId}`;
  const font = /^font\/(\d+)$/.exec(rest);
  if (font) return `/Videos/${s.itemId}/${s.mediaSourceId}/Attachments/${font[1]}`;
  if (rest === "stream") return `/Videos/${s.itemId}/stream?static=true&mediaSourceId=${s.mediaSourceId}`;
  if (!s.hlsPath || !/^[\w./-]+$/.test(rest) || rest.includes("..")) throw new ApiError(404, "Нет такого файла");
  // Плейлисты и сегменты HLS — в той же папке, что и master.m3u8; запрос — как есть (без ключа)
  const dir = s.hlsPath.split("?")[0].replace(/[^/]+$/, "");
  return `${dir}${rest}${search.replace(/([?&])ApiKey=[^&]*/i, "$1")}`;
}

/** Позиция просмотра: сохранить, после 85% — серия просмотрена; в Jellyfin — раз в 30 с (ТВ-клиенты продолжат). */
export async function reportProgress(user: { id: number; name: string; jellyfin_id: string }, s: PlaySession, pos: number) {
  const dur = s.duration || null;
  db.prepare(`INSERT INTO playback_pos (user_id, anilist_id, ep, pos, dur, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, anilist_id, ep) DO UPDATE SET pos = excluded.pos, dur = excluded.dur, updated_at = excluded.updated_at`)
    .run(user.id, s.anilistId, s.ep, pos, dur, now());
  const done = Boolean(dur && pos >= dur * WATCHED_SHARE);
  if (done && !s.marked) {
    s.marked = true;
    await markWatched(user, s.anilistId, s.ep, "player");
  }
  if (done || Date.now() - s.jfAt > 30_000) {
    s.jfAt = Date.now();
    await jellyfin(`/UserItems/${s.itemId}/UserData?userId=${user.jellyfin_id}`, {
      method: "POST",
      body: JSON.stringify(done ? { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: new Date().toISOString() } : { PlaybackPositionTicks: Math.round(pos * 1e7) }),
    }).catch((e) => console.warn(`[player] позиция в Jellyfin: ${String(e)}`));
  }
  return { marked: s.marked };
}

/**
 * Что с потоком серии «Стрима» (как на странице «Загрузки»): раздача, скорость против нужной, подготовка буфера.
 * Файл из библиотеки — null (качать нечего).
 */
export async function playStatus(s: PlaySession): Promise<PlayStatus> {
  if (!s.stream) return { stream: null };
  const [t, cached] = await Promise.all([
    torrentStats(s.stream.hash, s.stream.index).catch(() => null),
    torrentCached(s.stream.hash, s.stream.index).catch(() => []),
  ]);
  const p = prebufferProgress().find((x) => x.key === `${s.stream!.hash}:${s.stream!.index}`);
  return {
    stream: t && {
      ...t,
      rate: t.fileSize && s.duration ? t.fileSize / s.duration : null,
      prebuffer: p ? { read: p.read, size: p.size, ready: p.ready, done: p.done, etaSec: p.etaSec } : null,
      cached,
    },
  };
}

/** Закрыли плеер: остановить перекодирование у Jellyfin. */
export async function stopPlayback(sid: string, userId: number) {
  const s = sessions.get(sid);
  if (!s || s.userId !== userId) return;
  sessions.delete(sid);
  if (s.hlsPath) {
    await jellyfin(`/Videos/ActiveEncodings?deviceId=${encodeURIComponent(s.deviceId)}&playSessionId=${s.playSessionId}`, { method: "DELETE" })
      .catch(() => undefined);
  }
  if (s.marked && s.stream) await cleanAfterWatched(s).catch((e) => console.warn(`[player] очистка кэша: ${String(e)}`));
}

/**
 * Досмотрели серию «Стрима» и закрыли плеер: если у раздачи не осталось подготовленных непросмотренных серий —
 * сбросить её кэш (TorrServer не умеет удалять из кэша одну серию). Кто-то ещё смотрит эту раздачу — не трогаем.
 */
async function cleanAfterWatched(s: PlaySession) {
  const hash = s.stream?.hash;
  if (!hash || [...sessions.values()].some((x) => x.stream?.hash === hash)) return;
  const watched = db.prepare<[number, number], { episodes: number }>("SELECT episodes FROM list_entries WHERE user_id = ? AND anilist_id = ? AND deleted = 0")
    .get(s.userId, s.anilistId)?.episodes ?? s.ep;
  const { episodes } = await episodeStatus(s.anilistId);
  const waiting = episodes.some((e) => e.hash === hash && e.ep > Math.max(watched, s.ep) && (e.cached ?? 0) > 0.05);
  if (!waiting) await dropTorrentCache(hash);
}

/** Что сейчас смотрят в плеере календаря из «Стрима» — подготовка следующей серии (prebuffer.ts). */
export const playingStreams = () => [...sessions.values()]
  .filter((s) => s.stream && Date.now() - s.seenAt < 60_000)
  .map((s) => ({ hash: s.stream!.hash, index: s.stream!.index, userId: s.userId }));

/** Брошенные сессии (вкладку закрыли без «стоп») — убрать (из jobs.ts). */
export function sweepPlayback() {
  for (const [sid, s] of sessions) if (Date.now() - s.seenAt > IDLE_MS) void stopPlayback(sid, s.userId);
}
