import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { env } from "./env";
import { downloadContext } from "./download-context";
import { playingStreams } from "./player";
import { qbitFiles, qbitFilePrio } from "./qbit";
import { activeTasks } from "./tasks";
import { ApiError } from "./route";
import { refreshPreparedIndex } from "./prep";
import { prebufferProgress } from "./prebuffer";

type Row={key:string;hash:string;idx:number;rel:string;size:number;anilist_id:number|null;ep:number|null;done_at:number|null};
const root=()=>path.resolve(env.streamDir,".prep");
function target(row:Row) {const p=path.resolve(root(),row.rel);if(!p.startsWith(root()+path.sep))throw new ApiError(400,"Некорректный путь серии");return p;}
export async function serverDownloadStorage(user:number) {
  const rows=db.prepare<[],Row>("SELECT * FROM prepared_files ORDER BY anilist_id, ep, key").all(), files=[];
  const context=downloadContext(user,[...new Set(rows.map(r=>r.anilist_id).filter((n):n is number=>!!n))]);
  let storage;
  try {
    const disk=await fs.statfs(env.streamDir),titles=new Map<number,{id:number;name:string;bytes:number}>();let mediaBytes=0;
    for(const row of rows){let bytes=0;try{const s=await fs.stat(target(row));bytes=s.blocks*512;}catch{ /* Not downloaded yet. */ }
      mediaBytes+=bytes;
      const id=row.anilist_id??0,t=titles.get(id)??{id,name:context[id]?.name??"Другие подготовленные серии",bytes:0};t.bytes+=bytes;titles.set(id,t);
      files.push({...row,stored:bytes});
    }
    storage={at:Date.now(),volumes:[{id:"server",label:"Диск медиасервера",total:disk.blocks*disk.bsize,free:disk.bavail*disk.bsize,mediaBytes,titles:[...titles.values()]}]};
  }catch{storage={error:"Диск медиасервера недоступен",volumes:[]};}
  const active=playingStreams(),tasks=activeTasks("prebuffer"),progress=prebufferProgress();
  return {storage,context,files:files.map(r=>{const p=progress.find(p=>p.hash===r.hash&&p.index===r.idx);return {key:r.key,title:r.anilist_id,ep:r.ep,bytes:r.size,stored:r.stored,ready:r.done_at!==null&&r.stored>0,progress:p?.size?Math.max(0,Math.min(1,p.read/p.size)):0,inUse:active.some(a=>a.hash===r.hash&&a.index===r.idx)||tasks.some(t=>t.key===r.key)};})};
}
export async function removeServerEpisode(key:string) {
  const row=db.prepare<[string],Row>("SELECT * FROM prepared_files WHERE key=?").get(key);if(!row)return;
  if(playingStreams().some(s=>s.hash===row.hash&&s.index===row.idx)||activeTasks("prebuffer").some(t=>t.key===key))throw new ApiError(409,"Серия используется или подготавливается. Сначала завершите операцию.");
  const file=target(row);let check=file;
  while(true){try{if((await fs.lstat(check)).isSymbolicLink())throw new ApiError(400,"Удаление через ссылку запрещено");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}const parent=path.dirname(check);if(parent===check)break;check=parent;}
  // Do not remove data while the downloader may recreate it. Network failure leaves the record intact.
  const remote=(await qbitFiles(row.hash)).find(f=>`${row.hash}/${f.name.replaceAll("\\","/")}`===row.rel);
  if(remote)await qbitFilePrio(row.hash,[remote.index],0);
  await fs.unlink(file).catch(e=>{if(e.code!=="ENOENT")throw e;});
  await fs.unlink(file+".!qB").catch(e=>{if(e.code!=="ENOENT")throw e;});
  db.prepare("DELETE FROM prepared_files WHERE key=?").run(key);refreshPreparedIndex();
}
