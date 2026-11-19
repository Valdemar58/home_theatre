"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { Button, ErrorBox } from "./ui";
import { episodeLabel } from "@/lib/session-plan";
export type WatchHistoryData={days:number;cycles:{id:string;title:string;anilist_id:number;baseline:number;prior_completed:number;started_at:number|null;ended_at:number|null;outcome:string|null;episodes:number[];events:{id:string;ep:number;source:string;revoked_at:number|null;created_at:number;actor_id:number}[]}[]};
export function WatchHistorySettings(){
  const qc=useQueryClient();const{data,error}=useQuery({queryKey:["watch-history"],queryFn:()=>api<WatchHistoryData>("/api/watch-history")});
  const[days,setDays]=useState<number|null>(null),[busy,setBusy]=useState(false),[failure,setFailure]=useState<unknown>(null),[saved,setSaved]=useState(false);
  const act=async(body:unknown)=>{setBusy(true);setFailure(null);setSaved(false);try{await api("/api/watch-history",{method:"POST",json:body});await qc.invalidateQueries({queryKey:["watch-history"]});await qc.invalidateQueries({queryKey:["list"]});setSaved(true);}catch(e){setFailure(e);}finally{setBusy(false);}};
  return <section className="space-y-4 rounded-xl bg-gray-800/60 p-6 ring-1 ring-gray-700"><h2 className="text-lg font-semibold">Прогресс и история просмотра</h2>
    {error||failure?<ErrorBox error={error??failure}/>:null}
    {!data?<p className="text-sm text-gray-400">Загружаем историю…</p>:<>
    <p className="text-sm text-gray-300">После перерыва первый просмотр переходит в «Брошено», пересмотр — обратно в «Просмотрено». Ожидание новых серий не считается.</p>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Дней без просмотра<input type="number" min={0} max={3650} value={days??data.days} onChange={e=>{setDays(Number(e.target.value));setSaved(false);}} className="mt-2 block w-32 rounded-lg border border-gray-600 bg-gray-900 p-2"/></label><Button disabled={busy} onClick={()=>void act({action:"preferences",days:days??data.days})}>Сохранить</Button></div>
    <p className="text-xs text-gray-400">0 — отключить автоматическую смену статуса.</p>{saved&&<p role="status" className="text-sm text-accent-300">Изменения сохранены</p>}
    <details><summary className="cursor-pointer py-2 text-sm text-gray-300 hover:text-white">Циклы просмотра и отметки организатора</summary>
    {!data.cycles.length?<p className="mt-3 text-sm text-gray-400">Новая подробная история появится после просмотра. Старые списки сохранены.</p>:<ol className="mt-3 space-y-4">{data.cycles.map(c=><li key={c.id} className="border-t border-gray-700 pt-4"><Link href={`/anime/${c.anilist_id}`} className="font-medium hover:text-accent-300">{c.title}</Link><p className="text-sm text-gray-400">{c.prior_completed?"Пересмотр":"Первый просмотр"} · {c.outcome==="corrected"?"отметки отменены":c.outcome==="completed"?"завершён":c.outcome==="inactive"?"завершён по неактивности":c.started_at?"в процессе":"ещё не начат"}</p>
      {c.baseline>0&&<p className="mt-1 text-xs text-gray-400">Старый счётчик: {c.baseline} серий. Подробности не восстанавливались.</p>}<p className="mt-2 text-sm">{c.episodes.length?`Серии: ${episodeLabel(c.episodes)}`:"Просмотренных серий пока нет"}</p>
      {c.events.filter(e=>e.source==="organizer").map(e=><div key={e.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm"><span>Серия {e.ep} · отмечено организатором{e.revoked_at?" · отменено":""}</span>{!e.revoked_at&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void act({action:"revoke",id:e.id})}>Я не смотрел эту серию</Button>}</div>)}
    </li>)}</ol>}</details></>}
  </section>;
}
