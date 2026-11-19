"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronDownIcon, TrashIcon } from "@heroicons/react/24/outline";
import { api } from "@/lib/client";
import type { serverDownloadStorage } from "@/server/download-storage";
import { StoragePanel, bytes } from "./DownloadInventory";
import { useConfirm } from "./Dialogs";
import { ErrorBox } from "./ui";
export function ServerDownloadStorage() {
  const q=useQuery({queryKey:["server-storage"],queryFn:()=>api<Awaited<ReturnType<typeof serverDownloadStorage>>>("/api/downloads/storage"),refetchInterval:10000});
  const [activeTitle,setActiveTitle]=useState<number|null>(null);
  const confirm=useConfirm(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const remove=async(key:string,ep:number|null)=>{
    if(!await confirm({title:`Удалить подготовленную серию${ep?` ${ep}`:""}?`,text:"Скачанная копия на медиасервере будет удалена. История просмотра и ссылка для онлайн-просмотра сохранятся.",confirm:"Удалить",danger:true}))return;
    setBusy(true);setError(null);try{await api("/api/downloads/storage",{method:"DELETE",json:{key}});await q.refetch();}catch(e){setError(e);}finally{setBusy(false);}
  };
  return <div className="space-y-5">{(error||q.error)&&<ErrorBox error={error||q.error}/>}{q.isPending?<p className="text-sm text-gray-400">Проверяем диск медиасервера…</p>:q.data&&<>
    <StoragePanel storage={q.data.storage} online activeTitle={activeTitle} titleOrder={[...new Set(q.data.files.map(f=>f.title??0))]}/>
    <h2 className="text-lg font-semibold">Подготовленные серии</h2>
    {!q.data.files.length&&!q.data.storage.error&&<p className="text-sm text-gray-400">Подготовленных серий пока нет.</p>}
    {[...new Set(q.data.files.map(f=>f.title))].map(id=><details onMouseEnter={()=>setActiveTitle(id??0)} onMouseLeave={()=>setActiveTitle(null)} onFocusCapture={()=>setActiveTitle(id??0)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))setActiveTitle(null);}} key={id??"unknown"} className="group/server border-b border-gray-800 pb-4"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">{id?q.data!.context[id]?.name??`Тайтл ${id}`:"Неопознанные серии"}<ChevronDownIcon className="h-4 w-4 transition-transform group-open/server:rotate-180 motion-reduce:transition-none"/></summary><div className="mt-3 flex gap-3 overflow-x-auto pb-3" tabIndex={0} aria-label="Серии на медиасервере">{q.data!.files.filter(f=>f.title===id).map(f=><div key={f.key} className="w-36 shrink-0 rounded-lg bg-gray-800/30 p-2"><div className="flex items-center justify-between gap-1">{id&&f.ep&&f.ready?<Link className="text-sm hover:text-accent-300" href={`/anime/${id}/watch/${f.ep}`}>Серия {f.ep}</Link>:<span className="text-sm">{f.ep?`Серия ${f.ep}`:"Номер неизвестен"}</span>}<button disabled={busy||f.inUse} title={f.inUse?"Серия используется или подготавливается":"Удалить копию"} aria-label={`Удалить серию ${f.ep??f.key}`} onClick={()=>void remove(f.key,f.ep)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-700 hover:text-rose-300 focus-visible:outline-2 focus-visible:outline-accent-300 disabled:opacity-35"><TrashIcon className="h-4 w-4"/></button></div><div className="my-2 flex h-1.5 overflow-hidden rounded-full bg-gray-700" role="progressbar" aria-label={`Серия ${f.ep??""}: скачивание и подготовка`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.ready?100:Math.round(f.progress*80)}><div className="w-4/5"><div className="h-full bg-accent-400" style={{width:`${f.ready?100:f.progress*100}%`}}/></div><div className="w-1/5"><div className="h-full bg-emerald-400" style={{width:f.ready?"100%":"0%"}}/></div></div><p className="text-xs text-gray-400">{bytes(f.stored)}</p></div>)}</div></details>)}
  </>}</div>;
}
