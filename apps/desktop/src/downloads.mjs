import WebTorrent from "webtorrent";
import parseTorrent from "parse-torrent";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, statfs, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveMagnet } from "./magnet.mjs";
import { identifyFile } from "./file-identity.mjs";

export function episodeGuess(name) {
  const base = path.basename(name).replace(/\.[^.]+$/, "");
  const match = base.match(/(?:S\d{1,2}E|\bEP?\s*)(\d{1,3})(?!\d)/i) || base.match(/(?:^|\s-\s|\[)(\d{1,3})(?:\]|\s|$)/);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}
export async function inspectTorrent(bytes) {
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Некорректный размер torrent-файла");
  const info = await parseTorrent(bytes);
  if (!info.infoHash || !info.files?.length || info.files.length > 5000) throw new Error("Раздача не содержит поддерживаемого списка файлов");
  const names = new Set();
  const files = info.files.map((f, index) => {
    const name = f.path.replaceAll("\\", "/");
    if (path.isAbsolute(name) || name.split("/").some(p => !p || p === "." || p === ".." || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Раздача содержит небезопасное имя файла");
    if (names.has(name.toLowerCase())) throw new Error("В раздаче повторяются имена файлов");
    names.add(name.toLowerCase());
    if (!Number.isSafeInteger(f.length) || f.length < 0) throw new Error("Некорректный размер файла");
    return { index, path: name, name: path.basename(name), bytes: f.length, video: /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts)$/i.test(name), episode: episodeGuess(name) };
  });
  return { hash: info.infoHash, name: info.name, files };
}

export class Downloads {
  constructor(directory, library, prepare, options = {}) {
    this.directory = directory; this.library = library; this.prepare = prepare;
    this.jobs = []; this.active = new Map(); this.writes = Promise.resolve(); this.busy = false; this.closed = false;
    this.operations = Promise.resolve();
    for (const name of ["inspect", "start", "resume", "pause", "cancel", "forget", "removeEpisode", "removeLibrary", "close"]) {
      const operation = this[name].bind(this);
      this[name] = (...args) => this.serial(() => operation(...args));
    }
    this.options = options;
  }
  connect() {
    if (this.client) return;
    const { isInUse, validateFolder, ...torrentOptions } = this.options;
    this.client = new WebTorrent({ utp: false, natUpnp: false, natPmp: false, lsd: false, webSeeds: false, maxConns: 30, ...torrentOptions });
    this.client.on("error", () => { for (const j of this.jobs) if (this.active.has(j.id)) { j.state = "error"; j.error = "Ошибка торрент-соединения. Приостановите загрузку и повторите."; } });
  }
  serial(operation) { const result = this.operations.then(operation, operation); this.operations = result.catch(() => {}); return result; }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try { this.jobs = JSON.parse(await readFile(path.join(this.directory, "downloads.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    // Resume is explicit after a process restart; partial files are verified on resume.
    for (const j of this.jobs) if (["downloading", "verifying", "preparing"].includes(j.state)) j.state = "paused";
    this.timer = setInterval(() => void this.tick().catch(() => {}), 700); this.timer.unref();
  }
  save() {
    const data = JSON.stringify(this.jobs);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await writeFile(path.join(this.directory, "downloads.json.tmp"), data, { mode: 0o600 });
      await rename(path.join(this.directory, "downloads.json.tmp"), path.join(this.directory, "downloads.json"));
    });
    return this.writes;
  }
  async inspect(base64, title, titleName, releaseName, commandId) {
    const existing = commandId && this.jobs.find(j => j.commandId === commandId);
    if (existing) return this.view(existing);
    if (this.closed) throw new Error("Приложение завершается");
    if (!Number.isSafeInteger(title) || title < 1) throw new Error("Выберите тайтл");
    const metadata = await inspectTorrent(Buffer.from(base64, "base64"));
    if (this.jobs.some(j => j.hash === metadata.hash && j.state !== "cancelled")) throw new Error("Эта раздача уже добавлена. Используйте её в загрузках.");
    if (this.jobs.length >= 100) throw new Error("В списке уже 100 раздач. Уберите завершённые записи.");
    const job = { id: randomUUID(), ...metadata, title, titleName: String(titleName || title).slice(0, 250), releaseName: String(releaseName || metadata.name).slice(0, 500), torrent: base64, state: "selecting", selected: [], autoPrepare: true };
    if (commandId) job.commandId = commandId;
    this.jobs.push(job); await this.save(); return this.view(job);
  }
  async inspectMagnet(uri, title, titleName, releaseName, commandId) {
    const existing = commandId && this.jobs.find(j => j.commandId === commandId);
    if (existing) return this.view(existing);
    if (this.metadataAbort) throw new Error("Уже получаем список файлов. Дождитесь результата или отмените запрос.");
    if (this.closed) throw new Error("Приложение завершается");
    const controller = new AbortController(); this.metadataAbort = controller;
    try {
      const bytes = await resolveMagnet(uri, { signal: controller.signal });
      if (this.closed || controller.signal.aborted) throw new Error("Получение списка файлов отменено");
      return await this.inspect(bytes.toString("base64"), title, titleName, releaseName, commandId);
    } finally { if (this.metadataAbort === controller) this.metadataAbort = null; }
  }
  cancelMetadata() { this.metadataAbort?.abort(); }
  view(j) {
    const t = this.active.get(j.id);
    return { id: j.id, title: j.title, titleName: j.titleName, releaseName: j.releaseName, state: j.state, error: j.error, folder: j.folder, storageId:j.storageId, autoPrepare: j.autoPrepare,
      speed: t?.downloadSpeed || 0, peers: t?.numPeers || 0, files: j.files.map(f => {
        const selection = j.selected.find(s => s.index === f.index), lib = this.library.files.find(l => l.id === selection?.libraryId);
        return { ...f, selected: !!selection, episode: selection?.episode ?? f.episode, downloaded: t?.files[f.index]?.downloaded ?? selection?.downloaded ?? 0, libraryId: lib?.id, preparedBytes:lib?.preparedBytes||0, inUse:!!this.options.isInUse?.(lib?.id), prepareState: lib?.state, prepareProgress: lib?.progress || 0, error: selection?.error || lib?.error };
      }) };
  }
  snapshot() { return this.jobs.map(j => this.view(j)); }
  get(id) { const j = this.jobs.find(j => j.id === id); if (!j) throw new Error("Загрузка не найдена"); return j; }
  async start(id, selections, folder, autoPrepare = true) {
    const j = this.get(id);
    if (j.state !== "selecting") throw new Error("Раздача уже настроена");
    if (!Array.isArray(selections) || !selections.length || selections.length > 500) throw new Error("Выберите от 1 до 500 серий");
    const indices = new Set(), episodes = new Set();
    for (const s of selections) {
      if (!Number.isSafeInteger(s.index) || !j.files[s.index]?.video || !Number.isSafeInteger(s.episode) || s.episode < 1 || s.episode > 10000 || indices.has(s.index) || episodes.has(s.episode)) throw new Error("У каждой выбранной серии должен быть уникальный номер");
      indices.add(s.index); episodes.add(s.episode);
    }
    await mkdir(folder, { recursive: true });
    const disk = await statfs(folder);
    const needed = selections.reduce((n, s) => n + j.files[s.index].bytes, 0);
    if (disk.bavail * disk.bsize < needed + 256 * 1024 * 1024) throw new Error("Недостаточно места для выбранных серий. Выберите другую папку.");
    j.folder = path.join(path.resolve(folder), j.id); j.autoPrepare = !!autoPrepare;
    j.selected = selections.map(s => ({ index: s.index, episode: s.episode, downloaded: 0 }));
    j.state = "paused"; await this.save(); await this._resume(id);
  }
  async resume(id) { return this._resume(id); }
  async _resume(id) {
    const j = this.get(id);
    if(j.folder)await this.options.validateFolder?.(j.folder,j.storageId);
    if(j.removing) throw new Error("Завершите удаление серии перед продолжением загрузки");
    if (this.active.has(id)) return;
    if (!["paused", "error"].includes(j.state) || !j.folder) throw new Error("Эту загрузку нельзя продолжить");
    if (this.active.size >= 2) throw new Error("Уже скачиваются две раздачи. Приостановите одну из них.");
    // Validate the stored metadata again before writing anything to disk.
    await inspectTorrent(Buffer.from(j.torrent, "base64"));
    await mkdir(j.folder, { recursive: true });
    for (const f of j.files) {
      let location = j.folder;
      for (const segment of ["", ...f.path.split("/")]) {
        if (segment) location = path.join(location, segment);
        try { if ((await lstat(location)).isSymbolicLink()) throw new Error("В папке загрузки обнаружена ссылка. Выберите другую папку."); } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
    }
    j.state = "verifying"; delete j.error;
    this.connect();
    const t = this.client.add(Buffer.from(j.torrent, "base64"), { path: j.folder, deselect: true, storeCacheSlots: 8 });
    this.active.set(id, t);
    t.on("error", () => { if (this.active.get(id) === t) { this.active.delete(id); j.state = "error"; j.error = "Загрузка прервана. Проверьте место на диске и повторите."; void this.save(); } });
    t.once("ready", () => {
      if (this.active.get(id) !== t) return;
      for (const s of j.selected) t.files[s.index].select();
      j.state = "downloading"; void this.save();
    });
    await this.save();
  }
  async detach(j) {
    const t = this.active.get(j.id);
    if (!t) return;
    for (const s of j.selected) s.downloaded = t.files[s.index]?.downloaded ?? s.downloaded;
    this.active.delete(j.id);
    await new Promise(resolve => t.destroy({ destroyStore: false }, resolve));
  }
  async pause(id) { const j = this.get(id); await this.detach(j); j.state = "paused"; await this.save(); }
  async cancel(id) { const j = this.get(id); await this.detach(j); j.state = "cancelled"; await this.save(); }
  async forget(id) { const j = this.get(id); if (this.active.has(id) || j.state === "preparing") throw new Error("Сначала остановите загрузку"); this.jobs = this.jobs.filter(x => x !== j); await this.save(); }
  checkRemoval(f) {
    if(f?.state==="preparing")throw new Error("Дождитесь окончания подготовки серии");
    if(f && this.options.isInUse?.(f.id))throw new Error("Эта серия сейчас транслируется. Сначала завершите просмотр.");
  }
  async removeLibrary(id) {
    const linked=this.jobs.find(j=>j.selected.some(s=>s.libraryId===id));
    if(linked)return this._removeEpisode(linked.id,linked.selected.find(s=>s.libraryId===id).index);
    const f=this.library.files.find(f=>f.id===id);this.checkRemoval(f);
    await this.library.remove(id); // Imported originals are never owned by the app.
  }
  async removeEpisode(id,index) { return this._removeEpisode(id,index); }
  async _removeEpisode(id,index) {
    const j=this.get(id), selection=j.selected.find(s=>s.index===index);
    if(!selection)return; // A repeated delivery after a lost acknowledgement is harmless.
    await this.options.validateFolder?.(j.folder,j.storageId);
    if(j.removing && j.removing.index!==index)throw new Error("Сначала повторите незавершённое удаление");
    const f=j.files[index];if(!f || !j.folder)throw new Error("Файл серии не найден");
    await inspectTorrent(Buffer.from(j.torrent,"base64"));
    const root=path.resolve(j.folder), target=path.resolve(root,f.path);
    if(path.basename(root)!==j.id || !target.startsWith(root+path.sep))throw new Error("Некорректная папка загрузки");
    // Refuse junctions/symlinks in every ancestor before touching any files.
    let location=target;
    while(true){try{if((await lstat(location)).isSymbolicLink())throw new Error("Удаление через ссылку запрещено");}catch(e){if(e.code!=="ENOENT")throw e;}const parent=path.dirname(location);if(parent===location)break;location=parent;}
    const libraryFile=this.library.files.find(f=>f.id===selection.libraryId);
    this.checkRemoval(libraryFile);
    const other=this.jobs.flatMap(job=>job.selected.filter(s=>s.libraryId && s.libraryId===selection.libraryId && (job.id!==id||s.index!==index)).map(s=>({job,s})))[0];
    if(other && libraryFile && path.resolve(libraryFile.path)===target) {
      const otherPath=path.join(other.job.folder,other.job.files[other.s.index].path);
      if((await identifyFile(otherPath)).version!==libraryFile.version)throw new Error("Другая копия серии изменилась. Сначала проверьте её в библиотеке.");
      await this.library.add(otherPath,libraryFile.title,libraryFile.ep);
    }
    await this.detach(j);j.state="paused";j.removing={index};await this.save();
    if(selection.libraryId && !other)await this.library.remove(selection.libraryId);
    await unlink(target).catch(e=>{if(e.code!=="ENOENT")throw e;});
    j.selected=j.selected.filter(s=>s.index!==index);delete j.removing;delete j.error;
    if(!j.selected.length)j.state="cancelled";
    else if(j.selected.every(s=>this.library.files.find(f=>f.id===s.libraryId)?.state==="ready"))j.state="ready";
    await this.save();
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    return this.serial(async () => { try {
      for (const j of this.jobs) {
        const t = this.active.get(j.id);
        if (t?.ready) {
          for (const s of j.selected) {
            const f = t.files[s.index]; s.downloaded = f.downloaded;
            if (f.progress === 1 && !s.libraryId && !s.error) {
              try { const l = await this.library.add(path.join(j.folder, j.files[s.index].path), j.title, s.episode); l.titleName = j.titleName; l.preparedDirectory=path.join(j.folder,".prepared"); s.libraryId = l.id; await this.library.save(); }
              catch (e) { s.error = e.message; }
            }
          }
          if (j.selected.every(s => t.files[s.index].progress === 1)) { await this.detach(j); j.state = "downloaded"; await this.save(); }
        }
      }
      // One expensive preparation at a time; downloads continue while FFmpeg works.
      if (!this.preparing && !this.library.files.some(f => f.state === "preparing")) {
        for (const j of this.jobs) {
          if (!j.autoPrepare || ["paused", "cancelled", "selecting", "error"].includes(j.state)) continue;
          const f = j.selected.map(s => this.library.files.find(f => f.id === s.libraryId)).find(f => f?.state === "imported");
          if (f) {
            this.preparing = true;
            void this.prepare(this.library, f.id).catch(e => { f.state = "error"; f.error = e.message; return this.library.save(); }).finally(() => { this.preparing = false; });
            break;
          }
        }
      }
      for (const j of this.jobs) {
        if (j.state === "error" && j.selected.length && j.selected.every(s => this.library.files.find(f => f.id === s.libraryId)?.state === "ready")) {
          j.state = "ready"; delete j.error;
        }
      }
      for (const j of this.jobs) if (["downloaded", "preparing"].includes(j.state) && j.autoPrepare) {
        const files = j.selected.map(s => this.library.files.find(f => f.id === s.libraryId));
        j.state = files.every(f => f?.state === "ready") ? "ready" : "preparing";
        if (files.some(f => f?.state === "error") || j.selected.some(s => s.error)) { j.state = "error"; j.error = "Не все серии подготовлены. Повторите подготовку в библиотеке."; }
      }
      const serialized = JSON.stringify(this.jobs);
      if (serialized !== this.lastSaved) { await this.save(); this.lastSaved = serialized; }
    } finally { this.busy = false; } });
  }
  async close() { this.closed = true; this.cancelMetadata(); clearInterval(this.timer); for (const j of this.jobs) await this.detach(j); await this.save(); if (this.client) await new Promise(resolve => this.client.destroy(resolve)); }
}
