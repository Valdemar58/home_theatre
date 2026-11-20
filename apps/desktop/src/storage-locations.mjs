import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, writeFile, rename, realpath, stat, statfs, lstat, readdir, copyFile, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { identifyFile } from "./file-identity.mjs";
import { volumeFor } from "./volumes.mjs";

const inside=(root,file)=>path.resolve(file).startsWith(path.resolve(root)+path.sep);
async function noLinks(file) {
  let p=path.resolve(file);
  while(true) {
    try { if((await lstat(p)).isSymbolicLink())throw new Error("Папки со ссылками не поддерживаются"); }
    catch(e) { if(e.code!=="ENOENT")throw e; }
    const parent=path.dirname(p);if(parent===p)break;p=parent;
  }
}
async function atomic(file,value) {
  await writeFile(file+".tmp",JSON.stringify(value),{mode:0o600});await rename(file+".tmp",file);
}
async function exists(file) {try {await lstat(file);return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
async function tree(root) {
  const out=[];
  async function visit(dir) {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const f=path.join(dir,e.name);
      if(e.isSymbolicLink())throw new Error("Перенос через ссылки запрещён");
      if(e.isDirectory())await visit(f);else if(e.isFile())out.push(f);else throw new Error("В папке есть неподдерживаемые файлы");
    }
  }
  await visit(root);return out;
}

/** Registered roots stay on the device. The web only receives opaque IDs and drive labels. */
export class StorageLocations {
  constructor(directory,downloads,{detect=async()=>[]}={}) {
    this.directory=directory;this.downloads=downloads;this.locations=[];this.defaultId="";this.progress=null;
    this.file=path.join(directory,"storage-locations.json");this.journal=path.join(directory,"storage-move.json");
    this.detect=detect;this.detected=[];this.detectedAt=0;
  }
  async load(defaultFolder) {
    await mkdir(this.directory,{recursive:true});
    let initialized=false;
    try {const value=JSON.parse(await readFile(this.file,"utf8"));this.locations=value.locations;this.defaultId=value.defaultId;initialized=true;}
    catch(e){if(e.code!=="ENOENT")throw e;}
    await this.scan(true);
    for(const location of this.locations){const disk=volumeFor(location.folder,this.detected);if(disk&&!location.volumeId){location.volumeId=disk.id;location.volumeRoot=disk.root;}}
    if(this.locations.length)await this.save();
    if(!initialized&&!this.locations.length)await this.add(defaultFolder);
    for(const job of this.downloads.jobs)if(job.folder&&path.basename(job.folder)===job.id&&!this.locations.some(l=>inside(l.folder,job.folder))&&await exists(job.folder))await this.add(path.dirname(job.folder));
    for(const job of this.downloads.jobs)if(job.folder&&!job.storageId)job.storageId=this.locationFor(job.folder)?.id;
    await this.downloads.save();
    try{await this.recover();}catch{this.recoveryError="Подключите диски незавершённого переноса и повторите действие";}
  }
  save(){return atomic(this.file,{locations:this.locations,defaultId:this.defaultId});}
  root(id=this.defaultId) {
    const location=this.locations.find(l=>l.id===id);
    if(!location)throw new Error("Диск не подключён. Выберите подключённое хранилище");
    return location.folder;
  }
  async scan(force=false) {
    if(!force&&this.detectedAt&&Date.now()-this.detectedAt<30000)return this.detected;
    try{this.detected=await this.detect();this.scanError=null;}catch{this.detected=[];this.scanError="Не удалось определить подключённые тома. Повторите обновление списка.";}
    this.detectedAt=Date.now();return this.detected;
  }
  locationFor(folder) {
    const disk=volumeFor(folder,this.detected);
    return this.locations.find(l=>inside(l.folder,folder)&&(!l.volumeId||l.volumeId===disk?.id));
  }
  async checkedRoot(id=this.defaultId) {
    const folder=this.root(id);await this.validateFolder(folder,id);return folder;
  }
  async validateFolder(folder,id) {
    await this.scan();
    const location=id?this.locations.find(l=>l.id===id):this.locationFor(folder);
    if(!location||!(path.resolve(location.folder)===path.resolve(folder)||inside(location.folder,folder)))throw new Error("Папка не относится к подключённой медиатеке");
    if(location.volumeId&&volumeFor(folder,this.detected)?.id!==location.volumeId)throw new Error("Прежний том недоступен или по его пути подключён другой диск");
    await noLinks(folder);await stat(location.folder);
  }
  async available() {
    await this.scan();
    return this.detected.map(({root,dev,...v})=>({...v,registered:this.locations.find(l=>l.volumeId===v.id)?.id}));
  }
  async disconnect(id) {
    return this.downloads.serial(async()=>{
      const folder=await this.checkedRoot(id);
      if(await exists(this.journal)||(await readdir(folder)).length||this.downloads.library.files.some(f=>inside(folder,f.path)||f.output&&inside(folder,f.output)))throw new Error("Сначала перенесите или удалите все файлы медиатеки. Папка закреплена, пока она непустая");
      this.locations=this.locations.filter(l=>l.id!==id);
      if(this.defaultId===id)this.defaultId=this.locations[0]?.id||"";
      await this.save();return {disconnected:true};
    });
  }
  async canDisconnect(id) {
    try {
      const folder=await this.checkedRoot(id);
      return !await exists(this.journal)&&!(await readdir(folder)).length&&!this.downloads.library.files.some(f=>inside(folder,f.path)||f.output&&inside(folder,f.output));
    }catch{return false;}
  }
  async add(folder,expectedVolume) {
    await noLinks(folder);await this.scan();
    const chosen=volumeFor(path.resolve(folder),this.detected);
    if(expectedVolume&&chosen?.id!==expectedVolume)throw new Error("Выберите папку только на выбранном томе");
    const registered=chosen&&this.locations.find(l=>l.volumeId===chosen.id);
    if(registered)return registered;
    await mkdir(folder,{recursive:true});
    const canonical=await realpath(folder),s=await stat(canonical),fs=await statfs(canonical);
    await this.scan();const disk=volumeFor(canonical,this.detected);
    if(expectedVolume&&disk?.id!==expectedVolume)throw new Error("Выберите папку только на выбранном томе");
    if(!s.isDirectory()||fs.bavail*fs.bsize<1)throw new Error("Хранилище недоступно для записи");
    // One registered storage root per filesystem prevents double-counting its capacity.
    for(const old of this.locations) {
      if(old.volumeId&&disk){if(old.volumeId===disk.id)return old;continue;}
      try {if(String((await stat(old.folder)).dev)===String(s.dev))return old;}
      catch(e){if(e.code!=="ENOENT")throw e;}
    }
    const probe=path.join(canonical,`.home-theater-${randomUUID()}`);
    await writeFile(probe,"",{flag:"wx",mode:0o600});await unlink(probe);
    const label=process.platform==="win32"?path.parse(canonical).root.replace(/[\\/]+$/,""):path.basename(canonical)||"/";
    const location={id:randomUUID(),folder:canonical,label,volumeId:disk?.id,volumeRoot:disk?.root};this.locations.push(location);
    if(!this.defaultId)this.defaultId=location.id;
    await this.save();return location;
  }
  async setDefault(id) {await this.checkedRoot(id);this.defaultId=id;await this.save();}
  async publicLocations() {
    return Promise.all(this.locations.map(async l=>{
      try {await noLinks(l.folder);const [s,fs]=await Promise.all([stat(l.folder),statfs(l.folder)]);return {id:l.id,label:l.label,volumeId:String(s.dev),total:fs.blocks*fs.bsize,free:fs.bavail*fs.bsize,default:l.id===this.defaultId,online:true};}
      catch{return {id:l.id,label:l.label,default:l.id===this.defaultId,online:false};}
    }));
  }
  async titleLocation(title) {
    const jobs=this.downloads.jobs.filter(j=>j.title===title&&j.folder&&j.selected.length);
    const roots=new Set();
    for(const j of jobs)for(const l of this.locations)if(inside(l.folder,j.folder))roots.add(l.id);
    return [...roots];
  }
  async moveTitles(requests,targetId,commandId=randomUUID()) {
    const d=this.downloads;
    return d.serial(async()=>{
      if(await exists(this.journal))await this.recover();
      const target=await this.checkedRoot(targetId);await noLinks(target);
      if(!Array.isArray(requests)||!requests.length||requests.length>100)throw new Error("Выберите сезоны для переноса");
      const plans=[],jobs=[],files=[],sources=new Set(),titles=new Set();
      for(const request of requests) {
        if(titles.has(request.title))throw new Error("Тайтл выбран дважды");titles.add(request.title);
        const batch=d.jobs.filter(j=>j.title===request.title&&j.selected.length);
        const already=batch.length&&batch.every(j=>inside(target,j.folder));
        if(already)continue; // Safe replay after an acknowledged move or lost receipt.
        const watched=new Set(batch.flatMap(j=>j.selected.map(s=>s.episode)));
        if(!Number.isSafeInteger(request.episodes)||request.episodes<1||request.episodes>10000||!Array.from({length:request.episodes},(_,i)=>i+1).every(n=>watched.has(n)))throw new Error("Перенос доступен только после скачивания всех серий сезона");
        if(!batch.length)throw new Error("Нет скачанных файлов для переноса");
        for(const j of batch.filter(j=>!inside(target,j.folder))) {
          if(j.removing||["selecting","downloading","verifying","preparing"].includes(j.state)||d.active.has(j.id))throw new Error("Дождитесь скачивания и подготовки сезона");
          if(!j.folder||path.basename(j.folder)!==j.id||!this.locations.some(l=>inside(l.folder,j.folder)))throw new Error("Исходная папка не относится к подключённым хранилищам");
          await noLinks(j.folder);
          if(j.storageId)await this.validateFolder(j.folder,j.storageId);
          const dest=path.join(target,j.id);
          if(inside(j.folder,dest)||inside(dest,j.folder)||await exists(dest))throw new Error("Папка назначения уже существует или пересекается с исходной");
          const selected=j.selected.map(s=>({s,meta:j.files[s.index],lib:d.library.files.find(f=>f.id===s.libraryId)}));
          for(const {s,meta,lib} of selected) {
            if(!meta||s.downloaded<meta.bytes||!lib||lib.state==="error")throw new Error("Не все серии скачаны или файлы требуют проверки");
            d.checkRemoval(lib);
            if(!inside(j.folder,lib.path))throw new Error("Подключённые вручную файлы не перемещаются вместе с загрузкой");
          }
          for(const source of await tree(j.folder))plans.push({source,dest:path.join(dest,path.relative(j.folder,source))});
          for(const {lib} of selected) {
            if(files.some(f=>f.id===lib.id))throw new Error("Общая копия используется несколькими раздачами");
            let output;
            if(lib.output) {
              await noLinks(lib.output);
              output=inside(j.folder,lib.output)?path.join(dest,path.relative(j.folder,lib.output)):path.join(dest,".prepared",`${lib.id}.mp4`);
              if(!plans.some(p=>p.source===lib.output))plans.push({source:lib.output,dest:output});
            }
            files.push({id:lib.id,state:lib.state,path:path.join(dest,path.relative(j.folder,lib.path)),output,preparedDirectory:path.join(dest,".prepared")});
          }
          jobs.push({id:j.id,folder:dest,state:j.state,storageId:targetId});sources.add(j.folder);
        }
      }
      if(!jobs.length)return {moved:true};
      const unique=[...new Map(plans.map(p=>[path.resolve(p.source),p])).values()];
      const total=(await Promise.all(unique.map(async p=>{await noLinks(p.source);return (await stat(p.source)).size;}))).reduce((n,s)=>n+s,0);
      const fs=await statfs(target);
      if(fs.bavail*fs.bsize<total+256*1024**2)throw new Error("На выбранном диске недостаточно свободного места");
      const journal={id:commandId,phase:"copying",target,plans:unique,jobs,files,sources:[...sources]};
      await atomic(this.journal,journal);
      try {
        for(const job of jobs){await mkdir(job.folder);await writeFile(path.join(job.folder,".home-theater-move"),commandId,{flag:"wx",mode:0o600});}
        // Make files unavailable for new host leases before the first asynchronous copy.
        for(const f of files){const lib=d.library.files.find(l=>l.id===f.id);d.checkRemoval(lib);lib.state="moving";}
        await d.library.save();this.progress={titles:[...titles],phase:"copying",copied:0,total};
        for(const p of unique) {
          await noLinks(p.source);await noLinks(path.dirname(p.dest));
          await mkdir(path.dirname(p.dest),{recursive:true});
          await copyFile(p.source,p.dest,constants.COPYFILE_EXCL);
          const sourceStat=await stat(p.source);
          // Empty auxiliary files need no content hash; media files are always hashed in full.
          if(sourceStat.size) {
            const [from,to]=await Promise.all([identifyFile(p.source),identifyFile(p.dest)]);
            if(from.version!==to.version)throw new Error("Проверка копии не пройдена. Исходные файлы сохранены");
            const original=d.library.files.find(f=>f.path===p.source),prepared=d.library.files.find(f=>f.output===p.source);
            const expected=original?.version||prepared?.preparedVersion;
            if(expected&&from.version!==expected)throw new Error("Файл изменился после добавления в библиотеку. Исходник сохранён");
            p.version=from.version;
          }else p.empty=true;
          this.progress.copied+=sourceStat.size;
        }
        journal.phase="committing";await atomic(this.journal,journal);
        await this.finish(journal);
      }catch(e){if(journal.phase==="copying")await this.rollback(journal);else this.recoveryError="Подключите диски переноса и повторите восстановление";throw e;}
      finally{this.progress=null;}
      return {moved:true};
    });
  }
  async finish(journal) {
    const d=this.downloads;
    await this.validateJournalVolumes(journal);
    for(const p of journal.plans) {
      await noLinks(p.dest);
      if(!inside(journal.target,p.dest)||!await exists(p.dest)||(!p.empty&&(await identifyFile(p.dest)).version!==p.version))throw new Error("Копия недоступна или изменилась. Исходники сохранены");
    }
    for(const job of journal.jobs){const j=d.jobs.find(j=>j.id===job.id);if(!j)throw new Error("Загрузка переноса не найдена");j.folder=job.folder;j.state=job.state;j.storageId=job.storageId;}
    for(const file of journal.files) {
      const f=d.library.files.find(f=>f.id===file.id);if(!f)throw new Error("Серия переноса не найдена");
      f.path=file.path;f.preparedDirectory=file.preparedDirectory;f.state=file.state;delete f.error;
      f.mtime=(await stat(f.path)).mtimeMs;
      if(file.output){f.output=file.output;f.preparedMtime=(await stat(f.output)).mtimeMs;}
    }
    await d.library.save();await d.save();
    // The journal stays until both metadata files and cleanup have completed.
    for(const p of journal.plans) {
      await noLinks(p.source);await noLinks(p.dest);
      if(!inside(journal.target,p.dest)||!await exists(p.dest))throw new Error("Диск назначения отключён. Исходники сохранены");
      if(await exists(p.source)) {
        if(!p.empty&&(await identifyFile(p.dest)).version!==p.version)throw new Error("Копия изменилась. Исходный файл сохранён");
        if(!p.empty&&(await identifyFile(p.source)).version!==p.version)throw new Error("Исходный файл изменился; он оставлен на прежнем диске");
        await unlink(p.source);
      }
    }
    for(const job of journal.jobs)await unlink(path.join(job.folder,".home-theater-move")).catch(e=>{if(e.code!=="ENOENT")throw e;});
    // Non-recursive removal can only remove empty directories owned by these jobs.
    for(const root of journal.sources) {
      const dirs=[...new Set(journal.plans.filter(p=>inside(root,p.source)).flatMap(p=>{
        const out=[];let dir=path.dirname(p.source);while(dir===root||inside(root,dir)){out.push(dir);if(dir===root)break;dir=path.dirname(dir);}return out;
      }))].sort((a,b)=>b.length-a.length);
      for(const dir of dirs)await rmdir(dir).catch(e=>{if(!["ENOENT","ENOTEMPTY"].includes(e.code))throw e;});
    }
    await unlink(this.journal);
  }
  async rollback(journal) {
    await this.validateJournalVolumes(journal);
    const owned=[];
    for(const job of journal.jobs)try{if(await readFile(path.join(job.folder,".home-theater-move"),"utf8")===journal.id)owned.push(job.folder);}catch(e){if(e.code!=="ENOENT")throw e;}
    for(const p of journal.plans)if(inside(journal.target,p.dest)&&owned.some(root=>inside(root,p.dest))){await noLinks(p.dest);await unlink(p.dest).catch(e=>{if(e.code!=="ENOENT")throw e;});}
    // Preserve unexpected files; only empty destination directories can be removed.
    for(const job of journal.jobs.filter(job=>owned.includes(job.folder))) {
      await unlink(path.join(job.folder,".home-theater-move"));
      const dirs=[...new Set(journal.plans.filter(p=>inside(job.folder,p.dest)).flatMap(p=>{const out=[];let dir=path.dirname(p.dest);while(dir===job.folder||inside(job.folder,dir)){out.push(dir);if(dir===job.folder)break;dir=path.dirname(dir);}return out;}))].sort((a,b)=>b.length-a.length);
      for(const dir of dirs)await rmdir(dir).catch(e=>{if(!["ENOENT","ENOTEMPTY"].includes(e.code))throw e;});
    }
    for(const file of journal.files){const f=this.downloads.library.files.find(f=>f.id===file.id);if(f?.state==="moving")f.state=file.state;}
    await this.downloads.library.save();await unlink(this.journal);
  }
  async recover() {
    let journal;try{journal=JSON.parse(await readFile(this.journal,"utf8"));}catch(e){if(e.code==="ENOENT")return;throw e;}
    if(!this.locations.some(l=>l.folder===journal.target))throw new Error("Хранилище незавершённого переноса не подключено");
    if(journal.phase==="committing")await this.finish(journal);else await this.rollback(journal);
    this.recoveryError=null;
  }
  async validateJournalVolumes(journal) {
    for(const folder of [journal.target,...journal.sources]) {
      const location=this.locations.find(l=>path.resolve(l.folder)===path.resolve(folder)||inside(l.folder,folder));
      if(!location)throw new Error("Хранилище переноса не подключено");
      await this.validateFolder(folder,location.id);
    }
  }
}
