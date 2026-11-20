"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronDownIcon, TrashIcon } from "@heroicons/react/24/outline";
import { api } from "@/lib/client";
import type { serverDownloadStorage } from "@/server/download-storage";
import { StoragePanel, DownloadProgress, bytes } from "./DownloadInventory";
import { useConfirm } from "./Dialogs";
import { ErrorBox } from "./ui";
export function ServerDownloadStorage({hideStorage=false,excludeHashes=[]}:{hideStorage?:boolean;excludeHashes?:string[]}) {
  const q=useQuery({queryKey:["server-storage"],queryFn:()=>api<Awaited<ReturnType<typeof serverDownloadStorage>>>("/api/downloads/storage"),refetchInterval:10000});
  const [activeTitle,setActiveTitle]=useState<number|null>(null);
  const confirm=useConfirm(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const remove=async(key:string,ep:number|null)=>{
    if(!await confirm({title:`Удалить подготовленную серию${ep?` ${ep}`:""}?`,text:"Скачанная копия на медиасервере будет удалена. История просмотра и ссылка для онлайн-просмотра сохранятся.",confirm:"Удалить",danger:true}))return;
    setBusy(true);setError(null);try{await api("/api/downloads/storage",{method:"DELETE",json:{key}});await q.refetch();}catch(e){setError(e);}finally{setBusy(false);}
  };
  const files=q.data?.files.filter(f=>!excludeHashes.some(hash=>f.key.startsWith(`${hash}:`)))??[];
  return <div className="space-y-3">{(error||q.error)&&<ErrorBox error={error||q.error}/>}{q.isPending?<p className="text-sm text-gray-400">Проверяем диск медиасервера…</p>:q.data&&<>
    {!hideStorage&&<StoragePanel storage={q.data.storage} online activeTitle={activeTitle} titleOrder={[...new Set(files.map(f=>f.title??0))]}/>}
    {[...new Set(files.map(f=>f.title))].map(id=>{const episodes=files.filter(f=>f.title===id),info=id?q.data!.context[id]:undefined,name=info?.name??(id?`Тайтл ${id}`:"Неопознанные серии"),total=episodes.reduce((n,f)=>n+f.bytes,0),download=episodes.reduce((n,f)=>n+f.bytes*(f.ready?1:f.progress),0),ready=episodes.reduce((n,f)=>n+(f.ready?f.bytes:0),0);return <details onMouseEnter={()=>setActiveTitle(id??0)} onMouseLeave={()=>setActiveTitle(null)} key={id??"unknown"} className="group/server rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700"><summary className="flex cursor-pointer list-none items-center gap-4 rounded-lg focus-visible:outline-2 focus-visible:outline-accent-300"><div className="h-20 w-14 shrink-0 overflow-hidden rounded-md bg-gray-700">{/* eslint-disable-next-line @next/next/no-img-element */}{info?.cover&&<img alt="" src={info.cover} className="h-full w-full object-cover"/>}</div><div className="min-w-0 flex-1 space-y-2"><h3 className="truncate font-semibold" title={name}>{name}</h3><p className="text-xs text-gray-400">{episodes.length} серий · {bytes(episodes.reduce((n,f)=>n+f.stored,0))} на диске</p><DownloadProgress download={total?download/total:0} prepare={total?ready/total:0} label={`Весь сезон: ${name}`}/><span className="inline-flex items-center gap-1 text-xs text-gray-400">Серии · {episodes.length}<ChevronDownIcon className="h-3 w-3 transition-transform group-open/server:rotate-180 motion-reduce:transition-none"/></span></div></summary><div className="mt-3 divide-y divide-gray-700/50" aria-label={`Серии: ${name}`}>{episodes.map(f=><div key={f.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[7rem_minmax(4rem,1fr)_6rem_auto]">{id&&f.ep&&f.ready?<Link className="text-sm hover:text-accent-300" href={`/anime/${id}/watch/${f.ep}`}>Серия {f.ep}</Link>:<span className="text-sm">{f.ep?`Серия ${f.ep}`:"Номер неизвестен"}</span>}<div className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1"><DownloadProgress download={f.ready?1:f.progress} prepare={f.ready?1:0} label={`Серия ${f.ep??""}`}/></div><p className="col-start-2 row-start-2 text-right text-xs tabular-nums text-gray-400 sm:col-start-3 sm:row-start-1">{bytes(f.bytes)}</p><button disabled={busy||f.inUse} title={f.inUse?"Серия используется или подготавливается":"Удалить копию"} aria-label={`Удалить серию ${f.ep??f.key}`} onClick={()=>void remove(f.key,f.ep)} className="col-start-2 row-start-1 grid h-11 w-11 place-items-center justify-self-end rounded-lg text-gray-400 hover:bg-gray-700 hover:text-rose-300 focus-visible:outline-2 focus-visible:outline-accent-300 disabled:opacity-35 sm:col-start-4"><TrashIcon className="h-4 w-4"/></button></div>)}</div></details>;})}
  </>}</div>;
}
