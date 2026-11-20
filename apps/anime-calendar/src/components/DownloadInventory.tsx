"use client";
import Link from "next/link";
import { CheckIcon, ChevronDownIcon, PlayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import { relative } from "@/lib/time";
import { Avatar } from "./Avatar";
import { useConfirm } from "./Dialogs";
import { cx } from "./ui";

export type DownloadFile={index:number;name:string;bytes:number;video:boolean;episode:number|null;selected:boolean;downloaded:number;libraryId?:string;preparedBytes?:number;inUse?:boolean;prepareState?:string;prepareProgress:number;error?:string};
export type DownloadJob={id:string;title:number;titleName:string;releaseName:string;state:string;error?:string;files:DownloadFile[];speed:number;createdAt?:number;peers?:number};
export type LibraryFile={id:string;title:number;titleName:string;ep:number;bytes:number;preparedBytes:number;state:string;progress:number;inUse:boolean};
export type Storage={at?:number;error?:string;volumes:{id:string;label:string;total:number;free:number;mediaBytes:number;titles:{id:number;name:string;bytes:number}[]}[]};
type Person={id:number;name:string;hidden:boolean;watched:number[];baseline:number;completed:boolean};
export type DownloadContext={name:string;cover:string|null;status:string|null;groups:{id:number;name:string}[];people:Person[]};
export const bytes=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(1)} ГБ`:`${Math.round(n/1024**2)} МБ`;
const colors=["bg-accent-400","bg-sky-400","bg-teal-400","bg-amber-400","bg-rose-400"];
const statuses:Record<string,string>={watching:"Смотрю",rewatching:"Пересматриваю",completed:"Просмотрено",dropped:"Брошено",on_hold:"Отложено",planned:"В планах"};
const fraction=(n:number)=>Math.max(0,Math.min(1,n||0));

export const downloadTitleIds=(jobs:DownloadJob[],library:LibraryFile[])=>[...new Set([...jobs.filter(j=>j.state==="selecting"||j.files.some(f=>f.selected)).map(j=>j.title),...library.map(f=>f.title)])];
export function StoragePanel({storage,online,context={},titleOrder=[],activeTitle=null}:{storage?:Storage|null;online:boolean;context?:Record<number,DownloadContext>;titleOrder?:number[];activeTitle?:number|null}) {
  const [hover,setHover]=useState<number|null>(null);
  const [volume,setVolume]=useState("");
  const active=hover??activeTitle;
  if(!storage)return <p className="text-sm text-gray-400">Место на диске появится после подключения desktop 0.5.0-rc.3 или новее.</p>;
  if(storage.error)return <p role="status" className="text-sm text-amber-300">{storage.error}. Сводка обновится при следующем подключении.</p>;
  const selected=storage.volumes.find(v=>v.id===volume)??storage.volumes[0];
  return <div className="space-y-3" aria-label="Место на диске">{storage.volumes.length>1&&<label className="flex items-center gap-3 text-sm text-gray-400">Диск<select aria-label="Диск" value={selected?.id} onChange={e=>setVolume(e.target.value)} className="min-h-11 max-w-full rounded-lg bg-gray-800 px-3 text-gray-100 ring-1 ring-gray-600">{storage.volumes.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select></label>}{(selected?[selected]:[]).map(v=>{
    const other=Math.max(0,v.total-v.free-v.mediaBytes);
    const titles=[...v.titles].sort((a,b)=>{
      const rank=(id:number)=>titleOrder.includes(id)?titleOrder.indexOf(id):titleOrder.length+v.titles.findIndex(t=>t.id===id);
      return rank(a.id)-rank(b.id);
    });
    return <section key={v.id} className="rounded-xl bg-gray-800/50 p-5"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{v.label}</h3><p className="text-sm tabular-nums"><span className={v.free/v.total<.1?"text-amber-300":"text-gray-100"}>{bytes(v.free)} свободно</span><span className="text-gray-400"> из {bytes(v.total)}</span></p></div>
      <div className="my-4 flex h-3 overflow-hidden rounded-full bg-gray-900" role="img" aria-label={`${v.label}: аниме ${bytes(v.mediaBytes)}, другие файлы ${bytes(other)}, свободно ${bytes(v.free)}`}>
        <span title={`Другие файлы: ${bytes(other)}`} className="bg-gray-600" style={{width:`${fraction(other/v.total)*100}%`}}/>
        {titles.map((t,i)=><span key={t.id} onMouseEnter={()=>setHover(t.id)} onMouseLeave={()=>setHover(null)} title={`${context[t.id]?.name||t.name}: ${bytes(t.bytes)}`} className={cx(colors[i%colors.length],"transition-[opacity,filter] duration-150 motion-reduce:transition-none",active!==null&&active!==t.id?"opacity-30":active===t.id?"brightness-125":"")} style={{width:`${fraction(t.bytes/v.total)*100}%`}}/>)}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-gray-300">{titles.map((t,i)=><Link key={t.id} onMouseEnter={()=>setHover(t.id)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(t.id)} onBlur={()=>setHover(null)} href={t.id>0?`/anime/${t.id}`:"/downloads"} className="inline-flex max-w-full items-center gap-2 hover:text-white"><span className={cx("h-2 w-2 shrink-0 rounded-full",colors[i%colors.length])}/><span className="truncate">{context[t.id]?.name||t.name}</span><span className="shrink-0 tabular-nums text-gray-400">{bytes(t.bytes)}</span></Link>)}<span>Другие файлы · {bytes(other)}</span></div>
      {!online && storage.at && <p className="mt-3 text-xs text-gray-400">Последние данные: {new Date(storage.at).toLocaleString("ru-RU")}</p>}
    </section>;
  })}</div>;
}

function Viewers({people,ep,groups}:{people:Person[];ep:number;groups:DownloadContext["groups"]}) {
  if(!groups.length)return null;
  const seen=(p:Person)=>!p.hidden&&(p.completed||p.baseline>=ep||p.watched.includes(ep));
  const sorted=[...people].sort((a,b)=>Number(seen(a))-Number(seen(b)));
  return <div className="group/viewers relative"><button type="button" title={sorted.map(p=>`${p.name}: ${p.hidden?"прогресс скрыт":seen(p)?"посмотрел":"не посмотрел"}`).join("\n")} aria-label={`Кто посмотрел серию ${ep}`} className="flex min-h-9 cursor-pointer list-none items-center -space-x-2 rounded-md focus-visible:outline-2 focus-visible:outline-accent-300">
    {sorted.slice(0,4).map(p=><span key={p.id} className="relative"><Avatar user={p} className="h-6 w-6 text-[10px] ring-2 ring-gray-900"/>{seen(p)&&<CheckIcon className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-emerald-900 text-emerald-200"/>}</span>)}{sorted.length>4&&<span className="z-10 grid h-6 min-w-6 place-items-center rounded-full bg-gray-700 px-1 text-[10px]">+{sorted.length-4}</span>}
  </button><div className="absolute right-0 bottom-full z-20 hidden min-w-48 space-y-2 rounded-lg bg-gray-800 p-3 text-xs shadow-lg group-hover/viewers:block group-focus-within/viewers:block"><p className="text-gray-400">{groups.map(g=>g.name).join(", ")}</p>{sorted.map(p=><p key={p.id} className="break-words"><span className="font-medium">{p.name}</span><br/><span className="text-gray-400">{p.hidden?"Прогресс скрыт":seen(p)?"Посмотрел":"Не посмотрел"}</span></p>)}</div></div>;
}

export function DownloadInventory({jobs,library,context,storage,device,canDelete,busy,focusTitle,onActiveTitle,renderJob,renderAccess,remove}:{
  storage?:Storage|null;jobs:DownloadJob[];library:LibraryFile[];context:Record<number,DownloadContext>;device:{id:string;online:boolean};canDelete:boolean;busy:boolean;focusTitle?:number;onActiveTitle?:(id:number|null)=>void;
  renderJob:(j:DownloadJob)=>ReactNode;renderAccess:(title:number)=>ReactNode;
  remove:(body:{job?:string;index?:number;library?:string})=>Promise<void>;
}) {
  const confirm=useConfirm();
  const ids=downloadTitleIds(jobs,library).filter(id=>!focusTitle||id===focusTitle);
  const ask=async(ep:number,title:string,managed:boolean,body:{job?:string;index?:number;library?:string})=>{
    if(await confirm({title:`Удалить серию ${ep}?`,text:<><p>{title}</p><p className="mt-2">{managed?"Будут удалены скачанный файл и подготовленная копия. Остальная загрузка этой раздачи будет приостановлена.":"Подготовленная копия и запись библиотеки будут удалены. Подключённый вручную исходный файл останется на диске."}</p><p className="mt-2">История просмотра и комментарии сохранятся.</p></>,confirm:"Удалить серию",danger:true}))await remove(body);
  };
  return <div className="divide-y divide-gray-800">{ids.map(id=>{
    const batch=jobs.filter(j=>j.title===id), info=context[id];
    const linked=new Set(batch.flatMap(j=>j.files.map(f=>f.libraryId)));
    const loose=library.filter(f=>f.title===id&&!linked.has(f.id));
    const episodes=[...batch.flatMap(j=>j.files.filter(f=>f.selected).map(f=>({key:`${j.id}:${f.index}`,ep:f.episode||0,download:fraction(f.downloaded/Math.max(1,f.bytes)),prepare:f.prepareState==="ready"?1:fraction(f.prepareProgress),size:f.bytes,used:Math.min(f.bytes,f.downloaded)+(f.preparedBytes||0),ready:f.prepareState==="ready",blocked:f.inUse||f.prepareState==="preparing",error:f.error,managed:true,source:j.releaseName||f.name,body:{job:j.id,index:f.index}}))),...loose.map(f=>({key:f.id,ep:f.ep,download:1,prepare:f.state==="ready"?1:fraction(f.progress),size:f.bytes,used:f.bytes+(f.preparedBytes||0),ready:f.state==="ready",blocked:f.inUse||f.state==="preparing",error:f.state==="error"?"Проверьте файл в локальной библиотеке":undefined,managed:false,source:"Локальная библиотека",body:{library:f.id}}))].sort((a,b)=>a.ep-b.ep);
    const count=new Set(episodes.map(f=>f.ep)).size;
    const stored=storage&&!storage.error?storage.volumes.flatMap(v=>v.titles).filter(t=>t.id===id).reduce((sum,t)=>sum+t.bytes,0):null;
    const name=info?.name || batch[0]?.titleName || loose[0]?.titleName || `Тайтл ${id}`;
    const totalBytes=batch.flatMap(j=>j.files.filter(f=>f.selected)).reduce((sum,f)=>sum+f.bytes,0)+loose.reduce((sum,f)=>sum+f.bytes,0);
    const downloaded=batch.flatMap(j=>j.files.filter(f=>f.selected)).reduce((sum,f)=>sum+Math.min(f.bytes,f.downloaded),0)+loose.reduce((sum,f)=>sum+f.bytes,0);
    const prepared=batch.flatMap(j=>j.files.filter(f=>f.selected)).reduce((sum,f)=>sum+f.bytes*(f.prepareState==="ready"?1:fraction(f.prepareProgress)),0)+loose.reduce((sum,f)=>sum+f.bytes*(f.state==="ready"?1:fraction(f.progress)),0);
    return <details key={id} onMouseEnter={()=>onActiveTitle?.(id)} onMouseLeave={()=>onActiveTitle?.(null)} onFocusCapture={()=>onActiveTitle?.(id)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))onActiveTitle?.(null);}} open={focusTitle===id||batch.some(j=>j.state==="selecting")} className="group/title my-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <summary className="flex cursor-pointer list-none items-center gap-4 rounded-lg focus-visible:outline-2 focus-visible:outline-accent-300">
        <div className="h-20 w-14 shrink-0 overflow-hidden rounded-md bg-gray-700">{/* eslint-disable-next-line @next/next/no-img-element */}{info?.cover&&<img src={info.cover} alt="" className="h-full w-full object-cover"/>}</div>
        <div className="min-w-0 flex-1 space-y-2"><h3 className="truncate font-semibold" title={name}>{name}</h3><p className="flex flex-wrap gap-x-3 text-xs text-gray-400"><span>{count} серий</span><span>{bytes(stored??episodes.reduce((sum,f)=>sum+f.used,0))} на диске</span>{totalBytes>0&&<span>из {bytes(totalBytes)}</span>}{batch.some(j=>j.speed>0)&&<span>{bytes(batch.reduce((sum,j)=>sum+j.speed,0))}/с</span>}{batch.some(j=>j.peers!==undefined)&&<span>пиры {batch.reduce((sum,j)=>sum+(j.peers||0),0)}</span>}{batch.some(j=>j.createdAt)&&<span>добавлено {relative(Math.min(...batch.filter(j=>j.createdAt).map(j=>j.createdAt!)))}</span>}{info?.status&&<span>{statuses[info.status]||info.status}</span>}</p><DownloadProgress download={totalBytes?downloaded/totalBytes:0} prepare={totalBytes?prepared/totalBytes:0} label={`Весь сезон: ${name}`}/><span className="inline-flex items-center gap-1 text-xs text-gray-400">Серии · {count}<ChevronDownIcon className="h-3 w-3 transition-transform group-open/title:rotate-180 motion-reduce:transition-none"/></span></div>
      </summary>
      <div className="mt-4 space-y-4">{batch.map(j=><div key={j.id}>{renderJob(j)}</div>)}
        {!!episodes.length&&<div className="divide-y divide-gray-700/50" aria-label={`Серии: ${name}`}>{episodes.map(f=><div key={f.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[7rem_minmax(4rem,1fr)_6rem_auto]">
          <div className="flex min-w-0 items-center gap-1">{f.ready&&device.online?<Link href={`/anime/${id}/watch/${f.ep}?device=${device.id}&play=1`} className="inline-flex min-h-11 items-center gap-1 rounded text-sm hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-300"><PlayIcon className="h-3 w-3"/>Серия {f.ep}</Link>:<span className="text-sm">Серия {f.ep}</span>}</div>
          <div className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1"><DownloadProgress download={f.download} prepare={f.prepare} label={`Серия ${f.ep}`}/>{episodes.filter(e=>e.ep===f.ep).length>1&&<p title={f.source} className="mt-1 truncate text-xs text-gray-400">{f.source}</p>}{f.error&&<p className="mt-1 break-words text-xs text-amber-300">{f.error}</p>}</div><p className="col-start-2 row-start-2 text-right text-xs tabular-nums text-gray-400 sm:col-start-3 sm:row-start-1">{bytes(f.size)}</p><div className="col-start-2 row-start-1 flex items-center justify-end gap-2 sm:col-start-4">{info&&<Viewers people={info.people} groups={info.groups} ep={f.ep}/>}
            <button type="button" aria-label={`Удалить серию ${f.ep}: ${name}`} title={f.blocked?"Серия используется или подготавливается":!canDelete?"Обновите desktop для удаления серий":!device.online?"Подключите устройство для удаления":"Удалить серию"} disabled={busy||f.blocked||!canDelete||!device.online} onClick={()=>void ask(f.ep,`${name} · ${f.source}`,f.managed,f.body)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-700 hover:text-rose-300 focus-visible:outline-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:opacity-35"><TrashIcon className="h-4 w-4"/></button>
          </div>
        </div>)}</div>}
        {episodes.some(f=>f.ready)&&renderAccess(id)}
      </div>
    </details>;
  })}</div>;
}

export function DownloadProgress({download,prepare,label}:{download:number;prepare:number;label:string}) {
  const d=fraction(download),p=fraction(prepare),description=`${label}: скачивание ${Math.round(d*100)}%, подготовка ${Math.round(p*100)}%`;
  return <div role="progressbar" title={description} aria-label={description} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(d*80+p*20)} className="flex h-1.5 overflow-hidden rounded-full bg-gray-700"><div className="w-4/5"><div className="h-full bg-accent-400 transition-[width] duration-300 motion-reduce:transition-none" style={{width:`${d*100}%`}}/></div><div className="w-1/5"><div className="h-full bg-emerald-400 transition-[width] duration-300 motion-reduce:transition-none" style={{width:`${p*100}%`}}/></div></div>;
}


