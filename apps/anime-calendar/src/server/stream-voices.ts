import "server-only";
import fs from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { db, now } from "./db";
import { env } from "./env";
import { episodeItems, type JfEpisodeItem } from "./playback";
import { localEpisode } from "./ru/episode";
import { EXTRAS, safe, streamAnilistId, torrentFiles, VIDEO, type TsFile } from "./stream";
import { subGroup } from "./stream-subs";

// Озвучки раздачи «Стрима» отдельными файлами (TASKS 9.3б): «RUS Sound/[Студия]/<имя серии>.mka». Jellyfin сводит
// видео .strm со звуком из файла рядом («<серия>.ru.<Студия>.mka») сам — перекодирование, перемотка и ТВ-приложения
// работают как с дорожкой внутри файла. Видео не трогаем: качаем через TorrServer только звук серии (десятки МБ).
//
// Звук лежит в STREAM_DIR/.voices/<хэш>/<файл раздачи>, рядом с .strm — относительные ссылки на него, заведённые сразу
// при «Смотреть». Так нужно из-за Jellyfin: каждый запуск .strm он заново проверяет серию, а внешние файлы ищет по своему
// кэшу списка файлов папки (сбрасывается после 5 мин без запусков) — файл, появившийся после первого запуска серии из
// этой папки, он не увидит. Ссылка же есть в списке с самого начала: пока звука нет, Jellyfin её пропускает, скачали —
// дорожка появляется при следующем запуске.

const AUDIO = /\.(mka|ac3|eac3|dts|aac|flac|mp3|opus|m4a)$/i;
const NC = /\bNC(OP|ED)\b/i;
const base = (p: string) => path.basename(p).replace(/\.[^.]+$/, "");
export const VOICES_DIR = ".voices";

export type VoiceFile = { group: string; lang: "ru" | "en" | "ja"; id: number; size: number; ext: string };
export type EpisodeVoice = VoiceFile & { have: boolean };

/** Название студии для имени файла: Jellyfin делит имя по точкам («<серия>.ru.<Студия>.mka»). */
const voiceName = (g: string) => safe(g).replace(/\./g, " ").replace(/\s+/g, " ").trim();

/**
 * Озвучки к видео раздачи. Звук относится к видео, если его имя начинается с имени видео (самое длинное совпадение),
 * иначе — по номеру серии (если он у видео раздачи один). Студия — папка («[AniLibria]»), как у субтитров.
 */
export function voicesForVideo(files: TsFile[], video: number): VoiceFile[] {
  const videos = files.filter((f) => VIDEO.test(f.path) && !EXTRAS.test(f.path) && !NC.test(f.path));
  const v = videos.find((f) => f.id === video);
  if (!v) return [];
  const num = localEpisode(v.path);
  const byNum = num !== null && videos.filter((f) => localEpisode(f.path) === num).length === 1;
  const out = new Map<string, VoiceFile>();
  for (const a of files.filter((f) => AUDIO.test(f.path))) {
    const name = base(a.path);
    const owner = videos.filter((x) => name.startsWith(base(x.path))).sort((x, y) => base(y.path).length - base(x.path).length)[0];
    if (owner ? owner.id !== video : !(byNum && localEpisode(a.path) === num)) continue;
    const lang = /(^|[\s/_[(-])(eng?|english)([\s/_\])-]|$)/i.test(a.path) ? "en" : /(^|[\s/_[(-])(jap|jpn|japanese)([\s/_\])-]|$)/i.test(a.path) ? "ja" : "ru";
    const group = voiceName(subGroup(a.path).group ?? (lang === "ru" ? "Русская" : lang === "en" ? "English" : "Japanese"));
    if (!group || out.has(group)) continue;
    out.set(group, { group, lang, id: a.id, size: a.length, ext: path.extname(a.path).toLowerCase() });
  }
  return [...out.values()];
}

/** Где лежит звук (у нас) и ссылка на него рядом с .strm. */
const store = (hash: string, v: VoiceFile) => path.join(env.streamDir, VOICES_DIR, hash, `${v.id}${v.ext}`);
const slot = (strm: string, v: VoiceFile) => path.join(path.dirname(strm), `${path.basename(strm, ".strm")}.${v.lang}.${v.group}${v.ext}`);

/**
 * Ссылки «<серия>.ru.<Студия>.mka» → .voices/<хэш>/<файл> рядом с .strm серий раздачи (из streamRelease — до первого
 * запуска, иначе Jellyfin их не увидит до сброса кэша). Ссылка относительная: у Jellyfin папка «Стрима» другая.
 */
export function placeVoiceSlots(files: TsFile[], hash: string, episodes: { strm: string; index: number }[]) {
  const dir = path.join(env.streamDir, VOICES_DIR);
  fs.mkdirSync(path.join(dir, hash), { recursive: true });
  // Папку со звуком Jellyfin не сканирует
  if (!fs.existsSync(path.join(dir, ".ignore"))) fs.writeFileSync(path.join(dir, ".ignore"), "");
  for (const e of episodes) {
    for (const v of voicesForVideo(files, e.index)) {
      const link = slot(e.strm, v);
      if (fs.existsSync(link) || isLink(link)) continue;
      fs.symlinkSync(path.relative(path.dirname(link), store(hash, v)).split(path.sep).join("/"), link);
    }
  }
}

const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Список файлов раздачи — у TorrServer, без сети; но каждый запрос будит раздачу — помним 5 мин
const filesMemo = new Map<string, { at: number; files: TsFile[] }>();
async function filesOf(hash: string): Promise<TsFile[]> {
  const hit = filesMemo.get(hash);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.files;
  const files = await torrentFiles(hash);
  filesMemo.set(hash, { at: Date.now(), files });
  return files;
}

type StreamItem = Pick<JfEpisodeItem, "itemId" | "hash" | "index" | "strmPath">;

/** Озвучки серии «Стрима» в её раздаче и какие уже скачаны. Ссылок нет (раздача старше) — завести. */
export async function episodeVoices(item: StreamItem): Promise<EpisodeVoice[]> {
  if (!item.hash || !item.index || !item.strmPath) return [];
  const files = await filesOf(item.hash);
  placeVoiceSlots(files, item.hash, [{ strm: item.strmPath, index: item.index }]);
  // Звук скачан — по ссылке или (раньше) файлом рядом с .strm
  return voicesForVideo(files, item.index).map((v) => ({ ...v, have: fs.existsSync(store(item.hash!, v)) || (!isLink(slot(item.strmPath!, v)) && fs.existsSync(slot(item.strmPath!, v))) }));
}

const inflight = new Map<string, Promise<void>>();

/** Скачать звук серии (один файл — один раз, даже если его просят плеер и подготовка серии одновременно). */
export function fetchVoice(item: StreamItem, group: string): Promise<void> {
  const key = `${item.hash}:${item.index}:${group}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const v = (await episodeVoices(item)).find((x) => x.group === group);
    if (!v) throw new Error(`В раздаче нет озвучки «${group}» для этой серии`);
    if (v.have) return;
    const file = store(item.hash!, v);
    const part = `${file}.part`;
    const res = await fetch(`${env.torrserverUrl}/stream/${encodeURIComponent(`voice${v.ext}`)}?link=${item.hash}&index=${v.id}&play`, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`TorrServer: HTTP ${res.status}`);
    // Кусками, как подготовка серии (pipeline из fetch роняет undici на обрыве)
    const fh = await open(part, "w");
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value);
      }
      await fh.close();
      await rename(part, file);
    } catch (e) {
      await fh.close().catch(() => undefined);
      await rm(part, { force: true });
      throw e;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Раздачу убрали из TorrServer — её звук больше не нужен (ссылки уходят вместе с .strm). */
export function dropVoices(hash: string) {
  if (/^[0-9a-f]{40}$/.test(hash)) fs.rmSync(path.join(env.streamDir, VOICES_DIR, hash), { recursive: true, force: true });
}

/** Какую озвучку пользователь выбрал у тайтла (студия). */
export const voicePref = (userId: number, anilistId: number) =>
  db.prepare<[number, number], { voice: string }>("SELECT voice FROM voice_pref WHERE user_id = ? AND anilist_id = ?").get(userId, anilistId)?.voice ?? null;

export function setVoicePref(userId: number, anilistId: number, voice: string) {
  db.prepare(`INSERT INTO voice_pref (user_id, anilist_id, voice, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, anilist_id) DO UPDATE SET voice = excluded.voice, updated_at = excluded.updated_at`).run(userId, anilistId, voice, now());
}

/**
 * Подготовка серии «Стрима» (prebuffer.ts): заодно скачать озвучку, которую зрители выбрали у тайтла, — серия
 * откроется сразу с ней.
 */
export async function prepareVoices(hash: string, index: number, userIds: number[]) {
  const anilistId = await streamAnilistId(hash);
  if (!anilistId) return;
  const wants = new Set(userIds.map((u) => voicePref(u, anilistId)).filter((v): v is string => Boolean(v)));
  if (!wants.size) return;
  const item = [...(await episodeItems(anilistId)).values()].flat().find((i) => i.hash === hash && i.index === index);
  if (!item?.strmPath) return;
  const voices = await episodeVoices(item);
  for (const w of wants) {
    const v = voices.find((x) => x.group === w);
    if (v && !v.have) await fetchVoice(item, v.group).catch((e) => console.warn(`[voices] ${hash}:${index} ${w}: ${String(e)}`));
  }
}
