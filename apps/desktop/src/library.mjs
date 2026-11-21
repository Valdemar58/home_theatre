import {
  readFile,
  mkdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { identifyFile } from "./file-identity.mjs";
import { atomicWrite } from "./atomic-file.mjs";

export class Library {
  constructor(directory) {
    this.directory = directory;
    this.files = [];
    this.writes = Promise.resolve();
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.files = JSON.parse(
        await readFile(join(this.directory, "library.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const f of this.files) {
      if (f.state === "preparing") f.state = "imported";
    }
    await this.refresh();
  }
  save() {
    const data = JSON.stringify(this.files);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await atomicWrite(join(this.directory, "library.json"), data);
      });
    return this.writes;
  }
  async add(path, title, ep, onProgress) {
    if (
      !Number.isSafeInteger(title) ||
      title <= 0 ||
      !Number.isSafeInteger(ep) ||
      ep <= 0
    )
      throw new Error("Укажите тайтл и номер серии");
    const identity = await identifyFile(path, { onProgress });
    const old = this.files.find(
      (f) => f.title === title && f.ep === ep && f.version === identity.version,
    );
    if (old) {
      const s = await stat(path);
      old.path = path;
      old.mtime = s.mtimeMs;
      if (old.state === "error") {
        old.state = "imported";
        old.progress = 0;
        delete old.error;
      }
      await this.save();
      return old;
    }
    if (this.files.length >= 500) throw new Error("На устройстве можно подключить до 500 серий");
    const s = await stat(path);
    const f = {
      id: randomUUID(),
      title,
      ep,
      path,
      ...identity,
      mtime: s.mtimeMs,
      state: "imported",
      progress: 0,
    };
    this.files.push(f);
    await this.save();
    return f;
  }
  async refresh() {
    for (const f of this.files) {
      try {
        const s = await stat(f.path);
        if (s.size !== f.bytes || s.mtimeMs !== f.mtime)
          throw new Error("Исходный файл изменён или перемещён");
        if (f.state === "ready") {
          const output = await stat(f.output);
          if (!f.preparedVersion || f.preparedMtime !== output.mtimeMs) {
            const identity = await identifyFile(f.output);
            f.preparedVersion = identity.version;
            f.preparedBytes = identity.bytes;
            f.preparedMtime = output.mtimeMs;
          }
        }
      } catch (e) {
        f.state = "error";
        f.error =
          e.code === "ENOENT"
            ? "Файл не найден. Подключите его заново."
            : e.message;
      }
    }
  }
  publicFiles() {
    return this.files.map(
      ({ id, title, ep, version, bytes, state, progress, preparedVersion, preparedBytes, duration }) => ({
        preparedVersion, preparedBytes, duration,
        id,
        title,
        ep,
        version,
        bytes,
        state,
        progress,
      }),
    );
  }
  async remove(id) {
    const f = this.files.find((x) => x.id === id);
    if (!f) return;
    if (f.state === "preparing") throw new Error("Дождитесь подготовки");
    if(f.state==="moving")throw new Error("Дождитесь переноса серии");
    if (f.output === join(f.preparedDirectory || join(this.directory, "prepared"), `${f.id}.mp4`))
      await unlink(f.output).catch((e) => { if(e.code!=="ENOENT")throw e; });
    this.files = this.files.filter((x) => x.id !== id);
    await this.save();
  }
}
