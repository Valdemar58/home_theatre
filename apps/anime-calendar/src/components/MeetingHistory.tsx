"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api, useMe } from "@/lib/client";
import type { GroupPlan, GroupSession } from "@/lib/groups";
import type { SharedListDetail } from "@/lib/types";
import { displayTitle } from "@/lib/schedule";
import { episodeLabel, legacyBlocks } from "@/lib/session-plan";
import { Avatar } from "./Avatar";
import { Img } from "./Img";
import { Button, ErrorBox, cx } from "./ui";

const outcome:Record<string,string>={done:"Завершён",cancelled:"Отменён",missed:"Не состоялся",interrupted:"Прерван"};
const date=(t:number)=>new Date(t*1000).toLocaleString("ru-RU",{dateStyle:"medium",timeStyle:"short"});
export function MeetingHistory({plan,list}:{plan:GroupPlan;list:SharedListDetail}) {
  const {data:me}=useMe();
  const [editing,setEditing]=useState<number|null>(null);
  const past=plan.sessions.filter(s=>!["planned","live"].includes(s.status)).sort((a,b)=>b.startsAt-a.startsAt);
  const name=(id:number)=>{const m=list.items.find(x=>x.media.id===id)?.media;return m?displayTitle(m.title):`Тайтл #${id}`;};
  return <section className="space-y-4 border-t border-gray-700 pt-6" aria-label="История сеансов">
    <h3 className="text-lg font-semibold">История сеансов</h3>
    {!past.length&&<p className="text-sm text-gray-400">Здесь появятся результаты встреч — просмотренные серии и участники.</p>}
    <ol className="space-y-4">{past.map(s=><li key={s.id} className="rounded-xl bg-gray-800/40 p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-4"><div className="flex shrink-0 -space-x-5">{(s.plan?.blocks??legacyBlocks(s)).slice(0,3).map(b=>{const m=list.items.find(i=>i.media.id===b.anilistId)?.media;return <span key={b.anilistId} className="relative block h-20 w-14 overflow-hidden rounded-md bg-gray-700 ring-2 ring-gray-800">{m?.coverImage.large&&<Img src={m.coverImage.large} size="thumb" className="h-full w-full object-cover"/>}</span>;})}</div><div className="min-w-0 space-y-1">{(s.plan?.blocks??legacyBlocks(s)).map(b=><Link key={b.anilistId} href={`/anime/${b.anilistId}`} className="block text-sm font-medium hover:text-accent-300">{name(b.anilistId)}</Link>)}</div></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-medium">{date(s.startsAt)}</h4><p className="mt-1 text-sm text-gray-400">{outcome[s.status]}{s.result?.source==="organizer"?" · отмечено организатором":""}</p></div>
        {list.ownerId===me?.id&&<Button variant="ghost" size="sm" onClick={()=>setEditing(editing===s.id?null:s.id)}>{editing===s.id?"Закрыть редактор":"Исправить результат"}</Button>}</div>
      {editing===s.id?<ResultEditor session={s} list={list} onDone={()=>setEditing(null)}/>:<>
        <div className="mt-4 space-y-2">{s.result?.results.filter(r=>r.episodes.length).map(r=><p key={r.anilistId} className="text-sm"><Link className="font-medium hover:text-accent-300" href={`/anime/${r.anilistId}`}>{name(r.anilistId)}</Link><span className="text-gray-400"> · просмотрены серии {episodeLabel(r.episodes)}</span></p>)}</div>
        {!s.result?.results.some(r=>r.episodes.length)&&<p className="mt-3 text-sm text-gray-400">Просмотренные серии не зафиксированы.</p>}
        <div className="mt-4 flex items-center gap-3"><div className="flex -space-x-2">{(s.result?.attendees??[]).slice(0,6).map(id=><Avatar key={id} user={list.members.find(x=>x.id===id)??{id,name:`Участник #${id}`}} className="h-8 w-8 ring-2 ring-gray-800"/>)}</div>
          {(s.result?.attendees.length??0)>6&&<details><summary className="cursor-pointer text-sm text-gray-300">+{s.result!.attendees.length-6}</summary><p className="mt-2 text-sm">{s.result!.attendees.map(id=>list.members.find(x=>x.id===id)?.name??`#${id}`).join(", ")}</p></details>}</div>
        {s.result?.note&&<p className="mt-3 whitespace-pre-wrap text-sm text-gray-300">{s.result.note}</p>}
        {!!s.result?.journal.length&&<details className="mt-4 text-sm"><summary className="cursor-pointer text-gray-400 hover:text-gray-200">История исправлений · {s.result.journal.length}</summary><ol className="mt-3 space-y-3">{s.result.journal.map(j=><li key={j.id}><p className="text-gray-400">{date(j.created_at)} · {list.members.find(x=>x.id===j.actor_id)?.name??`#${j.actor_id}`}</p>{j.payload.results.map(r=><p key={r.anilistId}>{name(r.anilistId)} · {episodeLabel(r.episodes)||"без серий"}</p>)}<p className="text-gray-400">{j.payload.attendees.map(id=>list.members.find(x=>x.id===id)?.name??`#${id}`).join(", ")||"Без личных отметок"}</p></li>)}</ol></details>}
      </>}
    </li>)}</ol>
  </section>;
}

function ResultEditor({session:s,list,onDone}:{session:GroupSession;list:SharedListDetail;onDone:()=>void}) {
  const qc=useQueryClient();
  const [revision]=useState(s.revision);
  const stale=revision!==s.revision;
  const initial=s.result?.source==="organizer"||s.result?.results.length?s.result.results:(s.plan?.blocks??legacyBlocks(s)).map(b=>({anilistId:b.anilistId,episodes:b.episodes}));
  const [results,setResults]=useState(initial);
  const [attendees,setAttendees]=useState(s.result?s.result.attendees:s.rsvp.filter(x=>x.answer==="yes").map(x=>x.userId));
  const [note,setNote]=useState(s.result?.note??"");
  const [preview,setPreview]=useState<{changes:{userId:number;added:typeof results;removed:typeof results}[]}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const request=async(save:boolean)=>{
    setBusy(true);setError(null);
    try { const response=await api<{changes:{userId:number;added:typeof results;removed:typeof results}[]}>(`/api/shared-lists/${list.id}/history/${s.id}`,{method:"POST",json:{results,attendees,note,revision,preview:!save}});
      if(save){await Promise.all([qc.invalidateQueries({queryKey:["group",list.id]}),qc.invalidateQueries({queryKey:["shared-list",list.id]}),qc.invalidateQueries({queryKey:["watch-history"]}),qc.invalidateQueries({queryKey:["list"]})]);onDone();}else setPreview(response);
    }catch(e){setError(e);}finally{setBusy(false);}
  };
  const title=(id:number)=>{const m=list.items.find(x=>x.media.id===id)?.media;return m?displayTitle(m.title):`Тайтл #${id}`;};
  return <div className="mt-5 space-y-5 border-t border-gray-700 pt-5">
    <p className="max-w-2xl text-sm text-gray-300">Укажите, что действительно посмотрели — здесь или во внешнем сервисе. Личные отметки получат только выбранные участники.</p>
    {error?<ErrorBox error={error}/>:null}
    {stale&&<p role="alert" className="text-sm text-gray-300">Результат встречи изменился. Закройте редактор и откройте его снова, чтобы увидеть актуальные отметки.</p>}
    {!preview?<>
      {results.map((r,index)=>{const m=list.items.find(x=>x.media.id===r.anilistId)?.media;const count=m?.episodes??Math.max(1,...r.episodes);
        return <fieldset key={r.anilistId} disabled={busy}><legend className="mb-3 font-medium">{title(r.anilistId)}</legend><div className="mb-2 flex gap-4"><button className="text-sm text-gray-400 hover:text-white" onClick={()=>setResults(results.map((x,i)=>i===index?{...x,episodes:[]}:x))}>Сбросить</button><button className="text-sm text-gray-400 hover:text-white" onClick={()=>setResults(results.map((x,i)=>i===index?{...x,episodes:Array.from({length:count},(_,i)=>i+1)}:x))}>Отметить все</button></div>
        <div className="flex flex-wrap gap-2">{Array.from({length:count},(_,i)=>i+1).map(ep=><button key={ep} aria-label={`Серия ${ep}`} aria-pressed={r.episodes.includes(ep)} onClick={()=>setResults(results.map((x,i)=>i===index?{...x,episodes:x.episodes.includes(ep)?x.episodes.filter(e=>e!==ep):[...x.episodes,ep].sort((a,b)=>a-b)}:x))} className={cx("min-h-11 min-w-11 rounded-md px-2 text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-accent-300 motion-reduce:transition-none",r.episodes.includes(ep)?"tone-accent soft":"bg-gray-900 text-gray-300 hover:bg-gray-700")}>{ep}</button>)}</div></fieldset>;})}
      <label className="block text-sm">Добавить тайтл<select disabled={busy} value="" className="mt-2 block w-full rounded-lg border border-gray-600 bg-gray-900 p-2" onChange={e=>{if(e.target.value)setResults([...results,{anilistId:Number(e.target.value),episodes:[]}]);}}><option value="">Из списка комнаты…</option>{list.items.filter(i=>!results.some(r=>r.anilistId===i.media.id)).map(i=><option key={i.media.id} value={i.media.id}>{displayTitle(i.media.title)}</option>)}</select></label>
      <fieldset disabled={busy}><legend className="mb-3 font-medium">Кто участвовал</legend><div className="flex flex-wrap gap-3">{list.members.filter(m=>m.status==="member").map(m=><label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-lg bg-gray-900/50 px-3 py-2"><input type="checkbox" checked={attendees.includes(m.id)} onChange={()=>setAttendees(attendees.includes(m.id)?attendees.filter(x=>x!==m.id):[...attendees,m.id])}/><Avatar user={m}/><span className="text-sm">{m.name}</span></label>)}</div></fieldset>
      <label className="block text-sm">Комментарий к исправлению<textarea disabled={busy} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} placeholder="Например, смотрели вместе вне приложения" className="mt-2 block min-h-20 w-full rounded-lg border border-gray-600 bg-gray-900 p-3"/></label>
    </>:<div className="space-y-3" aria-live="polite"><h5 className="font-semibold">Проверьте изменения</h5><p className="text-sm font-medium">Результат группы</p>{results.filter(r=>r.episodes.length).map(r=><p key={r.anilistId} className="text-sm text-gray-300">{title(r.anilistId)} · серии {episodeLabel(r.episodes)}</p>)}{!results.some(r=>r.episodes.length)&&<p className="text-sm text-gray-400">Без просмотренных серий</p>}{preview.changes.map(change=><div key={change.userId} className="border-b border-gray-700 pb-3"><p className="font-medium">{list.members.find(m=>m.id===change.userId)?.name??`#${change.userId}`}</p>{change.added.map(r=><p key={r.anilistId} className="text-sm text-gray-300">Добавить отметку: {title(r.anilistId)} · {episodeLabel(r.episodes)}</p>)}{change.removed.map(r=><p key={r.anilistId} className="text-sm text-gray-300">Убрать отметку этой встречи: {title(r.anilistId)} · {episodeLabel(r.episodes)}</p>)}{!change.added.length&&!change.removed.length&&<p className="text-sm text-gray-400">Без изменений отметок встречи</p>}</div>)}{!attendees.length&&<p className="text-sm text-gray-300">Изменится только результат группы, без личных отметок.</p>}<p className="text-sm text-gray-400">Измеренные просмотры и более поздний личный прогресс сохраняются. Предыдущие отметки этой встречи будут заменены; участники смогут исправить свои.</p></div>}
    <div className="flex flex-wrap gap-3"><Button variant={preview?"primary":"default"} disabled={busy||stale} onClick={()=>void request(Boolean(preview))}>{busy?"Сохраняем…":preview?"Сохранить результат":"Проверить изменения"}</Button><Button disabled={busy} variant="ghost" onClick={()=>preview?setPreview(null):onDone()}>{preview?"Назад к выбору":"Отмена"}</Button></div>
  </div>;
}
