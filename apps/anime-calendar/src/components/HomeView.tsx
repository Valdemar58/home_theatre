"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlayIcon, ArrowRightIcon, ComputerDesktopIcon, CalendarDaysIcon } from "@heroicons/react/24/outline";
import { api } from "@/lib/client";
import { displayTitle } from "@/lib/schedule";
import { episodeLabel, sessionTimeline } from "@/lib/session-plan";
import type { homeData } from "@/server/home";
import { Avatar } from "./Avatar";
import { Button, ErrorBox } from "./ui";

type Home = ReturnType<typeof homeData>;
type Job = { id:string;title:number;titleName:string;state:string;files?:{selected:boolean;bytes:number;downloaded:number;prepareState?:string;prepareProgress?:number}[] };
const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-300";
const quiet = `${action} bg-gray-800 text-gray-200 hover:bg-gray-700`;
const primary = `${action} tone-accent solid hover:brightness-110`;
const date = (t:number) => new Date(t*1000).toLocaleString("ru-RU", {day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"});
const clock = (t:number) => new Date(t*1000).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
const position = (t:number) => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,"0")}`;
const states:Record<string,string> = {selecting:"Выберите серии",paused:"На паузе",error:"Требуется внимание",verifying:"Проверка файлов",downloading:"Скачивание",preparing:"Подготовка"};
function Cover({media,large=false}:{media:Home["continuing"][number]["media"]|null;large?:boolean}) {
  return <div className={`${large ? "w-24 sm:w-28" : "w-12"} aspect-[2/3] shrink-0 overflow-hidden rounded-lg bg-gray-700`}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {media?.coverImage.large && <img src={media.coverImage.large} alt="" className="h-full w-full object-cover" />}
  </div>;
}
export function HomeView() {
  const q = useQuery({queryKey:["home"],queryFn:()=>api<Home>("/api/home"),refetchInterval:10000});
  const data=q.data, feature=data?.continuing[0], next=data?.next;
  const timeline=next?.plan ? sessionTimeline(next.plan.blocks,next.startsAt,next.plan.skipCredits) : [];
  return <div className="mx-auto max-w-6xl space-y-8 pb-8">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-semibold tracking-tight">Главная</h1><p className="mt-2 text-gray-400">Ваш просмотр, планы и устройства.</p></div><Link className={quiet} href="/browse">Найти аниме<ArrowRightIcon className="h-4 w-4" /></Link></header>
    {q.isError && <div role="alert"><ErrorBox error="Не удалось обновить главную. Проверьте соединение." /><Button onClick={()=>q.refetch()}>Повторить</Button></div>}
    {!data && !q.isError && <p className="py-12 text-gray-400" role="status">Загружаем ваш просмотр и планы…</p>}
    {data && <>
      <section aria-labelledby="continue-heading"><div className="mb-4 flex items-center justify-between gap-3"><h2 id="continue-heading" className="text-xl font-semibold">Продолжить просмотр</h2><Link href="/lists" className="py-2 text-sm text-accent-300 hover:underline">Мои списки</Link></div>
        {feature ? <><div className="flex flex-col gap-6 rounded-2xl bg-gray-800/70 p-5 sm:flex-row sm:items-center sm:p-7"><div className="flex items-start gap-5 sm:contents"><Cover media={feature.media} large /><div className="min-w-0 flex-1"><h3 className="text-2xl font-semibold leading-tight sm:text-2xl">{displayTitle(feature.media.title)}</h3><p className="mt-3 text-gray-300">{feature.status === "rewatching" ? "Пересмотр · " : ""}Серия {feature.ep}{feature.position > 0 ? ` · ${position(feature.position)}` : ""}{feature.media.episodes ? ` из ${feature.media.episodes}` : ""}</p><p className="mt-2 text-sm text-gray-400">{feature.available ? (feature.position ? "Продолжите с сохранённого места." : "Следующая непросмотренная серия.") : feature.releaseAt ? `Выход ${date(feature.releaseAt)}` : "Ждём подтверждения выхода следующей серии."}</p><div className="mt-6 hidden flex-wrap gap-3 sm:flex"><ContinueLink devices={data.devices} item={feature} /><Link href={`/anime/${feature.media.id}`} className={quiet}>О тайтле</Link></div></div></div><div className="flex flex-wrap gap-3 sm:hidden"><ContinueLink devices={data.devices} item={feature}/><Link href={`/anime/${feature.media.id}`} className={quiet}>О тайтле</Link></div></div>
          {data.continuing.length>1 && <div className="mt-4 divide-y divide-gray-800">{data.continuing.slice(1).map(item=><div key={item.media.id} className="flex items-center gap-4 py-3"><Cover media={item.media}/><div className="min-w-0 flex-1"><Link href={`/anime/${item.media.id}`} className="line-clamp-2 font-medium hover:text-accent-300">{displayTitle(item.media.title)}</Link><p className="mt-1 text-sm text-gray-400">Серия {item.ep}{!item.available ? " · ожидается" : ""}</p></div><ContinueLink devices={data.devices} item={item} compact/></div>)}</div>}</>
        : <div className="rounded-2xl bg-gray-800/50 p-6"><p className="text-lg">Здесь появится ваш текущий просмотр</p><p className="mt-2 max-w-xl text-sm text-gray-400">Начните смотреть тайтл — следующий раз можно будет продолжить прямо отсюда.</p><Link href="/lists" className={`${quiet} mt-5`}>Выбрать из моих списков</Link></div>}
      </section>
      <section aria-labelledby="session-heading"><div className="mb-4 flex items-center justify-between gap-3"><h2 id="session-heading" className="text-xl font-semibold">{next?.status === "live" ? "Сейчас в комнате" : "Ближайший сеанс"}</h2><Link href="/groups" className="py-2 text-sm text-accent-300 hover:underline">Все комнаты</Link></div>
        {next ? <div className="rounded-2xl bg-gray-800/50 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="flex items-center gap-2 text-accent-300"><CalendarDaysIcon className="h-5 w-5"/>{next.status === "live" ? "Просмотр идёт" : date(next.startsAt)}</p><h3 className="mt-2 text-xl font-semibold">{next.groupName}</h3></div><Link className={next.status === "live" ? primary : quiet} href={`/groups/${next.groupId}`}>{next.status === "live" ? "Присоединиться" : "Открыть сеанс"}<ArrowRightIcon className="h-4 w-4"/></Link></div>
          <div className="mt-5 space-y-4">{next.titles.map((block,i)=><div key={`${block.anilistId}-${i}`} className="flex items-center gap-4"><Cover media={block.media}/><div className="min-w-0 flex-1"><Link href={`/anime/${block.anilistId}`} className="font-medium hover:text-accent-300">{block.media ? displayTitle(block.media.title) : `Тайтл ${block.anilistId}`}</Link><p className="mt-1 text-sm text-gray-400">Серии {episodeLabel(block.episodes)}{timeline[i] ? ` · ≈ ${clock(timeline[i].start)}–${clock(timeline[i].end)}` : ""}{i<next.titles.length-1 && block.breakMinutes>0 ? ` · перерыв ${block.breakMinutes} мин` : ""}</p></div></div>)}</div>
          {next.attendees.length>0 && <div className="mt-5 flex items-center gap-3"><div className="flex -space-x-2">{next.attendees.slice(0,5).map(u=><Avatar key={u.id} user={u} className="h-8 w-8 ring-2 ring-gray-800"/>)}</div><span className="text-sm text-gray-400">{next.attendees.length>5 ? `+${next.attendees.length-5} · ` : ""}Подтвердили участие</span></div>}
        </div> : <div className="border-t border-gray-800 py-5"><p className="text-gray-300">Ближайших встреч пока нет</p><p className="mt-2 text-sm text-gray-400">Выберите комнату, чтобы спланировать просмотр с друзьями.</p></div>}
      </section>
      <section aria-labelledby="downloads-heading"><div className="mb-4 flex items-center justify-between gap-3"><h2 id="downloads-heading" className="text-xl font-semibold">Текущие загрузки</h2><Link href="/downloads" className="py-2 text-sm text-accent-300 hover:underline">Все загрузки</Link></div>
        {data.devices.length ? <div className="divide-y divide-gray-800">{data.devices.map(device=>{const jobs=(device.jobs as Job[]).filter(j=>!["ready","cancelled"].includes(j.state));return <div key={device.id} className="py-4 first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-medium"><ComputerDesktopIcon className="h-5 w-5 text-gray-400"/>{device.label}</h3><span className="text-sm text-gray-400">{device.online ? "В сети" : "Не в сети"}</span></div>
          {!device.online && device.updatedAt && <p className="mt-2 text-xs text-gray-400">Последнее обновление: {date(device.updatedAt)}</p>}
          {device.queued>0 && <p className="mt-3 text-sm text-accent-300">В очереди действий: {device.queued}{!device.online ? " · ждут подключения приложения" : ""}</p>}
          {!jobs.length && !device.queued && <p className="mt-3 text-sm text-gray-400">Нет активных загрузок</p>}
          {jobs.slice(0,3).map(job=>{const files=(job.files??[]).filter(f=>f.selected);const total=files.reduce((s,f)=>s+f.bytes,0);const downloaded=total ? Math.min(1,files.reduce((s,f)=>s+f.downloaded,0)/total) : 0;const prepared=files.length ? files.reduce((s,f)=>s+(f.prepareState==="ready"?1:Math.max(0,Math.min(1,f.prepareProgress??0))),0)/files.length : 0;return <Link key={job.id} href={`/downloads?device=${device.id}`} className="mt-4 block rounded-lg p-2 -mx-2 hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-accent-300"><div className="flex items-baseline justify-between gap-3 text-sm"><span className="min-w-0 truncate">{job.titleName}</span><span className="shrink-0 text-gray-400">{states[job.state] ?? job.state}</span></div><div role="progressbar" aria-label={`${job.titleName}: загрузка и подготовка`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(downloaded*80+prepared*20)} className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-gray-800"><div className="w-4/5"><div className="h-full bg-accent-400" style={{width:`${downloaded*100}%`}}/></div><div className="w-1/5"><div className="h-full bg-emerald-400" style={{width:`${prepared*100}%`}}/></div></div></Link>})}
          {jobs.length>3 && <Link className="mt-3 inline-block py-2 text-sm text-accent-300" href={`/downloads?device=${device.id}`}>Ещё {jobs.length-3} загрузок</Link>}
        </div>})}</div> : <div className="border-t border-gray-800 py-5"><p className="text-gray-300">Домашний компьютер ещё не подключён</p><p className="mt-2 text-sm text-gray-400">Привяжите desktop-приложение к аккаунту, чтобы отправлять загрузки из браузера.</p><Link href="/devices" className={`${quiet} mt-4`}>Подключить устройство</Link></div>}
      </section>
    </>}
  </div>;
}
function ContinueLink({item,devices,compact=false}:{item:Home["continuing"][number];devices:Home["devices"];compact?:boolean}) {
  const [device,setDevice]=useState("");
  useEffect(()=>{const remembered=sessionStorage.getItem("home-theater-device");setDevice(devices.some(d=>d.id===remembered) ? remembered! : "");},[devices]);
  return item.available ? <Link href={`/anime/${item.media.id}/watch/${item.ep}${device ? `?device=${encodeURIComponent(device)}` : ""}`} className={compact ? quiet : primary}><PlayIcon className="h-4 w-4"/>{compact ? "Смотреть" : "Продолжить"}</Link> : <Link href={`/anime/${item.media.id}`} className={quiet}>Ожидается</Link>;
}

