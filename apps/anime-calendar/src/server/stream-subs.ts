import "server-only";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { torrentFiles } from "./stream";

// Русские субтитры из раздачи «Стрима» (TASKS 9.3а). В RU-раздачах они лежат отдельно от видео: «RUS Subs/[Студия]/…ass»,
// надписи — в «…/надписи», шрифты — в «Fonts». Видео не нужно: TorrServer отдаёт каждый файл раздачи по отдельности,
// субтитры и шрифты — мегабайты. Скачиваем в DATA_DIR/stream-subs/<хэш>/ и описываем в manifest.json; плеер
// показывает их дорожками («Русский · AniLibria», «… (надписи)») со шрифтами раздачи.

export type StreamSub = { video: number; group: string | null; signs: boolean; file: string };
/** voices — студии озвучек отдельными файлами («RUS Sound/[Студия]»): онлайн их не сыграть, «Скачать» соберёт в серию. */
type Manifest = { subs: StreamSub[]; fonts: string[]; voices?: string[]; at: number };
const AUDIO = /\.(mka|ac3|eac3|dts|aac|flac|mp3|opus)$/i;

const SUB = /\.(ass|ssa|srt)$/i;
const FONT = /\.(ttf|otf|ttc|woff2?)$/i;
const root = (hash: string) => path.join(env.dataDir, "stream-subs", hash);
const base = (p: string) => path.basename(p).replace(/\.[^.]+$/, "");

/** Субтитры и шрифты раздачи уже скачаны. */
export function streamSubs(hash: string): Manifest | null {
  const f = path.join(root(hash), "manifest.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as Manifest) : null;
}

/**
 * Студия — ближайшая папка в квадратных скобках («[AniLibria]»), иначе имя папки внутри раздачи (корень — название
 * сериала, не студия); не нашлась — null (подпишем меткой релизера). Надписи — папка «надписи»/«signs».
 */
export function subGroup(p: string): { group: string | null; signs: boolean } {
  const dirs = p.split("/").slice(0, -1);
  const signs = dirs.some((d) => /надпис|signs?$|forced/i.test(d));
  const named = [...dirs].reverse().find((d) => /^\[.+\]$/.test(d.trim()));
  const fallback = dirs.slice(1).reverse().find((d) => !/надпис|signs?|subs?|rus|fonts?/i.test(d));
  const g = named ?? fallback;
  return { group: g ? g.replace(/^\[|\]$/g, "").trim() : null, signs };
}

/** Метка релизера из названия раздачи: последние квадратные скобки («… [WEBRip] [HWP]» → «HWP»). */
export const releaseTag = (title: string) => /\[([^\][]{2,24})\]\s*$/.exec(title.trim())?.[1] ?? null;

/**
 * Скачать субтитры и шрифты раздачи (уже скачанное — не трогаем). Субтитр относится к видео, если его имя начинается
 * с имени видеофайла («… - 01 [BDRip].AniLibria.ass» → «… - 01 [BDRip].mkv»).
 */
export async function syncStreamSubs(hash: string, signal?: AbortSignal): Promise<Manifest | null> {
  const have = streamSubs(hash);
  if (have) return have;
  const files = await torrentFiles(hash);
  const videos = files.filter((f) => /\.(mkv|mp4|m4v|avi|ts|m2ts|webm)$/i.test(f.path));
  const subs = files.filter((f) => SUB.test(f.path));
  const voices = [...new Set(files.filter((f) => AUDIO.test(f.path)).flatMap((f) => subGroup(f.path).group ?? []))];
  if (!subs.length) {
    await mkdir(root(hash), { recursive: true });
    const m: Manifest = { subs: [], fonts: [], voices, at: Date.now() };
    await writeFile(path.join(root(hash), "manifest.json"), JSON.stringify(m));
    return m;
  }
  const get = async (id: number, p: string) => {
    signal?.throwIfAborted();
    const res = await fetch(`${env.torrserverUrl}/stream/${encodeURIComponent(path.basename(p))}?link=${hash}&index=${id}&play`, { signal: signal ?? AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`TorrServer: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  await mkdir(path.join(root(hash), "fonts"), { recursive: true });
  const out: StreamSub[] = [];
  for (const s of subs) {
    const name = base(s.path);
    // Самое длинное совпадение имени: «… - 1» не должно поймать «… - 10»
    const video = videos.filter((v) => name.startsWith(base(v.path))).sort((a, b) => base(b.path).length - base(a.path).length)[0];
    if (!video) continue;
    const { group, signs } = subGroup(s.path);
    const file = `${video.id}-${out.length}${path.extname(s.path).toLowerCase()}`;
    await writeFile(path.join(root(hash), file), await get(s.id, s.path));
    out.push({ video: video.id, group, signs, file });
  }
  const fonts: string[] = [];
  for (const f of files.filter((x) => FONT.test(x.path))) {
    const file = `fonts/${f.id}${path.extname(f.path).toLowerCase()}`;
    await writeFile(path.join(root(hash), file), await get(f.id, f.path)).then(() => fonts.push(file)).catch(() => undefined);
  }
  const m: Manifest = { subs: out, fonts, voices, at: Date.now() };
  await writeFile(path.join(root(hash), "manifest.json"), JSON.stringify(m));
  return m;
}

/** Субтитры к видео раздачи: если у студии есть и ASS, и SRT одного перевода — только ASS (со стилями). */
export function subsForVideo(m: Manifest, video: number): StreamSub[] {
  const own = m.subs.filter((s) => s.video === video);
  const hasAss = new Set(own.filter((s) => !s.file.endsWith(".srt")).map((s) => `${s.group}:${s.signs}`));
  return own.filter((s) => !s.file.endsWith(".srt") || !hasAss.has(`${s.group}:${s.signs}`));
}

/** Файл субтитров или шрифта раздачи для плеера (путь проверен: только внутри папки раздачи). */
export async function streamSubFile(hash: string, rel: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{40}$/.test(hash) || !/^(fonts\/)?\d+(-\d+)?\.[a-z0-9]+$/.test(rel)) return null;
  const f = path.join(root(hash), rel);
  return fs.existsSync(f) ? readFile(f) : null;
}

/** Раздача добавлена или серия открыта — скачать субтитры в фоне (один раз на раздачу). */
const inflight = new Set<string>();
export function syncStreamSubsSoon(hash: string) {
  if (streamSubs(hash) || inflight.has(hash)) return;
  inflight.add(hash);
  void syncStreamSubs(hash).catch((e) => console.warn(`[stream-subs] ${hash}: ${String(e)}`)).finally(() => inflight.delete(hash));
}
