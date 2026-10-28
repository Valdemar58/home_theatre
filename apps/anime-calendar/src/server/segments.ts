import "server-only";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commonRun, pickSegment, type Segment } from "@/lib/fingerprint";
import { db, now } from "./db";
import { env } from "./env";
import { episodeItems, type JfEpisodeItem } from "./playback";
import { registerHandler, startTask } from "./tasks";
import { torrentFilesCached } from "./stream";

// Пропуск опенингов и эндингов (TASKS 9.3). Отрезки привязаны к конкретному файлу (у релизов свои тайминги):
// главы файла — сразу при открытии серии (player.ts), иначе — звуковой отпечаток: задача «segments» по тайтлу снимает
// отпечатки начала (6 мин) и конца (4 мин) каждой серии (ffmpeg → fpcalc) и ищет общий отрезок с соседними сериями.

const run = promisify(execFile);
const HEAD = 360;
const TAIL = 240;

/** Ключ файла: серия библиотеки — элемент Jellyfin, серия «Стрима» — раздача и файл. */
export const itemKey = (i: JfEpisodeItem) => (i.hash && i.index ? `ts:${i.hash}:${i.index}` : `jf:${i.itemId}`);

/** Отрезки файла, найденные по звуку. */
export const storedSegments = (key: string): Segment[] =>
  db.prepare<[string], Segment>(`SELECT kind, start_s AS start, end_s AS "end" FROM episode_segments WHERE item_key = ? ORDER BY start_s`).all(key);

/** Видео для ffmpeg: библиотека — поток Jellyfin с ключом, «Стрим» — ссылка TorrServer. */
const sourceOf = (i: JfEpisodeItem) =>
  i.strm ? { url: i.strm, headers: [] as string[] }
    : { url: `${env.jellyfinUrl}/Videos/${i.itemId}/stream?static=true`, headers: ["-headers", `Authorization: MediaBrowser Token="${env.jellyfinApiKey}"\r\n`] };

async function duration(i: JfEpisodeItem): Promise<number> {
  if (i.runtimeSec) return i.runtimeSec;
  const s = sourceOf(i);
  const { stdout } = await run("ffprobe", ["-v", "error", ...s.headers, "-show_entries", "format=duration", "-of", "csv=p=0", s.url], { timeout: 60_000 });
  return Number(stdout.trim()) || 0;
}

/** Отпечаток отрезка серии: ffmpeg вытягивает звук (моно 11 кГц) во временный wav, fpcalc считает. */
async function fingerprint(i: JfEpisodeItem, from: number, len: number, dir: string, signal: AbortSignal): Promise<number[]> {
  const s = sourceOf(i);
  const wav = path.join(dir, `${from}.wav`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", ...s.headers, "-ss", String(from), "-i", s.url, "-t", String(len), "-vn", "-ac", "1", "-ar", "11025", "-y", wav]);
    const kill = () => p.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, 180_000);
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (code === 0) resolve(); else reject(new Error(`ffmpeg: код ${code}`));
    });
  });
  const { stdout } = await run("fpcalc", ["-raw", "-json", "-length", String(len), wav], { timeout: 60_000, maxBuffer: 20e6 });
  return (JSON.parse(stdout) as { fingerprint: number[] }).fingerprint;
}

type Fp = { key: string; ep: number; dur: number; head: number[]; tail: number[] };

/** Отпечатки файла: из базы или снять (и сохранить). */
async function fpOf(i: JfEpisodeItem, ep: number, signal: AbortSignal): Promise<Fp | null> {
  const key = itemKey(i);
  const row = db.prepare<[string], { dur: number; head: string; tail: string }>("SELECT dur, head, tail FROM episode_fp WHERE item_key = ?").get(key);
  if (row) return { key, ep, dur: row.dur, head: JSON.parse(row.head), tail: JSON.parse(row.tail) };
  const dur = await duration(i);
  if (dur < 300) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "fp-"));
  try {
    const head = await fingerprint(i, 0, HEAD, dir, signal);
    const tail = await fingerprint(i, Math.max(0, dur - TAIL), TAIL, dir, signal);
    db.prepare("INSERT OR REPLACE INTO episode_fp (item_key, dur, head, tail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, dur, JSON.stringify(head), JSON.stringify(tail), now());
    return { key, ep, dur, head, tail };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Файлы серий тайтла, по которым можно снять отпечатки: библиотека, «Стрим» — если начало уже в кэше TorrServer. */
async function candidates(anilistId: number): Promise<{ ep: number; item: JfEpisodeItem }[]> {
  const items = await episodeItems(anilistId);
  const cached = new Map<string, Map<number, number>>();
  const out: { ep: number; item: JfEpisodeItem }[] = [];
  for (const [ep, list] of [...items].sort((a, b) => a[0] - b[0])) {
    const lib = list.find((x) => x.where === "library");
    if (lib) { out.push({ ep, item: lib }); continue; }
    const s = list.find((x) => x.hash && x.index);
    if (!s) continue;
    if (!cached.has(s.hash!)) cached.set(s.hash!, (await torrentFilesCached(s.hash!).catch(() => null))?.files ?? new Map());
    // Начало серии (≈ четверть файла) уже скачано — снять отпечаток дёшево
    if ((cached.get(s.hash!)!.get(s.index!) ?? 0) >= 0.3) out.push({ ep, item: s });
  }
  return out;
}

/** Отрезки серии по соседям: опенинг — общий отрезок начала, эндинг — конца (со смещением от начала файла). */
function segmentsOf(f: Fp, neighbours: Fp[]): Segment[] {
  const op = pickSegment("op", neighbours.flatMap((n) => {
    const r = commonRun(f.head, n.head);
    return r ? [{ start: r.a0, end: r.a1 }] : [];
  }));
  const tailFrom = Math.max(0, f.dur - TAIL);
  const ed = pickSegment("ed", neighbours.flatMap((n) => {
    const r = commonRun(f.tail, n.tail);
    return r ? [{ start: r.a0, end: r.a1 }] : [];
  }), tailFrom);
  return [op, ed].filter((s): s is Segment => Boolean(s));
}

registerHandler("segments", {
  noun: "Опенинги найдены",
  title: async (key) => `Опенинги и эндинги · тайтл ${key}`,
  anilistId: async (key) => Number(key),
  fresh: () => false,
  href: (key) => `/anime/${key}`,
  run: async (key, signal) => {
    const anilistId = Number(key);
    const list = await candidates(anilistId);
    const fps: Fp[] = [];
    for (const c of list) {
      signal.throwIfAborted();
      const f = await fpOf(c.item, c.ep, signal).catch((e) => { console.warn(`[segments] ${anilistId}/${c.ep}: ${String(e)}`); return null; });
      if (f) fps.push(f);
    }
    // Соседи — две ближайшие серии с каждой стороны (OP/ED меняются по ходу сезона)
    let found = 0;
    const del = db.prepare("DELETE FROM episode_segments WHERE item_key = ?");
    const put = db.prepare("INSERT INTO episode_segments (item_key, anilist_id, ep, kind, start_s, end_s, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'fingerprint', ?)");
    fps.forEach((f, i) => {
      const neighbours = [fps[i - 1], fps[i + 1], fps[i - 2], fps[i + 2]].filter((x): x is Fp => Boolean(x));
      const segs = segmentsOf(f, neighbours);
      del.run(f.key);
      for (const s of segs) put.run(f.key, anilistId, f.ep, s.kind, s.start, s.end, now());
      if (segs.length) found++;
    });
    return { summary: `Отрезки найдены у ${found} из ${fps.length} серий`, isNew: found > 0, silent: true };
  },
});

/**
 * У открытой серии ещё нет отпечатка — поставить поиск по тайтлу в фон (из плеера). Снятые отпечатки задача берёт
 * из базы, так что повтор дешёвый: досчитываются только новые серии и их соседи.
 */
export function ensureSegments(anilistId: number, key: string) {
  const has = db.prepare<[string], { x: number }>("SELECT 1 x FROM episode_fp WHERE item_key = ?").get(key);
  if (!has) void startTask("segments", String(anilistId), { origin: "auto" }).catch(() => undefined);
}
