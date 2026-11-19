import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const children = new Set();
let preparing = false;
export function stopPreparation() {
  for (const child of children) child.kill();
}
const unpack = (p) => p.replace("app.asar", "app.asar.unpacked");
function run(binary, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    let err = "",
      tail = "";
    child.stdout.on("data", (b) => {
      tail += b;
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", (b) => {
      err = (err + b).slice(-3000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Подготовка завершилась с ошибкой (${code}). ${err}`),
          ),
    );
  });
}
export async function prepare(library, id) {
  if (preparing) throw new Error("Уже готовится другая серия");
  preparing = true;
  try {
    return await prepareOne(library, id);
  } finally {
    preparing = false;
  }
}
async function prepareOne(library, id) {
  const f = library.files.find((x) => x.id === id);
  if (!f) throw new Error("Серия не найдена");
  if (library.files.some((x) => x.state === "preparing"))
    throw new Error("Уже готовится другая серия");
  // A failed transcode is retryable; refresh still rejects a missing or changed source.
  if (f.state === "error") { f.state = "imported"; delete f.error; }
  await library.refresh();
  if (f.state === "error") throw new Error(f.error);
  const ffmpeg = unpack(require("ffmpeg-static")),
    ffprobe = unpack(require("ffprobe-static").path);
  let duration = 0;
  await run(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      f.path,
    ],
    (line) => {
      duration = Number(line);
    },
  );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Не удалось определить длительность");
  const dir = join(library.directory, "prepared");
  await mkdir(dir, { recursive: true });
  const output = join(dir, `${f.id}.mp4`),
    temporary = join(dir, `${f.id}.partial.mp4`);
  f.state = "preparing";
  f.progress = 0;
  delete f.error;
  await library.save();
  try {
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-y",
        "-i",
        f.path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        temporary,
      ],
      (line) => {
        if (line.startsWith("out_time_us="))
          f.progress = Math.min(0.99, Number(line.slice(12)) / 1e6 / duration);
      },
    );
    await library.refresh();
    if (f.state === "error") throw new Error(f.error);
    await rename(temporary, output);
    f.output = output;
    f.duration = duration;
    f.state = "ready";
    f.progress = 1;
  } catch (e) {
    f.state = "error";
    f.error = e.message;
    await unlink(temporary).catch(() => {});
    throw e;
  } finally {
    await library.save();
  }
}
