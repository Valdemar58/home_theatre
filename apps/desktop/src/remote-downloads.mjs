import { readFile, writeFile, rename } from "node:fs/promises";
import { storageSnapshot } from "./storage.mjs";
// Commands may be delivered again after a lost acknowledgement. Persist receipts
// before sending; inspect also persists its command ID with the actual local job.
export class RemoteDownloads {
  constructor(downloads, request, file, folder) {
    this.downloads = downloads; this.request = request; this.file = file; this.folder = folder; this.receipts = {}; this.busy = false;
  }
  async load() {
    try { this.receipts = JSON.parse(await readFile(this.file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  snapshot() {
    return this.downloads.snapshot().map(({ folder, ...j }) => ({ ...j, files: j.files.map(({ path, ...f }) => f) }));
  }
  async report() {
    if(!this.storageAt || Date.now()-this.storageAt>30000) {
      this.storageAt=Date.now();
      try{this.storage=await storageSnapshot(this.downloads,this.folder());}catch{this.storage={error:"Не удалось прочитать место на диске",volumes:[]};}
    }
    return {jobs:this.snapshot(),storage:this.storage,capabilities:["episode-delete-v1"],library:this.downloads.library.files.map(f=>({id:f.id,title:f.title,titleName:f.titleName||`Тайтл ${f.title}`,ep:f.ep,bytes:f.bytes,preparedBytes:f.preparedBytes||0,state:f.state,progress:f.progress||0,inUse:!!this.downloads.options.isInUse?.(f.id)}))};
  }
  async execute(c) {
    const p = c.payload, d = this.downloads;
    if(c.kind==="remove-episode") {
      if(p.library)await d.removeLibrary(p.library);else await d.removeEpisode(p.job,p.index);
      this.storageAt=0;return {removed:true};
    }
    if (c.kind === "inspect") {
      const j = await (p.magnet ? d.inspectMagnet(p.magnet, p.title, p.titleName, p.releaseName, c.id) : d.inspect(p.torrent, p.title, p.titleName, p.releaseName, c.id));
      if (p.episodes?.length && d.get(j.id).state === "selecting") {
        const selections = p.episodes.map(episode => {
          const matches = j.files.filter(f => f.video && f.episode === episode);
          if (matches.length !== 1) throw new Error(`Для серии ${episode} нужно уточнить файл в загрузках. Автоматический выбор остановлен.`);
          return { index: matches[0].index, episode };
        });
        await d.start(j.id, selections, this.folder(), true);
      }
      return { job: j.id };
    }
    const j = d.get(p.job);
    if (c.kind === "start") {
      if (j.state === "selecting") await d.start(j.id, p.selections, this.folder(), true);
      // A start may have persisted selections before the process stopped.
      else if (j.state === "paused" && j.folder) await d.resume(j.id);
    } else if (c.kind === "pause") { if (j.state !== "paused" && j.state !== "cancelled") await d.pause(j.id); }
    else if (c.kind === "resume") { if (["paused", "error"].includes(j.state)) await d.resume(j.id); }
    else if (c.kind === "cancel") { if (j.state !== "cancelled") await d.cancel(j.id); }
    else throw new Error("Неизвестное действие очереди");
    return { job: j.id };
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { commands } = await this.request(await this.report());
      for (const c of commands) {
        let receipt = this.receipts[c.id];
        if (!receipt) {
          try { receipt = { id: c.id, result: await this.execute(c) }; }
          catch (e) { receipt = { id: c.id, error: e.message }; }
          this.receipts[c.id] = receipt;
          await writeFile(this.file + ".tmp", JSON.stringify(this.receipts), { mode: 0o600 });
          await rename(this.file + ".tmp", this.file);
        }
        await this.request({ receipt, ...await this.report() });
      }
    } finally { this.busy = false; }
  }
}
