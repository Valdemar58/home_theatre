import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

// Миниатюры шкалы для скачанных серий «Стрима» (TASKS 9.13). Jellyfin делает trickplay только в библиотеках, где
// файл на диске (у «Стрима» он выкачивал бы раздачу целиком) — у скачанной серии файл есть, плитки делаем сами:
// только опорные кадры (декодер пропускает остальные — серия за десятки секунд на CPU), кадр раз в 10 с,
// плитки 10×10 в формате trickplay Jellyfin — плеер показывает их так же.

const INTERVAL_MS = 10_000;
const GRID = 10;
const WIDTH = 320;

export type Thumbs = { width: number; height: number; cols: number; rows: number; count: number; interval: number };

const dirOf = (hash: string, index: number) => path.join(env.dataDir, "thumbs", `${hash}-${index}`);
export const thumbsKey = (hash: string, index: number) => `${hash}-${index}`;
/** Плитка по ключу из адреса (/api/thumbs/<ключ>/<n>.jpg) или null. */
export function thumbFile(key: string, n: number): string | null {
  if (!/^[0-9a-f]{40}-\d+$/.test(key)) return null;
  const f = path.join(env.dataDir, "thumbs", key, `${n}.jpg`);
  return fs.existsSync(f) ? f : null;
}

/** Готовые миниатюры серии или null. */
export function thumbsOf(hash: string, index: number): Thumbs | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(hash, index), "meta.json"), "utf8")) as Thumbs;
  } catch {
    return null;
  }
}

export function dropThumbs(hash: string, index: number) {
  fs.rmSync(dirOf(hash, index), { recursive: true, force: true });
}

// По одной серии за раз: ffmpeg читает гигабайт и декодирует опорные кадры — не мешать просмотру
const g = globalThis as unknown as { __thumbs?: { queue: { hash: string; index: number; file: string }[]; busy: boolean; seen: Set<string> } };
const state = (g.__thumbs ??= { queue: [], busy: false, seen: new Set() });

/** Поставить серию в очередь на миниатюры (уже есть или в очереди — ничего). */
export function ensureThumbs(hash: string, index: number, file: string) {
  const key = thumbsKey(hash, index);
  if (state.seen.has(key) || thumbsOf(hash, index)) return;
  state.seen.add(key);
  state.queue.push({ hash, index, file });
  void pump();
}

async function pump() {
  if (state.busy) return;
  state.busy = true;
  try {
    for (let job = state.queue.shift(); job; job = state.queue.shift()) {
      const t0 = Date.now();
      await build(job.hash, job.index, job.file)
        .then((m) => console.log(`[thumbs] ${job.hash.slice(0, 8)}:${job.index} — ${m.count} кадров за ${Math.round((Date.now() - t0) / 1000)} с`))
        .catch((e) => {
          // Не вышло — в следующий раз попробуем снова (при открытии серии)
          state.seen.delete(thumbsKey(job.hash, job.index));
          console.warn(`[thumbs] ${job.hash.slice(0, 8)}:${job.index}: ${String(e).slice(0, 300)}`);
        });
    }
  } finally {
    state.busy = false;
  }
}

function build(hash: string, index: number, file: string): Promise<Thumbs> {
  const dir = dirOf(hash, index);
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const args = [
    "-n", "15", "ffmpeg", "-hide_banner", "-nostats", "-skip_frame", "nokey", "-i", file, "-an", "-sn", "-dn",
    "-vf", `fps=1000/${INTERVAL_MS},scale=${WIDTH}:-2,tile=${GRID}x${GRID}`, "-q:v", "5", "-start_number", "0",
    path.join(tmp, "%d.jpg"),
  ];
  return new Promise((resolve, reject) => {
    const p = spawn("nice", args);
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 15 * 60_000);
    p.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      // Длительность входа и размер плитки на выходе — из отчёта ffmpeg
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      const size = /Video: mjpeg[^\n]*?(\d{2,5})x(\d{2,5})/.exec(err);
      const tiles = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => f.endsWith(".jpg")).length : 0;
      if (code !== 0 || !d || !size || !tiles) {
        fs.rmSync(tmp, { recursive: true, force: true });
        reject(new Error(`ffmpeg ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
        return;
      }
      const sec = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      const meta: Thumbs = {
        width: WIDTH, height: Math.round(Number(size[2]) / GRID), cols: GRID, rows: GRID,
        count: Math.min(tiles * GRID * GRID, Math.floor((sec * 1000) / INTERVAL_MS) + 1), interval: INTERVAL_MS,
      };
      fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify(meta));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      resolve(meta);
    });
  });
}
