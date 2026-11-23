"use client";
import { DesktopDownloads } from "../DesktopDownloads";
import { CheckIcon, EyeIcon, EyeSlashIcon, ChevronLeftIcon, ChevronRightIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useAnime, useEpisodeStatus, useList, usePlot } from "@/lib/client";
import { FORMAT_LABELS, label, STATUS_LABELS } from "@/lib/labels";
import { playable, waitText, type EpisodeStatus } from "@/lib/playback";
import type { PlayInfo } from "@/lib/player";
import { positionAt, type RoomView } from "@/lib/room";
import { displayTitle } from "@/lib/schedule";
import { useAlert } from "../Dialogs";
import { EpisodePanels, WatchStep, WatchTabs, type WatchPhase } from "./WatchExperience";
import { VoicesButton } from "../VoicesButton";
import { EpisodeAlerts } from "../EpisodeAlerts";

import { Img } from "../Img";
import { ListControl } from "../ListControl";


import { Scores } from "../Scores";
import { Badge, Button, ErrorBox, cx } from "../ui";
import { usePrepare } from "../WatchButton";
import { clock, Player, type PlayerControls, type RoomSync, type SignsState, type SubSettings } from "./Player";
import { actionText, RoomPanel } from "./RoomPanel";
import { useRoom } from "./useRoom";
import { WatchSidebar } from "./WatchSidebar";
import { episodeAvailability } from "@/lib/session-plan";
import { nextSessionItem } from "@/lib/session-playback";
import { SessionTransition } from "./SessionTransition";
import type { WatchHistoryData } from "../WatchHistorySettings";
import { DesktopSource, type DesktopSources } from "./DesktopSource";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import type { DesktopDiagnostics } from "@/lib/desktop-transport";

// Страница просмотра серии (по мотивам AniLib): шапка тайтла, плеер и боковая панель «Озвучка / Субтитры», лента
// серий (кадр, готовность, кэш TorrServer, «Подготовить», прогресс), под плеером — серия, сюжет, друзья, обсуждение.

// Общий с «Показать все описания» на странице тайтла (Plot.tsx)
const SPOILERS_KEY = "episodes-show-all";

export function WatchView({ id: initialId, ep: initialEp }: { id: number; ep: number }) {
  const [connectionMedia, setConnectionMedia] = useState<DesktopDiagnostics | null>(null);
  const [id, setId] = useState(initialId);
  useEffect(() => setId(initialId), [initialId]);
  const router = useRouter();
  const params = useSearchParams();
  // Серия меняется на месте (адрес — history API, без новой страницы): обёртка плеера живёт дальше и остаётся
  // во весь экран при переходе на следующую серию. Назад/вперёд в браузере — Next отдаёт новый номер
  const [ep, setEp] = useState(initialEp);
  // «Сразу смотреть» — своим состоянием: новый плеер создаётся раньше, чем useSearchParams увидит ?play=1
  const [autoPlay, setAutoPlay] = useState(params.get("play") === "1");
  useEffect(() => setEp(initialEp), [initialEp]);
  const stage = useRef<HTMLDivElement>(null);
  const showEp = useCallback((n: number, query: URLSearchParams, replace = false) => {
    setEp(n);
    setAutoPlay(query.get("play") === "1");
    const url = `/anime/${id}/watch/${n}${query.size ? `?${query}` : ""}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, [id]);
  const qc = useQueryClient();
  const { data: a } = useAnime(id);
  const { data: plot } = usePlot(id);
  const { data: st } = useEpisodeStatus(id);
  const { byId } = useList();
  const entry = byId.get(id);
  const historyKey = ["watch-history",id];
  const {data:history}=useQuery({queryKey:historyKey,queryFn:()=>api<WatchHistoryData>(`/api/watch-history?title=${id}`)});
  const currentCycle=history?.cycles.find(c=>c.started_at!==null || c.baseline>0);
  const seenEpisode=(n:number)=>currentCycle ? n<=currentCycle.baseline||currentCycle.episodes.includes(n) : n<=(entry?.episodes??0);
  const watched = entry?.status === "completed" ? (a?.episodes ?? entry.episodes) : entry?.episodes ?? 0;
  const info = plot?.episodes.find((e) => e.number === ep);
  const name = a ? displayTitle(a.title) : "";
  // Комната совместного просмотра: из ссылки-приглашения (?room=) или та, где уже вошли
  const alert = useAlert();
  const urlRoom = params.get("room");
  const { data: rooms, refetch: refetchRooms } = useQuery({
    queryKey: ["rooms", id],
    queryFn: () => api<{ room: RoomView | null; friends: { id: number; name: string }[]; groups: { id: number; name: string; members: { id: number; name: string }[] }[] }>(`/api/rooms?anilistId=${id}`),
  });
  const mineJoined = rooms?.room?.members.find((m) => m.id === rooms.room!.me)?.status === "joined";
  const rid = urlRoom ?? (!params.get("device") && mineJoined ? rooms!.room!.id : null);
  const rm = useRoom(rid);
  const meInRoom = rm.room?.members.find((m) => m.id === rm.room!.me);
  const inRoom = Boolean(rm.room && !rm.ended && meInRoom?.status === "joined");
  const desktopSources = useQuery({ queryKey: ["desktop-source", rid, id, ep], enabled: inRoom && Boolean(rm.room?.groupId), queryFn: () => api<DesktopSources>(`/api/desktop/stream?room=${rid}`), refetchInterval: 2000 });
  const desktopDevice = desktopSources.data?.selected;
  useEffect(() => setConnectionMedia(null), [rid, id, ep, desktopDevice]);
  const preferredFiles = desktopSources.data?.hosts.find(h => h.id === desktopDevice)?.files ?? [];
  const desktopEpisodes = new Set(preferredFiles.filter(f => desktopSources.data?.hosts.some(h => h.online && h.files.some(copy => copy.ep === f.ep && copy.preparedVersion === f.preparedVersion && copy.preparedBytes === f.preparedBytes))).map(f => f.ep));
  const personalDevice = !inRoom ? params.get("device") : null;
  const personalDownloads = useQuery({ queryKey: ["desktop-downloads", personalDevice], enabled: !!personalDevice, queryFn: () => api<{library?:{title:number;ep:number;state:string}[];jobs:{title:number;files:{episode:number;selected?:boolean;prepareState?:string;prepareProgress?:number;bytes?:number;downloaded?:number}[]}[]}>(`/api/desktop/downloads?device=${personalDevice}`), refetchInterval: 2500 });
  const personalEpisodes = new Set([...(personalDownloads.data?.jobs.filter(j => j.title === id).flatMap(j => j.files.filter(f => f.selected!==false && f.prepareState === "ready").map(f => f.episode)) ?? []),...(personalDownloads.data?.library?.filter(f=>f.title===id&&f.state==="ready").map(f=>f.ep)??[])]);
  const eps = (st?.episodes?.length?st.episodes:Array.from({length:Math.min(a?.episodes??a?.nextAiringEpisode?.episode??0,2000)},(_,i):EpisodeStatus=>({ep:i+1,state:"aired"}))).map(s => personalDevice ? (s.state !== "upcoming" && personalEpisodes.has(s.ep) ? { ...s, state: "library" as const, desktop: true } : { ...s, state: s.state === "upcoming" ? "upcoming" as const : "aired" as const }) : desktopDevice ? s.state !== "upcoming" && desktopEpisodes.has(s.ep) ? { ...s, state: "library" as const, desktop: true } : { ...s, state: s.state === "upcoming" ? "upcoming" as const : "aired" as const } : {...s});
  if(personalDevice)for(const status of eps){
    const file=personalDownloads.data?.jobs.filter(j=>j.title===id).flatMap(j=>j.files).find(f=>f.episode===status.ep&&f.selected!==false);
    if(file&&status.state!=="upcoming"&&status.state!=="library") {status.state="downloading";status.preparing=file.prepareState==="preparing";status.pct=status.preparing?file.prepareProgress??0:Math.min(1,(file.downloaded??0)/Math.max(1,file.bytes??1));}
  }
  for(const status of eps) if(a&&!episodeAvailability(a,status.ep,Date.now()/1000).selectable)status.state="upcoming";
  const nextEp = eps.find(s => s.ep > ep && playable(s));
  const sourcePending = Boolean(rid && (!rm.room || (inRoom && rm.room.groupId && desktopSources.isPending)));
  // Пришли по приглашению — войти
  const joining = useRef(false);
  useEffect(() => {
    if (!urlRoom || !rm.room || rm.ended || meInRoom?.status === "joined" || joining.current) return;
    joining.current = true;
    void rm.act({ action: "join" }).catch((e: unknown) => alert({ title: "Не удалось войти в комнату", text: String((e as Error).message ?? e) }))
      .finally(() => { joining.current = false; });
  }, [urlRoom, rm, meInRoom?.status, alert]);
  // Автопереход (конец серии, «следующая») — сразу смотреть; выбор серии в ленте — превью. В комнате — с ней
  const go = useCallback((n: number, play = false) => {
    const q = new URLSearchParams(); if (!inRoom && params.get("device")) q.set("device", params.get("device")!);
    if (play) q.set("play", "1");
    if (rid && inRoom) q.set("room", rid);
    showEp(n, q);
  }, [showEp, rid, inRoom]);
  // Комната перешла на другую серию — за ней
  const roomEp = inRoom ? rm.room!.state.ep : null;
  const roomTitle = inRoom ? rm.room!.anilistId : null;
  useEffect(() => {
    if (!roomEp || !roomTitle || (roomEp === ep && roomTitle === id)) return;
    setId(roomTitle); setEp(roomEp); setAutoPlay(true);
    window.history.replaceState(null, "", `/anime/${roomTitle}/watch/${roomEp}?room=${rid}&play=1`);
  }, [roomEp, roomTitle, ep, id, rid]);
  const session = inRoom ? rm.room?.state.session : undefined;
  const plannedNext = session ? nextSessionItem(session) : null;
  const { data: nextAnime } = useAnime(plannedNext?.anilistId ?? id);
  const nextTitle = nextAnime ? displayTitle(nextAnime.title) : "Следующий тайтл";
  const sync: RoomSync | null = useMemo(() => (inRoom && rm.room ? {
    id: rm.room.id,
    policy: rm.room.syncPolicy,
    state: rm.connected ? rm.room.state : { ...rm.room.state, playing: false }, canControl: rm.canControl, serverNow: rm.serverNow,
    report: r => rm.report({ ...r, anilistId: id, ep, revision: rm.room?.state.session?.revision ?? rm.room?.state.generation }),
    command: (action, pos) => rm.act({ action, pos, expectedGeneration: rm.room?.state.generation??0, expectedTitle:id, expectedEp:ep }),
  } : null), [inRoom, rm, id, ep]);
  // Серию в комнате меняет тот, у кого пульт
  const pickEp = (n: number, play = false) => {
    if(eps.find(s=>s.ep===n)?.state==="upcoming")return;
    if (!inRoom) return go(n, play);
    if (!rm.canControl) return alert({ title: "Серию меняет организатор", text: "В этой комнате пульт только у организатора и тех, кому он его дал." });
    void rm.act({ action: "ep", ep: n, expectedGeneration:rm.room?.state.generation??0, expectedTitle:id, expectedEp:ep }).catch(e => alert({ title: "Не удалось сменить серию", text: String(e.message) }));
  };
  // Чужое действие в комнате — подсказка поверх видео на 4 с
  const last = rm.room?.actions.at(-1);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!inRoom || !last || last.userId === rm.room?.me || Date.now() - last.at > 4000 || ["join", "resume"].includes(last.kind)) return;
    setToast(actionText(last, rm.room?.members.find((m) => m.id === last.userId)?.name ?? "?"));
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.at, inRoom]);
  const waiting = inRoom ? rm.room!.state.hold.map((u) => rm.room!.members.find((m) => m.id === u)?.name).filter(Boolean) : [];
  const onReport = useCallback((r: { marked: boolean }) => {
    void qc.invalidateQueries({ queryKey: ["list"] });
    void qc.invalidateQueries({ queryKey: ["watch-history"] });
  }, [qc]);
  const controls = useRef<PlayerControls | null>(null);
  const [player, setPlayer] = useState<{ info: PlayInfo | null; sub: number | null; subs: SubSettings; signs: number | null; signsState: SignsState; preparing?:boolean; started?:boolean }>(
    { info: null, sub: null, subs: { delay: 0, size: 100 }, signs: null, signsState: null });
  const spoiler = !seenEpisode(ep);
  const [sideTab,setSideTab]=useState("releases");
  const [downloadStage,setDownloadStage]=useState<{phase:WatchPhase;progress?:number}|null>(null);
  const currentStatus=eps.find(s=>s.ep===ep);
  const unavailable=currentStatus?.state==="upcoming";
  const canPlay=Boolean(!unavailable&&(personalDevice?personalEpisodes.has(ep):desktopDevice||currentStatus&&playable(currentStatus)));
  const phase:WatchPhase=canPlay ? player.preparing?"prepare":"watch" : (downloadStage?.phase!=="source"&&downloadStage?.phase!=="watch"?downloadStage?.phase:null)??(currentStatus?.state==="downloading"?"download":currentStatus?.preparing?"prepare":"source");
  useEffect(()=>{setDownloadStage(null);setPlayer(p=>({...p,info:null,preparing:true}));},[id,ep]);

  return (
    <div className="space-y-4">
      {/* Шапка тайтла */}
      {a && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
          <Link href={`/anime/${id}`} className="shrink-0">
            {a.coverImage.large && <Img src={a.coverImage.large} size="thumb" className="h-16 w-12 rounded-md object-cover" />}
          </Link>
          <div className="min-w-0 flex-1">
            <Link href={`/anime/${id}`} className="block truncate text-lg font-bold hover:text-accent-200">{name}</Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
              <span>{label(FORMAT_LABELS, a.format)}</span>
              <Badge tone={a.status === "RELEASING" ? "positive" : "neutral"}>{label(STATUS_LABELS, a.status)}</Badge>
              {a.episodes && <span>{a.episodes} серий</span>}
              <Scores media={a} size="sm" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ListControl media={a} />
            <EpisodeAlerts id={a.id} airing={a.status === "RELEASING" || a.status === "NOT_YET_RELEASED"} />
          </div>
        </div>
      )}

      <WatchStep key={`step:${id}:${ep}`} phase={phase} progress={downloadStage?.progress??currentStatus?.pct}/>
      {/* Плеер и боковая панель */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
        <div ref={stage} className="relative min-w-0 self-start bg-black">
        {inRoom && rm.room?.groupId && desktopSources.isError && !desktopSources.data ? <div className="grid aspect-video place-content-center gap-3 p-6"><ErrorBox error={desktopSources.error} /><Button onClick={() => void desktopSources.refetch()}>Повторить подключение к комнате</Button></div> : sourcePending ? <div className="grid aspect-video place-items-center text-sm text-gray-400" role="status">Подключаемся к источнику комнаты…</div> : !canPlay ? <div className="grid aspect-video place-content-center gap-4 rounded-xl bg-gray-950 px-6 text-center"><p className="text-lg font-medium">{unavailable?"Серия ещё не вышла":phase==="download"?"Скачиваем серию":phase==="prepare"?"Подготавливаем серию":"Выберите источник для этой серии"}</p><p className="max-w-sm text-sm text-gray-400">{unavailable?(a?.schedule.find(s=>s.episode===ep)?.airingAt?new Date(a.schedule.find(s=>s.episode===ep)!.airingAt*1000).toLocaleString("ru-RU"):"Дата выхода пока не объявлена") : "Подготовка и загрузка доступны здесь, в разделе «Раздачи»."}</p>{!unavailable&&<Button onClick={()=>{setSideTab("releases");document.getElementById("watch-tools-releases")?.focus();}}>Выбрать источник</Button>}</div> : <Player key={`${id}:${ep}:${desktopDevice || params.get("device") || "server"}`} anilistId={id} ep={ep} desktopRoom={inRoom ? (desktopDevice ? rid! : undefined) : params.get("device") ? `device:${params.get("device")}` : undefined} source={params.get("source") ?? undefined} autoPlay={autoPlay || Boolean(desktopDevice)} fullscreenRoot={stage}
          title={`${name} · ${ep} серия${!spoiler && info?.title ? ` · ${info.title}` : ""}`}
          preview={{ still: spoiler?null:info?.still ?? null, heading: `${ep} серия${!spoiler && info?.title ? ` · ${info.title}` : ""}`, text: spoiler ? null : info?.overview ?? null }}
          next={session ? (plannedNext && rm.canControl ? { label: `${plannedNext.anilistId !== id ? nextTitle + " · " : ""}${plannedNext.ep} серия`, go: () => { void rm.act({ action: "session-next", revision: session.revision }).catch(e => alert({ title: "Не удалось перейти", text: String(e.message) })); } } : null) : nextEp && (!inRoom || rm.canControl) ? { label: `${nextEp.ep} серия`, go: () => pickEp(nextEp.ep, true) } : null}
          onEnded={session ? duration => { void rm.act({ action: "session-ended", revision: session.revision, anilistId: id, ep, duration }).catch(e => alert({ title: "Не удалось завершить серию", text: String(e.message) })); } : undefined}
          onReport={onReport}
          onState={setPlayer} onConnection={setConnectionMedia} controls={controls} room={sync}>
          {() => (toast || waiting.length > 0 || (inRoom && !rm.connected)) && (
            <div className="mx-auto w-fit max-w-full rounded-lg bg-black/80 px-3 py-1.5 text-sm text-white ring-1 ring-white/10">
              {!rm.connected ? "Связь с комнатой потеряна. Восстанавливаем подключение…" : waiting.length ? `Ждём: ${waiting.join(", ")}` : toast}
              {waiting.length > 0 && rm.canControl && (!session || session.phase === "watching") && <Button size="sm" className="ml-2" onClick={() => { void rm.act({ action: "play", pos: positionAt(rm.room!.state, rm.serverNow()) }).catch(e => setToast(String(e.message))); }}>Продолжить без ожидающих</Button>}
            </div>
          )}
        </Player>}
        {session && <SessionTransition handle={rm} nextTitle={nextTitle} />}
        </div>
        {rid && <ConnectionDiagnostics room={rm.connection} media={connectionMedia} sourceError={desktopSources.isError && !desktopSources.data} />}
      {eps.length > 0 && (
        <EpisodeStrip id={id} current={ep} statuses={eps} watched={currentCycle?.baseline??watched} seenEpisodes={currentCycle?.episodes ?? []} positions={st?.positions ?? []}
          schedule={[...(a?.schedule??[]),...(a?.nextAiringEpisode?[a.nextAiringEpisode]:[])]} titles={new Map(plot?.episodes.map((e) => [e.number, e]) ?? [])} onPick={(n) => pickEp(n)} />
      )}
        </div>
        <aside className="min-w-0 self-start space-y-4">
          <WatchTabs id="watch-tools" value={sideTab} onChange={setSideTab} items={[["releases","Раздачи"],["sub","Субтитры"],["online","Онлайн"],["room","Комната"]]}/>
          <div hidden={sideTab!=="releases"} role="tabpanel" id="watch-tools-panel-releases" aria-labelledby="watch-tools-releases" className="watch-panel space-y-4">
            {a && <DesktopDownloads compact title={id} titleName={name} episodeCount={a.episodes??undefined} watchEpisode={inRoom?undefined:ep} onWatchStage={setDownloadStage} onReady={device=>router.replace(`/anime/${id}/watch/${ep}?device=${device}&play=1`)} />}
            {a && <details><summary className="cursor-pointer py-3 text-sm text-gray-300">Раздачи на медиасервере</summary><VoicesButton watchEpisode={ep} media={a} size="sm" onSubs={()=>controls.current?.reload()}/></details>}
            {a && <WatchSidebar media={a} mode="audio" info={player.info} sub={player.sub} subs={player.subs} signs={player.signs} signsState={player.signsState} controls={controls}/>}
          </div>
          <div hidden={sideTab!=="sub"} role="tabpanel" id="watch-tools-panel-sub" aria-labelledby="watch-tools-sub" className="watch-panel">{a&&<WatchSidebar media={a} mode="sub" info={player.info} sub={player.sub} subs={player.subs} signs={player.signs} signsState={player.signsState} controls={controls}/>}</div>
          <div hidden={sideTab!=="online"} role="tabpanel" id="watch-tools-panel-online" aria-labelledby="watch-tools-online" className="watch-panel space-y-3 text-sm text-gray-400"><p>Просмотр через медиасервер с загрузкой по мере воспроизведения.</p>{a&&<VoicesButton watchEpisode={ep} media={a}/ >}{personalDevice&&<Button onClick={()=>router.replace(`/anime/${id}/watch/${ep}`)}>Перейти на медиасервер</Button>}<p className="text-xs">Внешние онлайн-плееры пока не подключены.</p></div>
          <div hidden={sideTab!=="room"} role="tabpanel" id="watch-tools-panel-room" aria-labelledby="watch-tools-room" className="watch-panel space-y-4">
            {inRoom&&rm.room?.groupId&&<DesktopSource room={rid!} ep={ep} data={desktopSources.data} canControl={rm.canControl} refresh={()=>{void desktopSources.refetch();}}/>}
          <RoomPanel handle={rm} friends={rooms?.friends ?? []} groups={rooms?.groups ?? []}
            invited={!inRoom && rooms?.room && rooms.room.members.find((m) => m.id === rooms.room!.me)?.status === "invited" ? rooms.room : null}
            onJoin={(r) => router.replace(`/anime/${id}/watch/${rooms?.room?.state.ep ?? ep}?room=${r}`)}
            onCreate={async (ids, group) => {
              const r = await api<RoomView>("/api/rooms", { method: "POST", json: { anilistId: id, ep, invite: ids, group, ...(personalDevice ? { device: personalDevice } : {}), ...controls.current?.position() } });
              await refetchRooms();
              router.replace(`/anime/${id}/watch/${ep}?room=${r.id}`);
            }}
            onLeave={() => { void refetchRooms(); router.replace(`/anime/${id}/watch/${ep}`); }} />
          </div>
        </aside>
      </div>



      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-lg font-semibold">Серия {ep}</h1>
              {a && (seenEpisode(ep) ? (
                <Badge tone="positive"><CheckIcon className="h-3.5 w-3.5" /> Просмотрено</Badge>
              ) : (
                <Button size="sm" onClick={async () => {try{await api("/api/watch-history",{method:"POST",json:{action:"episode",anilistId:id,ep}});await qc.invalidateQueries({queryKey:["watch-history"]});await qc.invalidateQueries({queryKey:["list"]});}catch(e){await alert({title:"Не удалось сохранить отметку",text:String(e)});}}} title="Отметить только эту серию просмотренной">
                  <CheckIcon className="h-4 w-4" /> В просмотренное
                </Button>
              ))}
      </div>
      <EpisodePanels key={`content:${id}:${ep}`} id={id} ep={ep} plot={plot}/>

    </div>
  );
}

const STATE_TIP: Record<EpisodeStatus["state"], string> = {
  library: "В библиотеке", stream: "«Стрим»", downloading: "Качается", aired: "Нет раздачи", upcoming: "Ещё не вышла",
};

/** Лента серий: кадр, номер и название, готовность (кэш TorrServer, «Подготовить»), прогресс, галочка. */
function EpisodeStrip({ id, current, statuses, watched, seenEpisodes, positions, titles, schedule, onPick }: {
  id: number; current: number; statuses: EpisodeStatus[]; watched: number; seenEpisodes: number[];
  schedule:{episode:number;airingAt:number}[];
  positions: { ep: number; pos: number; dur: number | null }[];
  titles: Map<number, { title: string | null; still: string | null }>; onPick: (ep: number) => void;
}) {
  const { prepare, busy } = usePrepare(id);
  const strip = useRef<HTMLDivElement>(null);
  // Кадры серий дальше следующей непросмотренной — размыты (спойлер); выбор общий с «Показать все описания» тайтла
  const [shots, setShots] = useState(false);
  useEffect(() => {
    try { setShots(localStorage.getItem(SPOILERS_KEY) === "1"); } catch { /* без хранилища — размыто */ }
  }, []);
  const toggleShots = () => setShots((v) => {
    try { localStorage.setItem(SPOILERS_KEY, v ? "0" : "1"); } catch { /* не страшно */ }
    return !v;
  });
  const pos = new Map(positions.map((p) => [p.ep, p]));
  // Текущая серия — в середине ленты
  useEffect(() => {
    const list=strip.current,item=list?.querySelector<HTMLElement>(`[data-ep="${current}"]`);
    if(list&&item)list.scrollTo({left:list.scrollLeft+item.getBoundingClientRect().left-list.getBoundingClientRect().left-(list.clientWidth-item.clientWidth)/2,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
  }, [current, statuses.length]);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">Серии <span className="text-sm font-normal text-gray-500">{statuses.length}</span></h2>
        {statuses.some((s) => s.ep > watched + 1) && (
          <button onClick={toggleShots} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
            title="Кадры серий дальше вашей размыты, чтобы не подсмотреть сюжет">
            {shots ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            {shots ? "Размыть кадры дальше моей" : "Показать кадры"}
          </button>
        )}
        <div className="ml-auto flex gap-1">{[-1,1].map(dir=><button key={dir} aria-label={dir<0?"Предыдущие серии":"Следующие серии"} onClick={()=>strip.current?.scrollBy({left:dir*strip.current.clientWidth*.8,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"})} className="grid h-11 w-11 place-items-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-300">{dir<0?<ChevronLeftIcon className="h-4 w-4"/>:<ChevronRightIcon className="h-4 w-4"/>}</button>)}</div>
      </div>
      <div ref={strip} className="flex snap-x items-start gap-3 overflow-x-auto px-1 py-2 [scrollbar-width:thin]">
        {statuses.map((s) => {
          const t = titles.get(s.ep);
          const p = pos.get(s.ep);
          const can = s.state !== "upcoming";
          const seen = seenEpisodes.includes(s.ep) || s.ep <= watched;
          const progress = seen ? 1 : p?.dur ? Math.min(1, p.pos / p.dur) : 0;
          // Дальше следующей серии — кадр размыт (не подсмотреть сюжет); открытая сейчас — видна
          const hide = !shots && !seen;
          // Название — только у просмотренных и открытой сейчас, у остальных номер (названия серий тоже спойлерят)
          const named = t?.title && (seen || shots) ? t.title : null;
          return (
            <div key={s.ep} data-ep={s.ep} className={cx("w-44 shrink-0 snap-start overflow-hidden rounded-lg bg-gray-800/60 ring-1",
              s.ep === current ? "ring-2 ring-accent-400" : "ring-gray-700", !can && "opacity-60")}>
              <button aria-label={`Серия ${s.ep}${!can?", ещё не вышла":""}`} aria-current={s.ep===current?"true":undefined} onClick={() => onPick(s.ep)} disabled={!can} title={s.desktop ? "На desktop-хосте" : STATE_TIP[s.state]} className="block w-full text-left disabled:cursor-not-allowed">
                <div className="relative aspect-video overflow-hidden bg-gray-700">
                  {t?.still && <Img src={t.still} size="thumb" className={cx("absolute inset-0 h-full w-full object-cover", hide && "blur-[2px] brightness-75")} />}
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-xs font-semibold tabular-nums text-white">{s.ep}</span>
                  {!can && <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-gray-900/60 text-xs text-gray-200"><LockClosedIcon className="h-5 w-5"/>{schedule.find(d=>d.episode===s.ep)?new Date(schedule.find(d=>d.episode===s.ep)!.airingAt*1000).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"TBA"}</span>}
                  {seen && <span className="absolute right-1.5 top-1.5 rounded-full bg-black/70 p-0.5"><CheckIcon className="h-3.5 w-3.5 text-positive-300" /></span>}
                  {p && !seen && p.pos > 5 && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] text-gray-200">{clock(p.pos)}</span>}
                  {/* Прогресс просмотра */}
                  {progress > 0 && <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50"><span className="block h-full bg-accent-400" style={{ width: `${progress * 100}%` }} /></span>}
                </div>
                <p className={cx("truncate px-2 pt-1.5 text-xs", named ? "text-gray-200" : "text-gray-400")} title={named ?? undefined}>{named ?? `Серия ${s.ep}`}</p>
              </button>
              <div className="flex h-7 items-center gap-1.5 px-2 pb-1.5 text-[11px] text-gray-400">
                <ReadyLine s={s} />
                {s.state === "stream" && !s.preparing && (s.cached ?? 0) < 0.97 && (
                  <button onClick={() => prepare(s)} disabled={busy} className="ml-auto rounded px-1.5 py-0.5 text-accent-300 hover:bg-gray-700"
                    title="Скачать серию в кэш TorrServer заранее — смотреть без остановок">
                    Подготовить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Готовность серии одной строкой: библиотека / «Стрим» с кэшем / качается / нет. */
function ReadyLine({ s }: { s: EpisodeStatus }) {
  if (s.desktop) return <span className="text-positive-300">На хосте</span>;
  if (s.state === "library") return <span className="text-positive-300">В библиотеке</span>;
  if (s.state === "downloading") return <span className="text-info-300">{s.preparing?"Подготовка":"Качается"} {Math.round((s.pct ?? 0) * 100)}%</span>;
  if (s.state === "stream") {
    const c = Math.round((s.cached ?? 0) * 100);
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`В кэше TorrServer: ${c}%`}>
        <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-gray-700"><span className="block h-full bg-accent-500" style={{ width: `${c}%` }} /></span>
        <span className={cx("truncate", c >= 97 ? "text-positive-300" : "")}>
          {s.preparing ? `качаю${s.etaSec ? ` · ~${waitText(s.etaSec)}` : ` ${c}%`}` : s.downloaded ? "скачана" : c >= 97 ? "готова" : `${c}%`}
        </span>
      </span>
    );
  }
  return <span>{s.state === "aired" ? "Нет раздачи" : "Не вышла"}</span>;
}
