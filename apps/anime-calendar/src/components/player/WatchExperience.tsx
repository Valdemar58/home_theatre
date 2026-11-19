"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CheckIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { api } from "@/lib/client";
import { stateAt } from "@/lib/plot-deep";
import type { PlotInfo, TitleCast } from "@/lib/types";
import { Discussion } from "../Discussion";
import { Img } from "../Img";
import { cx, ErrorBox } from "../ui";

export function WatchTabs({id,value,items,onChange}:{id:string;value:string;items:readonly (readonly [string,string])[];onChange:(v:string)=>void}) {
 return <div role="tablist" aria-label={id==="watch-content"?"О серии":"Инструменты просмотра"} className="relative grid border-b border-gray-700" style={{gridTemplateColumns:`repeat(${items.length},minmax(0,1fr))`}}>
  {items.map(([key,label],i)=><button key={key} id={`${id}-${key}`} role="tab" aria-selected={value===key} aria-controls={`${id}-panel-${key}`} tabIndex={value===key?0:-1} onClick={()=>onChange(key)} onKeyDown={e=>{const n=e.key==="ArrowRight"?(i+1)%items.length:e.key==="ArrowLeft"?(i+items.length-1)%items.length:e.key==="Home"?0:e.key==="End"?items.length-1:null;if(n!==null){e.preventDefault();onChange(items[n][0]);document.getElementById(`${id}-${items[n][0]}`)?.focus();}}} className={cx("min-h-11 px-2 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent-300",value===key?"text-white":"text-gray-400 hover:text-gray-100")}>{label}</button>)}
  <span aria-hidden className="absolute bottom-0 h-0.5 bg-accent-400 transition-transform duration-200 ease-out motion-reduce:transition-none" style={{width:`${100/items.length}%`,transform:`translateX(${items.findIndex(([k])=>k===value)*100}%)`}}/>
 </div>;
}
export type WatchPhase="source"|"download"|"prepare"|"watch";
const phases:[[WatchPhase,string],[WatchPhase,string],[WatchPhase,string],[WatchPhase,string]]=[["source","Выбор источника"],["download","Загрузка серии"],["prepare","Подготовка к просмотру"],["watch","Просмотр"]];
export function WatchStep({phase,progress}:{phase:WatchPhase;progress?:number}) {
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{setElapsed(0);if(phase!=="download"&&phase!=="prepare")return;const since=Date.now(),timer=setInterval(()=>setElapsed(Math.floor((Date.now()-since)/1000)),1000);return()=>clearInterval(timer);},[phase]);
 const index=phases.findIndex(([k])=>k===phase);
 return <details className="group/step text-sm"><summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-3 rounded-lg px-1 text-gray-200 focus-visible:outline-2 focus-visible:outline-accent-300"><span className="h-2 w-2 rounded-full bg-accent-400"/><span>{phases[index][1]}</span>{(phase==="download"||phase==="prepare")&&<span className="text-xs tabular-nums text-gray-400" title="Время наблюдения за текущим этапом">{progress!==undefined?`${Math.round(progress*100)}% · `:""}{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,"0")}</span>}<ChevronDownIcon className="h-4 w-4 text-gray-400 transition-transform group-open/step:rotate-180 motion-reduce:transition-none"/></summary><ol className="mb-3 flex flex-wrap gap-x-5 gap-y-2 pl-6 text-xs text-gray-400">{phases.map(([key,name],i)=><li key={key} aria-current={key===phase?"step":undefined} className={cx("flex items-center gap-1.5",key===phase&&"text-accent-300")}>{i<index&&<CheckIcon className="h-3 w-3"/>}{name}</li>)}</ol></details>;
}
function EpisodeCast({id,ep}:{id:number;ep:number}) {
 const cast=useQuery({queryKey:["cast",id,ep],queryFn:()=>api<TitleCast>(`/api/anime/${id}/cast?at=${ep}`),staleTime:600000});
 if(cast.error)return <ErrorBox error={cast.error}/>;
 if(!cast.data)return <p role="status" className="text-sm text-gray-400">Загружаем персонажей…</p>;
 if(!cast.data.built)return <p className="text-sm text-gray-400">Разбор персонажей по сериям ещё не готов. Общий состав доступен на <Link href={`/anime/${id}/characters`} className="text-accent-300">странице персонажей</Link>.</p>;
 return <div><p className="mb-4 text-xs text-gray-400">Что известно к концу серии {ep}</p><div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{cast.data.members.map(m=><Link key={m.href} href={m.href} className="group flex items-center gap-3 rounded-lg p-2 hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-accent-300"><div className="grid h-16 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-gray-800">{m.image?<Img src={m.image} size="thumb" className="h-full w-full object-cover"/>:<UserIcon className="h-5 w-5 text-gray-400"/>}</div><span className="min-w-0 text-sm">{m.name}{m.lookLabel&&<span className="mt-1 block text-xs text-gray-400">{m.lookLabel}</span>}</span></Link>)}</div>{!cast.data.members.length&&<p className="text-sm text-gray-400">Для этой серии персонажи ещё не описаны.</p>}</div>;
}
export function EpisodePanels({id,ep,plot}:{id:number;ep:number;plot?:PlotInfo}) {
 const [tab,setTab]=useState("discussion");
 const info=plot?.episodes.find(e=>e.number===ep), before=stateAt(plot?.season?.states??[],ep-1), current=stateAt(plot?.season?.states??[],ep);
 return <section className="min-w-0 space-y-5"><WatchTabs id="watch-content" value={tab} onChange={setTab} items={[["discussion","Обсуждение"],["description","Описание"],["characters","Персонажи"]]}/><div key={tab} role="tabpanel" id={`watch-content-panel-${tab}`} aria-labelledby={`watch-content-${tab}`} className="watch-panel min-h-40">
 {tab==="discussion"?<Discussion key={`${id}:${ep}`} anilistId={id} episode={ep} compact/>:tab==="characters"?<EpisodeCast id={id} ep={ep}/>:<div className="max-w-3xl space-y-6"><p className="whitespace-pre-line text-sm leading-relaxed text-gray-300">{info?.overview||"Краткое описание этой серии пока не получено."}</p><div className="divide-y divide-gray-800">{[["События до этой серии",before.state?.retelling_ru||"",Object.entries(before.beats).filter(([n])=>Number(n)>(before.state?.upTo??0)).map(([n,t])=>`${n} серия · ${t}`).join("\n\n")],["События серии",current.beats[ep]||"",""]].map(([title,text,tail])=><details key={title} className="group/story py-4"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium"><span>{title}</span><ChevronDownIcon className="h-4 w-4 text-gray-400 transition-transform group-open/story:rotate-180 motion-reduce:transition-none"/></summary><p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-300">{[text,tail].filter(Boolean).join("\n\n")||"Разбор этих событий ещё не готов."}</p></details>)}</div></div>}
 </div></section>;
}
