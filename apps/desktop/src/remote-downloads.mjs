import { readFile, writeFile, rename } from "node:fs/promises";
import { storageSnapshot } from "./storage.mjs";
import { volumeFor } from "./volumes.mjs";
// Commands may be delivered again after a lost acknowledgement. Persist receipts
// before sending; inspect also persists its command ID with the actual local job.
export class RemoteDownloads {
  constructor(downloads, request, file, folder, options={}) {
    this.downloads = downloads; this.request = request; this.file = file; this.folder = folder; this.receipts = {}; this.busy = false;
    this.options=options;
  }
  async load() {
    try { this.receipts = JSON.parse(await readFile(this.file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  snapshot() {
    return this.downloads.snapshot().map(({ folder, ...j }) => ({ ...j,storageId:j.storageId||(folder?this.options.locations?.locationFor(folder)?.id:undefined), files: j.files.map(({ path, ...f }) => f) }));
  }
  async report() {
    await this.options.locations?.scan();
    if(!this.storageAt || Date.now()-this.storageAt>30000) {
      this.storageAt=Date.now();
      try{this.storage=await storageSnapshot(this.downloads,this.folder(),this.options.locations?.locations.map(l=>({...l,default:l.id===this.options.locations.defaultId,online:!l.volumeId||volumeFor(l.folder,this.options.locations.detected)?.id===l.volumeId})));}catch{this.storage={error:"Не удалось прочитать место на диске",volumes:[]};}
      if(this.options.locations)for(const volume of this.storage.volumes)if(volume.targetId)volume.canDisconnect=await this.options.locations.canDisconnect(volume.targetId);
    }
    return {jobs:this.snapshot(),storage:{...this.storage,available:await this.options.locations?.available(),scanError:this.options.locations?.scanError,move:this.options.locations?.progress,recoveryError:this.options.locations?.recoveryError},capabilities:["episode-delete-v1","episode-prepare-v1",...(this.options.locations?["storage-volumes-v1","storage-discovery-v1"]:[])],library:this.downloads.library.files.map(f=>({id:f.id,title:f.title,titleName:f.titleName||`Тайтл ${f.title}`,ep:f.ep,bytes:f.bytes,preparedBytes:f.preparedBytes||0,state:f.state,progress:f.progress||0,inUse:!!this.downloads.options.isInUse?.(f.id)}))};
  }
  async execute(c) {
    const p = c.payload, d = this.downloads;
    if(c.kind==="prepare-episode") {
      const id=p.library||d.get(p.job).selected.find(s=>s.index===p.index)?.libraryId;
      const file=d.library.files.find(f=>f.id===id);
      if(!file)throw new Error("Сначала скачайте серию");
      if(file.state==="ready")return {prepared:true};
      const job=d.jobs?.find(j=>j.selected.some(s=>s.libraryId===id));
      if(job)await this.options.locations?.validateFolder(job.folder,job.storageId);
      d.checkRemoval(file);
      if(d.preparing)throw new Error("Дождитесь подготовки текущей серии");
      d.preparing=true;
      try{await d.prepare(d.library,id);}finally{d.preparing=false;this.storageAt=0;}
      return {prepared:true};
    }
    if(c.kind==="storage-add") {const result=await this.options.addLocation(p.volume);this.storageAt=0;return result;}
    if(c.kind==="storage-scan") {await this.options.locations.scan(true);this.storageAt=0;return {scanned:true};}
    if(c.kind==="storage-disconnect") {const result=await this.options.locations.disconnect(p.target);this.storageAt=0;return result;}
    if(c.kind==="storage-recover") {await d.serial(()=>this.options.locations.recover());this.storageAt=0;return {recovered:true};}
    if(c.kind==="storage-default") {await this.options.locations.setDefault(p.target);this.storageAt=0;return {updated:true};}
    if(c.kind==="move-titles") {const result=await this.options.locations.moveTitles(p.titles,p.target,c.id);this.storageAt=0;return result;}
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
        if(this.options.locations)d.get(j.id).storageId=p.target||this.options.locations.defaultId;
        await d.start(j.id, selections,this.options.locations?await this.options.locations.checkedRoot(p.target):this.folder(),true);
      }
      return { job: j.id };
    }
    const j = d.get(p.job);
    if (c.kind === "start") {
      if (j.state === "selecting") {if(this.options.locations)j.storageId=p.target||this.options.locations.defaultId;await d.start(j.id,p.selections,this.options.locations?await this.options.locations.checkedRoot(p.target):this.folder(),true);}
      // A start may have persisted selections before the process stopped.
      else if (j.state === "paused" && j.folder) await d.resume(j.id);
    } else if (c.kind === "pause") { if (j.state !== "paused" && j.state !== "cancelled") await d.pause(j.id); }
    else if (c.kind === "resume") { if (["paused", "error"].includes(j.state)) await d.resume(j.id); }
    else if (c.kind === "cancel") { if (j.state !== "cancelled") await d.cancel(j.id); }
    else throw new Error("Неизвестное действие очереди");
    return { job: j.id };
  }
  async tick() {
    if (this.busy) {await this.request(await this.report());return;}
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
