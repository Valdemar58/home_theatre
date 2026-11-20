"use client";
import { ChevronDownIcon, ExclamationTriangleIcon, TrashIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/client";
import { relative } from "@/lib/time";
import type { QueueItem } from "@/server/downloads";
import type { PrebufferProgress } from "@/server/prebuffer";
import type { StreamItem } from "@/server/stream";
import { useHoverCard } from "./HoverCard";
import { Img } from "./Img";
import { Button, cx, EmptyState, ErrorBox, Skel } from "./ui";
import { useAlert, useConfirm } from "./Dialogs";
import { DownloadProgress, StoragePanel } from "./DownloadInventory";
import { ServerDownloadStorage } from "./ServerDownloadStorage";
import type { serverDownloadStorage } from "@/server/download-storage";
type ServerStorage = Awaited<ReturnType<typeof serverDownloadStorage>>;

// «Загрузки»: что смотрится онлайн (TorrServer) и что качается (Sonarr → qBittorrent).
// Обновляется раз в 3 с, пока страница открыта.

type Downloads = {
  streams: StreamItem[]; streamsError: string | null; queue: QueueItem[]; queueError: string | null;
  prebuffer: PrebufferProgress[]; prebufferQueued: string[];
  prep?: { count: number; downloading: number; used: number; limit: number };
};

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
const speed = (b: number) => (b > 0 ? `${(b / 1e6).toFixed(1)} МБ/с` : null);
const eta = (s: number) => (s < 90 ? `${Math.ceil(s)} с` : s < 5400 ? `${Math.round(s / 60)} мин` : `${(s / 3600).toFixed(1)} ч`);

/** Хватает ли скорости активной раздачи для просмотра без остановок. */
function SpeedVerdict({ s }: { s: StreamItem }) {
  if (!s.rate || s.speed <= 0) return null;
  const ok = s.speed >= s.rate * 1.2;
  return (
    <p className={cx("text-xs", ok ? "text-green-300" : "text-amber-300")}>
      Для просмотра нужно ~{(s.rate / 1e6).toFixed(1)} МБ/с, сейчас {(s.speed / 1e6).toFixed(1)} МБ/с —{" "}
      {ok ? "скорости хватает" : "будут остановки: подготовьте серию заранее"}
    </p>
  );
}

/** Один уровень раскрытия: серия, размер, прогресс и действия. */
function Episodes({ s, data, stored, onChange }: { s: StreamItem; data: Downloads; stored?:ServerStorage; onChange: () => void }) {
  const [open,setOpen]=useState(false), [busy,setBusy]=useState(false);
  const alert=useAlert(),confirm=useConfirm();
  const prepared=(index:number)=>stored?.files.find(f=>f.key===`${s.hash}:${index}`);
  const progress=(index:number)=>data.prebuffer.find(p=>p.hash===s.hash&&p.index===index);
  const total=s.files.reduce((n,f)=>n+(f.bytes||prepared(f.index)?.bytes||progress(f.index)?.size||0),0);
  const seasonSize=s.files.every(f=>f.bytes||prepared(f.index)?.bytes||progress(f.index)?.size)?total:Math.max(total,s.size);
  const downloaded=s.files.reduce((n,f)=>n+(prepared(f.index)?.ready?(f.bytes||prepared(f.index)!.bytes):Math.min(progress(f.index)?.read||0,f.bytes||prepared(f.index)?.bytes||progress(f.index)?.size||0)),0);
  const ready=s.files.reduce((n,f)=>n+(prepared(f.index)?.ready?(f.bytes||prepared(f.index)!.bytes):0),0);
  const act=async(index:number,remove=false)=>{
    if(busy)return;
    if(remove&&!await confirm({title:"Удалить скачанную серию?",text:"Удалится копия с диска. История просмотра и источник сохранятся.",confirm:"Удалить",danger:true}))return;
    setBusy(true);
    try{await api(remove?"/api/downloads/storage":"/api/downloads/prebuffer",{method:remove?"DELETE":progress(index)||data.prebufferQueued.includes(`${s.hash}:${index}`)?"DELETE":"POST",json:remove?{key:`${s.hash}:${index}`}:{hash:s.hash,index}});onChange();}catch(e){alert({title:"Не получилось",text:e instanceof Error?e.message:String(e)});}finally{setBusy(false);}
  };
  if(!s.files.length)return null;
  return <div className="space-y-2 pt-1"><DownloadProgress download={seasonSize?downloaded/seasonSize:0} prepare={seasonSize?ready/seasonSize:0} label={`Весь сезон: ${s.title}`}/><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)} className="inline-flex min-h-9 items-center gap-1 rounded text-xs text-gray-400 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-accent-300">Серии · {s.files.length}<ChevronDownIcon className={cx("h-3 w-3 transition-transform motion-reduce:transition-none",open&&"rotate-180")}/></button>
  {open&&<div className="divide-y divide-gray-700/50">{s.files.map(f=>{const p=progress(f.index),file=prepared(f.index),queued=data.prebufferQueued.includes(`${s.hash}:${f.index}`),length=f.bytes||file?.bytes||p?.size;return <div key={f.index} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[7rem_minmax(4rem,1fr)_6rem_auto]"><span className="text-sm text-gray-200">{f.code.replace(/^S\d+E0*/,"Серия ")}</span><div className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1"><DownloadProgress download={file?.ready?1:p?.size?p.read/p.size:0} prepare={file?.ready?1:0} label={f.code}/></div><span className="col-start-2 row-start-2 text-right text-xs tabular-nums text-gray-400 sm:col-start-3 sm:row-start-1">{length?size(length):<span title="Размер неизвестен">—</span>}</span><div className="col-start-2 row-start-1 flex min-h-11 items-center justify-end sm:col-start-4">{file?.ready?<button aria-label={`Удалить ${f.code}`} title={file.inUse?"Серия используется":"Удалить серию"} disabled={busy||file.inUse} onClick={()=>void act(f.index,true)} className="grid h-11 w-11 place-items-center rounded-lg text-gray-400 hover:bg-gray-700 hover:text-rose-300 disabled:opacity-35"><TrashIcon className="h-4 w-4"/></button>:<button disabled={busy} onClick={()=>void act(f.index)} className="min-h-11 rounded px-2 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-100 disabled:opacity-35">{p&&!p.done||queued?"Отменить":"Подготовить"}</button>}</div></div>;})}</div>}</div>;
}

function Bar({ value, tone = "indigo" }: { value: number; tone?: "indigo" | "amber" | "green" }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
      <div className={cx("h-full rounded-full transition-all", tone === "amber" ? "bg-amber-500" : tone === "green" ? "bg-green-500" : "bg-indigo-500")}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

function Thumb({ src, id }: { src: string | null; id: number | null }) {
  const hover = useHoverCard(id ?? 0);
  const img = (
    <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-gray-700">
      {src && <Img src={src} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
    </div>
  );
  return id ? <Link href={`/anime/${id}`} {...hover} className="shrink-0 transition hover:brightness-110">{img}</Link> : img;
}

/** Название — ссылка на страницу тайтла (если тайтл опознан). */
function TitleLink({ id, className, title, children }: { id: number | null; className: string; title?: string; children: React.ReactNode }) {
  const hover = useHoverCard(id ?? 0);
  return id
    ? <Link href={`/anime/${id}`} {...hover} className={cx(className, "hover:text-indigo-300")} title={title}>{children}</Link>
    : <p className={className} title={title}>{children}</p>;
}

/** Счётчик у заголовка раздела; пока грузится — заглушка той же высоты. */
function Count({ n }: { n: number | undefined }) {
  return n === undefined
    ? <span className="inline-flex align-middle"><Skel className="h-4 w-5" /></span>
    : <span className="text-base font-normal text-gray-500">{n}</span>;
}

/** Строка раздачи/загрузки, пока список не пришёл: обложка, название, кнопки, подписи. */
function RowSkeleton() {
  return (
    <div aria-busy className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <Skel className="h-20 w-14 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-start gap-3"><Skel className="h-5 flex-1" /><Skel className="h-7 w-24 rounded-lg" /></div>
        <Skel className="h-3 w-64 max-w-full" />
        <Skel className="h-3 w-40" />
      </div>
    </div>
  );
}

export function DownloadsView() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["downloads"],
    queryFn: () => api<Downloads>("/api/downloads"),
    refetchInterval: 3000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const alert = useAlert();
  const [activeTitle,setActiveTitle]=useState<number|null>(null);
  const storage=useQuery({queryKey:["server-storage"],queryFn:()=>api<ServerStorage>("/api/downloads/storage"),refetchInterval:10000});
  const act = async (key: string, ask: { title: string; text: string; confirm: string }, path: string) => {
    if (!(await confirm({ ...ask, danger: true }))) return;
    setBusy(key);
    try {
      await api(path, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["downloads"] });
    } catch (e) {
      alert({ title: "Не получилось", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (error || (!isLoading && !data)) return <ErrorBox error={error} />;
  const problems = data?.queue.filter((q) => q.problem) ?? [];

  return (
    <div className="max-w-5xl space-y-8">
      {storage.error&&<ErrorBox error={storage.error}/>}
      {storage.isPending?<p className="text-sm text-gray-400">Проверяем диск медиасервера…</p>:storage.data&&<StoragePanel storage={storage.data.storage} online activeTitle={activeTitle} context={storage.data.context} titleOrder={data?.streams.map(s=>s.anilistId??0)}/>}

      <section className="space-y-3">
        {!data ? <RowSkeleton /> : data.streamsError && <ErrorBox error={`TorrServer недоступен: ${data.streamsError}`} />}
        {!data ? null : data.streams.length === 0 && !data.streamsError ? (
          <EmptyState title="Источники пока не добавлены">Нажмите «Смотреть» в окне «Озвучки» на странице тайтла.</EmptyState>
        ) : data.streams.map((s) => (
          <div key={s.hash} onMouseEnter={()=>setActiveTitle(s.anilistId)} onMouseLeave={()=>setActiveTitle(null)} className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
            <Thumb src={s.poster} id={s.anilistId} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 basis-full sm:basis-0 flex-1"><TitleLink id={s.anilistId} className="block truncate font-semibold" title={s.title}>{s.title}</TitleLink></div>
                <Button size="sm" variant="ghost" disabled={busy === s.hash}
                  onClick={() => act(s.hash, { title: `Убрать «${s.title}» из онлайн-просмотра?`, text: "Серии пропадут из библиотеки «Стрим» в Jellyfin.", confirm: "Убрать" }, `/api/downloads/streams/${s.hash}`)}>
                  <TrashIcon className="h-4 w-4" /> Убрать
                </Button>
              </div>
              <p className="flex flex-wrap gap-x-3 text-xs text-gray-400">
                <span className="text-gray-200">{s.state}</span>
                <span>{size(s.size)}</span>
                {s.cached > 0 && <span>в кэше {size(s.cached)}</span>}
                {speed(s.speed) && <span>{speed(s.speed)}</span>}
                <span>пиры {s.peers}{s.seeders ? ` (сиды ${s.seeders})` : ""}</span>
                {s.addedAt && <span>добавлена {relative(s.addedAt)}</span>}
              </p>
              <SpeedVerdict s={s} />
              <Episodes s={s} data={data} stored={storage.data} onChange={() => {void qc.invalidateQueries({queryKey:["downloads"]});void qc.invalidateQueries({queryKey:["server-storage"]});}} />
            </div>
          </div>
        ))}
      </section>

      <ServerDownloadStorage hideStorage excludeHashes={data?.streams.map(s=>s.hash)??[]} />
      {(!data||data.queue.length>0||data.queueError)&&<section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h2 className="text-xl font-bold">Скачивание <Count n={data?.queue.length} /></h2>

          </div>
        </div>
        {!data ? <RowSkeleton /> : data.queueError && <ErrorBox error={`Sonarr недоступен: ${data.queueError}`} />}
        {problems.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-500/30">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            С проблемой: {problems.length} из {data?.queue.length}. Причина показана у каждой загрузки.
          </div>
        )}
        {!data ? null : data.queue.length === 0 && !data.queueError ? (
          <EmptyState title="Ничего не качается">Нажмите «Скачать» в окне «Озвучки» или «Запросить» на странице тайтла.</EmptyState>
        ) : data.queue.map((q) => {
          const p = q.size ? q.done / q.size : 0;
          return (
            <div key={q.id} className={cx("flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1", q.problem ? "ring-amber-500/40" : "ring-gray-700")}>
              <Thumb src={q.poster} id={q.anilistId} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <TitleLink id={q.anilistId} className="block truncate font-semibold">{q.series ?? q.title}{q.episode && <span className="ml-2 text-sm font-normal text-gray-400">{q.episode}</span>}</TitleLink>
                    <p className="truncate text-xs text-gray-500" title={q.title}>{q.title}</p>
                  </div>
                  <Button size="sm" variant="ghost" disabled={busy === `q${q.id}`}
                    onClick={() => act(`q${q.id}`, { title: `Отменить загрузку «${q.title}»?`, text: "Скачанное будет удалено.", confirm: "Отменить загрузку" }, `/api/downloads/queue/${q.id}`)}>
                    <TrashIcon className="h-4 w-4" /> Отменить
                  </Button>
                </div>
                <Bar value={p} tone={q.problem ? "amber" : p >= 1 ? "green" : "indigo"} />
                <p className="flex flex-wrap gap-x-3 text-xs text-gray-400">
                  <span className="text-gray-200">{q.state}</span>
                  <span>{Math.round(p * 100)}% · {size(q.done)} из {size(q.size)}</span>
                  {q.timeleft && !q.problem && <span>осталось {q.timeleft}</span>}
                  {q.addedAt && <span>добавлена {relative(q.addedAt)}</span>}
                </p>
                {q.problem && <p className="text-xs text-amber-300">{q.problem}</p>}
              </div>
            </div>
          );
        })}
      </section>}
    </div>
  );
}
