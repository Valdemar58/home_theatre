"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ComputerDesktopIcon, ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { api, useAnime } from "@/lib/client";
import { StorageConnectDialog } from "./StorageConnectDialog";
import { useCurrentDesktop } from "./CurrentDesktopDevice";
import { useConfirm } from "./Dialogs";
import { StorageMoveDialog } from "./StorageMoveDialog";
import { Button, ErrorBox, cx } from "./ui";
import { DownloadInventory, StoragePanel, downloadTitleIds, type DownloadJob, type DownloadFile, type LibraryFile, type Storage, type DownloadContext } from "./DownloadInventory";

type Device = { id: string; label: string; online: boolean; revoked: number };
type File = DownloadFile;
type Job = DownloadJob;
type Data = { library:LibraryFile[]; storage:Storage|null; capabilities:string[]; context:Record<number,DownloadContext>; jobs: Job[]; updatedAt: number | null; rooms: {id:number;name:string}[]; grants:{list_id:number;anilist_id:number}[]; commands: { id: string; kind: string; state: string; result: { job?: string; error?: string } }[] };
type Release = { id: string; title: string; size: number; seeders: number; indexer: string };
const size = (v: number) => `${(v / 1024 ** 3).toFixed(1)} ГБ`;
const names: Record<string, string> = { selecting: "Выберите серии", downloading: "Скачивание", paused: "Приостановлено", preparing: "Подготовка", ready: "Готово", error: "Требуется внимание", cancelled: "Отменено", verifying: "Проверка файлов" };

export function DesktopDownloadLink({ id, name }: { id: number; name: string }) {
  return <Link href={`/downloads?title=${id}&name=${encodeURIComponent(name)}`} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-gray-800 px-3 text-sm text-gray-200 hover:bg-gray-700"><ComputerDesktopIcon className="h-4 w-4" />Скачать на устройство</Link>;
}

function SeriesSelection({ job, busy, start, episodeCount }: { job: Job; busy: boolean; episodeCount?:number; start: (selections: {index:number;episode:number}[]) => void }) {
  const videos = job.files.filter(f => f.video);
  const [selected, setSelected] = useState(() => videos.map(f => f.index));
  const [episodes, setEpisodes] = useState<Record<number, string>>(() => Object.fromEntries(videos.map(f => [f.index, f.episode ? String(f.episode) : videos.length===1&&episodeCount===1?"1":""])));
  const numbers = selected.map(i => Number(episodes[i]));
  const valid = numbers.length > 0 && numbers.every(n => Number.isSafeInteger(n) && n > 0) && new Set(numbers).size === numbers.length;
  return <div className="mt-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Выберите серии</h3><div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setSelected([])}>Сбросить</Button><Button size="sm" variant="ghost" onClick={() => setSelected(videos.map(f => f.index))}>Отметить все</Button></div></div>
    <div className="flex flex-wrap gap-2">{videos.map(f => <button key={f.index} aria-pressed={selected.includes(f.index)} title={f.name} onClick={() => setSelected(v => v.includes(f.index) ? v.filter(i => i !== f.index) : [...v, f.index])} className={cx("min-h-11 min-w-11 rounded-lg px-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-300", selected.includes(f.index) ? "tone-accent solid" : "bg-gray-700 text-gray-200 hover:bg-gray-600")}>{episodes[f.index] || "?"}</button>)}</div>
    <p className="text-sm text-gray-400">Выбрано {selected.length} · {size(videos.filter(f => selected.includes(f.index)).reduce((sum, f) => sum + f.bytes, 0))}</p>
    <details open={!valid && selected.length > 0}><summary className="cursor-pointer text-sm text-gray-300">Файлы и номера серий</summary><div className="mt-3 space-y-2">{videos.filter(f => selected.includes(f.index)).map(f => <label key={f.index} className="flex items-center gap-3 text-sm"><span className="min-w-0 flex-1 break-all text-gray-400">{f.name}</span><input aria-label={`Номер серии: ${f.name}`} className="w-20 rounded-lg bg-gray-900 px-3 py-2" type="number" min={1} max={10000} value={episodes[f.index]} onChange={e => setEpisodes(v => ({ ...v, [f.index]: e.target.value }))} /></label>)}</div></details>
    {!valid && selected.length > 0 && <p className="text-sm text-amber-300">Уточните номера серий: каждый выбранный файл должен иметь уникальный номер.</p>}
    <Button disabled={!valid || busy} variant="primary" onClick={() => start(selected.map(index => ({ index, episode: Number(episodes[index]) })))}><ArrowDownTrayIcon className="h-4 w-4" />Скачать и подготовить</Button>
  </div>;
}

export function DesktopDownloads({ title, titleName = "", episodeCount, watchEpisode, onReady, compact=false, onWatchStage }: { title?: number; titleName?: string; episodeCount?: number; compact?:boolean; onWatchStage?:(s:{phase:"source"|"download"|"prepare"|"watch";progress?:number})=>void; watchEpisode?:number; onReady?:(device:string)=>void }) {
  const anime = useAnime(title || 0);
  const knownEpisodes = episodeCount ?? anime.data?.episodes ?? 0;
  const devices = useQuery({ queryKey: ["desktop-devices"], queryFn: () => api<Device[]>("/api/desktop/devices"), refetchInterval: 5000 });
  const available = devices.data?.filter(d => !d.revoked) ?? [];
  const [chosen, choose] = useState("");
  const currentDevice=useCurrentDesktop();
  useEffect(()=>{if(currentDevice.data?.active&&currentDevice.data.id)choose(currentDevice.data.id);else if(currentDevice.data&&!new URLSearchParams(location.search).has('device'))choose('local-unlinked');},[currentDevice.data?.id,currentDevice.data?.active]);
  const [volume,setVolume]=useState("");
  const [selectedTitles,setSelectedTitles]=useState<Set<number>>(new Set());
  const [moveOpen,setMoveOpen]=useState(false);
  const [connectOpen,setConnectOpen]=useState(false);
  const confirm=useConfirm();
  useEffect(() => { const remembered = new URLSearchParams(window.location.search).get("device") || sessionStorage.getItem("home-theater-device"); if (remembered) choose(remembered); }, []);
  const device = available.find(d => d.id === chosen) ?? (currentDevice.desktop ? currentDevice.data?.active ? available.find(d=>d.id===currentDevice.data.id) : undefined : available[0]);
  const data = useQuery({ queryKey: ["desktop-downloads", device?.id], enabled: !!device, queryFn: () => api<Data>(`/api/desktop/downloads?device=${device!.id}`), refetchInterval: 2500 });
  const storage=data.data?.storage;
  const selectedVolume=storage?.volumes.find(v=>v.id===volume)??storage?.volumes.find(v=>v.default)??storage?.volumes[0];
  const hasVolumes=data.data?.capabilities?.includes("storage-volumes-v1")??false;
  useEffect(()=>{setSelectedTitles(new Set());setVolume("");setMoveOpen(false);setConnectOpen(false);},[device?.id]);
  const watchFile=data.data?.jobs.filter(j=>j.title===title).flatMap(j=>j.files).find(f=>f.selected&&f.episode===watchEpisode);
  const phase=watchFile?watchFile.prepareState==="ready"?"watch":watchFile.downloaded>=watchFile.bytes?"prepare":"download":"source";
  const stageProgress=watchFile?phase==="download"?watchFile.downloaded/Math.max(1,watchFile.bytes):watchFile.prepareProgress:undefined;
  useEffect(()=>{onWatchStage?.({phase:device?.online?phase:"source",progress:stageProgress});},[phase,stageProgress,onWatchStage,watchEpisode,title,device?.online]);
  const [query, setQuery] = useState(titleName), [releases, setReleases] = useState<Release[]>([]), [warning, setWarning] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [offlineEpisodes, setOfflineEpisodes] = useState<number[]>([watchEpisode || 1]);
  const [watchRequested, setWatchRequested] = useState(false);
  useEffect(()=>{setOfflineEpisodes([watchEpisode||1]);setWatchRequested(false);},[watchEpisode,title]);
  useEffect(() => {
    if (watchRequested && device?.online && data.data?.jobs.some(j => j.title === title && j.files.some(f => f.selected && f.episode === watchEpisode && f.prepareState === "ready"))) {
      setWatchRequested(false); onReady?.(device.id);
    }
  }, [watchRequested, device, data.data, title, watchEpisode, onReady]);
  useEffect(() => { setQuery(titleName); setReleases([]); }, [titleName, device?.id]);
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    if (!device || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ releases?: Release[]; warning?: string; id?: string }>("/api/desktop/downloads", { method: "POST", json: { action, device: device.id,...(["start","inspect"].includes(action)&&selectedVolume?.targetId?{target:selectedVolume.targetId}:{}), ...body } });
      if (watchEpisode && (action === "start" || (action === "inspect" && !device.online))) setWatchRequested(true);
      if (action === "search") { setReleases(result.releases || []); setWarning(result.warning || (result.releases?.length ? "" : "Раздачи не найдены. Попробуйте другое название.")); }
      else { setMessage(action === "grant" ? "Доступ комнаты обновлён." : device.online ? "Задание передано устройству. Прогресс появится ниже." : "Задание сохранено. Оно начнётся, когда приложение на компьютере подключится."); await data.refetch(); }
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const [activeTitle,setActiveTitle]=useState<number|null>(null);
  const allJobs=data.data?.jobs??[];
  const jobs=allJobs.filter(j=>(!title||j.title===title)&&(!selectedVolume?.targetId||!j.storageId||j.storageId===selectedVolume.targetId));
  const library=(data.data?.library??[]).filter(f=>!selectedVolume||jobs.some(j=>j.title===f.title)||selectedVolume.titles.some(t=>t.id===f.title));
  const canMove=(id:number)=>{
    const batch=allJobs.filter(j=>j.title===id&&j.files.some(f=>f.selected)),count=data.data?.context[id]?.episodes;
    const files=batch.flatMap(j=>j.files.filter(f=>f.selected));
    return !!count&&batch.length>0&&batch.every(j=>!!j.storageId&&!["selecting","downloading","verifying","preparing"].includes(j.state))&&Array.from({length:count},(_,i)=>i+1).every(n=>files.some(f=>f.episode===n&&f.downloaded>=f.bytes&&!!f.libraryId))&&files.every(f=>f.downloaded>=f.bytes&&!!f.libraryId&&!f.inUse&&!["preparing","moving","error"].includes(f.prepareState||""));
  };
  const selectedIds=[...selectedTitles].filter(canMove);
  const moveBytes=(storage?.volumes??[]).flatMap(v=>v.titles).filter(t=>selectedIds.includes(t.id)).reduce((n,t)=>n+t.bytes,0);
  const moving=storage?.move;

  const pending = data.data?.commands.filter(c => c.state === "queued") ?? [];
  return <section className="space-y-5" aria-label="Загрузки на устройства">
    <div className="flex flex-wrap items-start justify-between gap-4"><div hidden={compact}>{title&&<h2 className="text-xl font-semibold">{titleName}</h2>}</div>{(device||currentDevice.desktop||available.length>0) && <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm"><span className="text-gray-400">Устройство</span><select className="max-w-full rounded-lg bg-gray-800 px-3 py-2 ring-1 ring-gray-600" value={device?.id||"local-unlinked"} onChange={e => { choose(e.target.value); setWatchRequested(false); sessionStorage.setItem("home-theater-device", e.target.value); }}>{currentDevice.desktop&&!currentDevice.data?.active&&<option value="local-unlinked">Этот компьютер · не привязано</option>}{available.map(d => <option key={d.id} value={d.id}>{d.label}{d.id===currentDevice.data?.id?" · этот компьютер":""} · {d.online ? "подключён" : "не в сети"}</option>)}</select></label>}</div>
    {devices.isPending && <p role="status" className="text-sm text-gray-400">Загружаем устройства…</p>}
    {(devices.error || data.error || error) && <ErrorBox error={error || devices.error || data.error} />}
    {!devices.isPending && !device && <div className="rounded-xl bg-gray-800/50 p-5"><h3 className="font-medium">Подключите домашний компьютер</h3><p className="mt-2 text-sm text-gray-400">{currentDevice.desktop?"Подключите этот компьютер к аккаунту кнопкой «Подключить» над страницей. Для другого компьютера выберите его в списке устройств.":"Откройте desktop-приложение и привяжите его к своему аккаунту. После этого устройство появится здесь."}</p><Link href="/devices" className="mt-3 inline-block text-sm text-indigo-300">Настройки аккаунта и устройств</Link></div>}
    {device && <>
      {!device.online && <p className="rounded-lg bg-gray-800/50 p-3 text-sm text-gray-300">Компьютер не в сети. Можно оставить задание; для загрузки приложение должно быть запущено.</p>}
      {!compact&&<StoragePanel activeTitle={activeTitle} titleOrder={downloadTitleIds(jobs,data.data?.library??[])} context={data.data?.context} storage={storage} online={device.online} selectedVolume={selectedVolume?.id} onVolumeChange={id=>{setVolume(id);setSelectedTitles(new Set());}} canAdd={hasVolumes&&device.online&&!busy} onAdd={()=>data.data?.capabilities.includes("storage-discovery-v1")?setConnectOpen(true):void call("storage-add")}/>}
      {!compact&&selectedVolume?.folderName&&<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400"><span>Папка медиатеки: {selectedVolume.folderName}</span><button disabled={busy||!device.online||!selectedVolume.canDisconnect} title={selectedVolume.canDisconnect?"Файлы не удаляются; пустую медиатеку можно подключить заново с другой папкой":"Папка закреплена, пока медиатека непустая"} onClick={async()=>{if(await confirm({title:"Отключить пустую медиатеку?",text:"Файлы не удаляются. После отключения можно выбрать другую папку на этом томе.",confirm:"Отключить"}))await call("storage-disconnect",{target:selectedVolume.targetId});}} className="min-h-9 rounded px-2 hover:bg-gray-800 hover:text-gray-100 disabled:opacity-35">Отключить</button></div>}
      {!compact&&hasVolumes&&selectedVolume?.targetId&&!selectedVolume.default&&<button disabled={busy||!device.online||selectedVolume.online===false} onClick={()=>void call("storage-default",{target:selectedVolume.targetId})} className="min-h-9 rounded text-xs text-gray-400 hover:text-gray-100 disabled:opacity-35">Сохранять новые загрузки на этот диск</button>}
      {!compact&&!!data.data&&!hasVolumes&&<p className="text-xs text-gray-400">Для подключения дисков и переноса сезонов обновите desktop до 0.5.0-rc.8.</p>}
      {storage?.recoveryError&&<div role="alert" className="space-y-2 text-sm text-amber-300"><p>{storage.recoveryError}</p><Button size="sm" disabled={busy||!device.online} onClick={()=>void call("storage-recover")}>Повторить восстановление</Button></div>}
      {moving&&<div role="status" className="space-y-2 rounded-xl bg-gray-800/50 p-4"><p className="text-sm">Перенос на другой диск · {Math.round(moving.copied/Math.max(1,moving.total)*100)}%</p><progress value={moving.copied} max={Math.max(1,moving.total)} className="h-1.5 w-full accent-accent-400"/><p className="text-xs text-gray-400">{Math.round(moving.copied/1024**2)} из {Math.round(moving.total/1024**2)} МБ · копируем и проверяем файлы</p></div>}
      {title && <div className="space-y-3"><form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void call("search", { query }); }}><input aria-label="Название раздачи" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 rounded-lg bg-gray-800 px-3 py-2 ring-1 ring-gray-600" placeholder="Название раздачи" /><Button type="submit" disabled={busy || query.trim().length < 2}>{busy ? "Подождите…" : "Найти раздачи"}</Button></form>
        {!device.online && <div><h3 className="text-sm font-medium">Какие серии скачать после подключения</h3>{!knownEpisodes && <p className="mt-2 text-sm text-gray-400">Количество серий пока неизвестно. Сначала подключите устройство, чтобы выбрать файлы раздачи.</p>}<div className="mt-2 flex flex-wrap gap-2">{Array.from({ length: Math.min(knownEpisodes, 500) }, (_, i) => i + 1).map(n => <button key={n} aria-pressed={offlineEpisodes.includes(n)} onClick={() => setOfflineEpisodes(v => v.includes(n) ? v.filter(e => e !== n) : [...v, n])} className={cx("min-h-11 min-w-11 rounded-lg px-2 text-sm", offlineEpisodes.includes(n) ? "tone-accent solid" : "bg-gray-800 hover:bg-gray-700")}>{n}</button>)}</div><p className="mt-2 text-xs text-gray-400">Номера будут сверены с файлами раздачи. Если соответствие неоднозначно, потребуется ваше уточнение.</p></div>}
        {warning && <p className="text-sm text-amber-300">{warning}</p>}
        <div className="divide-y divide-gray-700/60">{releases.map(r => <div key={r.id} className="flex flex-wrap items-center gap-3 py-4"><div className="min-w-0 flex-1 basis-64"><h3 className="break-words text-sm font-medium">{r.title}</h3><p className="mt-1 text-xs text-gray-400">{size(r.size)} · раздают {r.seeders} · {r.indexer}</p></div><Button size="sm" disabled={busy || (!device.online && (!knownEpisodes || !offlineEpisodes.length))} onClick={() => void call("inspect", { release: r.id, title, titleName, ...(!device.online ? { episodes: offlineEpisodes } : {}) })}>{device.online ? "Выбрать серии" : "Поставить в очередь"}</Button></div>)}</div>
      </div>}
      {compact&&watchFile?.prepareState==="ready"&&<Button variant="primary" disabled={!device.online} onClick={()=>onReady?.(device.id)}>Смотреть серию {watchEpisode}</Button>}
      {compact&&jobs.filter(j=>["paused","error"].includes(j.state)&&j.files.some(f=>f.selected&&f.episode===watchEpisode)).map(j=><div key={j.id} className="space-y-2"><p className="text-sm text-gray-400">{j.error||"Загрузка приостановлена"}</p><Button size="sm" disabled={busy} onClick={()=>{setWatchRequested(true);void call("resume",{job:j.id});}}>Продолжить загрузку</Button></div>)}
      {compact&&watchFile?.error&&<ErrorBox error={watchFile.error}/>}
      {message && <p role="status" className="text-sm text-indigo-300">{message}</p>}
      {!!pending.length && <p role="status" className="text-sm text-gray-400">{device.online ? "Устройство обрабатывает задания" : "Ожидают подключения"}: {pending.length}</p>}
      {data.data?.commands.filter(c => c.state === "error").slice(0, 3).map(c => <ErrorBox key={c.id} error={c.result.error || "Действие не выполнено"} />)}
      {!title && !jobs.length && !library.length && !pending.length && <p className="text-sm text-gray-400">На этом диске пока нет загрузок. Откройте тайтл и выберите «Скачать на устройство».</p>}
      <div hidden={compact&& !jobs.some(j=>j.state==="selecting")}>
      <DownloadInventory onActiveTitle={setActiveTitle} storage={data.data?.storage} jobs={jobs} library={library} selectedTitles={selectedTitles} onSelectTitle={!compact&&hasVolumes?id=>setSelectedTitles(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;}):undefined} canMoveTitle={canMove} context={data.data?.context??{}} device={device} canDelete={data.data?.capabilities?.includes("episode-delete-v1")??false} busy={busy||pending.some(c=>["remove-episode","prepare-episode","move-titles"].includes(c.kind))} focusTitle={title}
        remove={async body=>{await call("remove-episode",body);}} prepareEpisode={async body=>{await call("prepare-episode",body);}} canPrepare={data.data?.capabilities.includes("episode-prepare-v1")}
        renderJob={j=><><div className="flex flex-wrap items-center justify-between gap-3"><p className="min-w-0 flex-1 break-words text-xs text-gray-400">{j.releaseName}{device.online&&j.speed>0?` · ${(j.speed/1e6).toFixed(1)} МБ/с`:""}{j.state==="paused"?" · приостановлено":""}</p><div className="flex flex-wrap gap-2">{["downloading","verifying"].includes(j.state)&&<Button size="sm" disabled={busy} onClick={()=>void call("pause",{job:j.id})}>Пауза</Button>}{["paused","error"].includes(j.state)&&<Button size="sm" disabled={busy} onClick={()=>void call("resume",{job:j.id})}>Продолжить</Button>}{["selecting","downloading","verifying","paused","error"].includes(j.state)&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void call("cancel",{job:j.id})}>Отменить загрузку</Button>}</div></div>{j.error&&<ErrorBox error={j.error}/ >}{j.state==="selecting"&&<SeriesSelection job={j} busy={busy} episodeCount={knownEpisodes||data.data?.context[j.title]?.episodes||undefined} start={selections=>void call("start",{job:j.id,selections})}/>}</>}
        renderAccess={id=>!!data.data?.rooms?.length&&<details><summary className="cursor-pointer py-2 text-sm text-gray-300">Доступ для совместного просмотра</summary><div className="mt-2 space-y-2">{data.data.rooms.map(room=><label key={room.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={data.data!.grants.some(g=>g.list_id===room.id&&g.anilist_id===id)} onChange={e=>void call("grant",{title:id,room:room.id,enabled:e.target.checked})}/>{room.name}<Link href={`/groups/${room.id}`} className="ml-auto text-accent-300">В комнату</Link></label>)}</div></details>}/>
      </div>
      {!!selectedIds.length&&!compact&&<div className="sticky bottom-20 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gray-800 p-3 shadow-lg sm:bottom-4"><span className="text-sm">Выбрано сезонов: {selectedIds.length}</span><div className="flex gap-2"><Button size="sm" variant="ghost" onClick={()=>setSelectedTitles(new Set())}>Сбросить</Button><Button size="sm" disabled={busy||!device.online||!!moving||pending.some(c=>c.kind==="move-titles")} onClick={()=>setMoveOpen(true)}>Переместить</Button></div></div>}
      {connectOpen&&<StorageConnectDialog volumes={storage?.available??[]} error={storage?.scanError} busy={busy} onClose={()=>setConnectOpen(false)} onRefresh={()=>void call("storage-scan")} onChoose={v=>{if(v.registered){const known=storage?.volumes.find(d=>d.targetId===v.registered);if(known)setVolume(known.id);setConnectOpen(false);}else{setConnectOpen(false);void call("storage-add",{volume:v.id});}}}/>}
      {moveOpen&&<StorageMoveDialog volumes={(storage?.volumes??[]).filter(v=>v.targetId&&v.targetId!==selectedVolume?.targetId)} titles={selectedIds.map(id=>data.data?.context[id]?.name||`Тайтл ${id}`)} needed={moveBytes} busy={busy} onClose={()=>setMoveOpen(false)} onMove={async target=>{if(await call("move-titles",{target,titles:selectedIds})){setMoveOpen(false);setSelectedTitles(new Set());}}}/>}
    </>}
  </section>;
}



