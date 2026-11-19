import { stat, statfs } from "node:fs/promises";
import path from "node:path";

/** Report known media on each actual filesystem; never send local paths to the server. */
export async function storageSnapshot(downloads, folder) {
  const locations = new Map(), volumes = new Map();
  const add = (file,title,name) => { if(file) locations.set(path.resolve(file),{title,name}); };
  for(const job of downloads.jobs) if(job.folder) for(const f of job.files) add(path.join(job.folder,f.path),job.title,job.titleName);
  for(const f of downloads.library.files) { add(f.path,f.title,f.titleName || `Тайтл ${f.title}`); add(f.output,f.title,f.titleName || `Тайтл ${f.title}`); }
  const volume = async location => {
    let p=location;
    while(true) { try {
      const [s,fs]=await Promise.all([stat(p),statfs(p)]);const id=String(s.dev);
      if(!volumes.has(id)) volumes.set(id,{id,total:fs.blocks*fs.bsize,free:fs.bavail*fs.bsize,mediaBytes:0,titles:new Map()});
      return volumes.get(id);
    } catch(e) { const parent=path.dirname(p); if(e.code!=="ENOENT" || parent===p) throw e; p=parent; } }
  };
  const target=await volume(folder);
  await volume(downloads.library.directory);
  for(const [file,info] of locations) {
    try { const s=await stat(file); if(!s.isFile())continue; const v=await volume(file);
      const bytes=typeof s.blocks==="number" ? s.blocks*512 : s.size;
      v.mediaBytes+=bytes;const t=v.titles.get(info.title) || {id:info.title,name:info.name,bytes:0};t.bytes+=bytes;v.titles.set(info.title,t);
    } catch(e) { if(e.code!=="ENOENT") throw e; }
  }
  return {at:Date.now(),volumes:[...volumes.values()].map((v,i)=>({...v,label:v.id===target.id?"Диск загрузок":`Диск библиотеки ${i+1}`,titles:[...v.titles.values()]}))};
}
