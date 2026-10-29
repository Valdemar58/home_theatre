"use client";
import { CheckIcon, ExclamationTriangleIcon, EyeIcon, EyeSlashIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useAnime, useEpisodeStatus, useList, useListMutation, usePlot } from "@/lib/client";
import { FORMAT_LABELS, label, STATUS_LABELS } from "@/lib/labels";
import { CACHE_WARN, playable, waitText, type EpisodeStatus, type TorrentCache } from "@/lib/playback";
import type { PlayInfo } from "@/lib/player";
import type { RoomView } from "@/lib/room";
import { displayTitle } from "@/lib/schedule";
import { useAlert, useConfirm } from "../Dialogs";
import { Discussion } from "../Discussion";
import { EpisodeAlerts } from "../EpisodeAlerts";
import { FriendOpinions } from "../FriendOpinions";
import { Img } from "../Img";
import { ListControl } from "../ListControl";
import { Recap } from "../Plot";
import { PlotHub } from "../PlotHub";
import { Scores } from "../Scores";
import { Badge, Button, cx } from "../ui";
import { usePrepare } from "../WatchButton";
import { clock, Player, type PlayerControls, type RoomSync, type SignsState, type SubSettings } from "./Player";
import { actionText, RoomPanel } from "./RoomPanel";
import { useRoom } from "./useRoom";
import { WatchSidebar } from "./WatchSidebar";

// Страница просмотра серии (по мотивам AniLib): шапка тайтла, плеер и боковая панель «Озвучка / Субтитры», лента
// серий (кадр, готовность, кэш TorrServer, «Подготовить», прогресс), под плеером — серия, сюжет, друзья, обсуждение.

const gb = (b: number) => `${(b / 1e9).toFixed(1)} ГБ`;
// Общий с «Показать все описания» на странице тайтла (Plot.tsx)
const SPOILERS_KEY = "episodes-show-all";

export function WatchView({ id, ep }: { id: number; ep: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { data: a } = useAnime(id);
  const { data: plot } = usePlot(id);
  const { data: st } = useEpisodeStatus(id);
  const { byId } = useList();
  const { upsert } = useListMutation();
  const entry = byId.get(id);
  const watched = entry?.status === "completed" ? (a?.episodes ?? entry.episodes) : entry?.episodes ?? 0;
  const eps = st?.episodes ?? [];
  const nextEp = eps.find((s) => s.ep > ep && playable(s));
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
  const rid = urlRoom ?? (mineJoined ? rooms!.room!.id : null);
  const rm = useRoom(rid);
  const meInRoom = rm.room?.members.find((m) => m.id === rm.room!.me);
  const inRoom = Boolean(rm.room && !rm.ended && meInRoom?.status === "joined");
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
    const q = new URLSearchParams();
    if (play) q.set("play", "1");
    if (rid && inRoom) q.set("room", rid);
    router.push(`/anime/${id}/watch/${n}${q.size ? `?${q}` : ""}`);
  }, [router, id, rid, inRoom]);
  // Комната перешла на другую серию — за ней
  const roomEp = inRoom ? rm.room!.state.ep : null;
  useEffect(() => {
    if (roomEp && roomEp !== ep) router.replace(`/anime/${id}/watch/${roomEp}?room=${rid}&play=1`);
  }, [roomEp, ep, id, rid, router]);
  const sync: RoomSync | null = useMemo(() => (inRoom && rm.room ? {
    state: rm.room.state, canControl: rm.canControl, serverNow: rm.serverNow, report: rm.report,
    command: (action, pos) => void rm.act({ action, pos }).catch(() => undefined),
  } : null), [inRoom, rm]);
  // Серию в комнате меняет тот, у кого пульт
  const pickEp = (n: number, play = false) => {
    if (!inRoom) return go(n, play);
    if (!rm.canControl) return alert({ title: "Серию меняет организатор", text: "В этой комнате пульт только у организатора и тех, кому он его дал." });
    void rm.act({ action: "ep", ep: n });
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
    if (r.marked) void qc.invalidateQueries({ queryKey: ["list"] });
  }, [qc]);
  const controls = useRef<PlayerControls | null>(null);
  const [player, setPlayer] = useState<{ info: PlayInfo | null; sub: number | null; subs: SubSettings; signs: number | null; signsState: SignsState }>(
    { info: null, sub: null, subs: { delay: 0, size: 100 }, signs: null, signsState: null });
  const spoiler = ep > watched + 1;

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

      {/* Плеер и боковая панель */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Player key={`${id}:${ep}`} anilistId={id} ep={ep} autoPlay={params.get("play") === "1"}
          title={`${name} · ${ep} серия${info?.title ? ` · ${info.title}` : ""}`}
          preview={{ still: info?.still ?? null, heading: `${ep} серия${info?.title ? ` · ${info.title}` : ""}`, text: spoiler ? null : info?.overview ?? null }}
          next={nextEp && (!inRoom || rm.canControl) ? { label: `${nextEp.ep} серия`, go: () => pickEp(nextEp.ep, true) } : null}
          onReport={onReport}
          onState={setPlayer} controls={controls} room={sync}>
          {() => (toast || waiting.length > 0) && (
            <div className="pointer-events-none absolute inset-x-0 top-12 z-20 mx-auto w-fit max-w-[90%] rounded-lg bg-black/80 px-3 py-1.5 text-sm text-white ring-1 ring-white/10">
              {waiting.length ? `Ждём: ${waiting.join(", ")}` : toast}
            </div>
          )}
        </Player>
        <div className="space-y-4">
          {a && <WatchSidebar media={a} info={player.info} sub={player.sub} subs={player.subs} signs={player.signs} signsState={player.signsState} controls={controls} />}
          <RoomPanel handle={rm} friends={rooms?.friends ?? []} groups={rooms?.groups ?? []}
            invited={!inRoom && rooms?.room && rooms.room.members.find((m) => m.id === rooms.room!.me)?.status === "invited" ? rooms.room : null}
            onJoin={(r) => router.replace(`/anime/${id}/watch/${rooms?.room?.state.ep ?? ep}?room=${r}`)}
            onCreate={async (ids, group) => {
              const r = await api<RoomView>("/api/rooms", { method: "POST", json: { anilistId: id, ep, invite: ids, group, ...controls.current?.position() } });
              await refetchRooms();
              router.replace(`/anime/${id}/watch/${ep}?room=${r.id}`);
            }}
            onLeave={() => { void refetchRooms(); router.replace(`/anime/${id}/watch/${ep}`); }} />
        </div>
      </div>

      {st && <CacheWarnings caches={st.caches} anilistId={id} />}
      {eps.length > 0 && (
        <EpisodeStrip id={id} current={ep} statuses={eps} watched={watched} positions={st?.positions ?? []}
          titles={new Map(plot?.episodes.map((e) => [e.number, e]) ?? [])} onPick={(n) => pickEp(n)} />
      )}

      {/* Под плеером: серия, сюжет, друзья, обсуждение */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold">{ep} серия{info?.title ? <span className="font-normal text-gray-300"> · {info.title}</span> : null}</h1>
              {a && (ep <= watched ? (
                <Badge tone="positive"><CheckIcon className="h-3.5 w-3.5" /> Просмотрено</Badge>
              ) : (
                <Button size="sm" onClick={() => upsert.mutate({ media: a, patch: { episodes: ep } })} title="Отметить эту серию (и все до неё) просмотренными">
                  <CheckIcon className="h-4 w-4" /> В просмотренное
                </Button>
              ))}
            </div>
            {info?.overview && (spoiler
              ? <p className="text-sm text-gray-500">Описание скрыто: вы ещё не досмотрели до этой серии.</p>
              : <p className="text-sm leading-relaxed text-gray-300">{info.overview}</p>)}
          </section>
          {a && plot?.hasPrequels && plot && <Recap id={id} plot={plot} />}
          {a && <PlotHub media={a} />}
          <Discussion anilistId={id} episode={ep} />
        </div>
        <aside className="space-y-4">
          <FriendOpinions id={id} />
        </aside>
      </div>
    </div>
  );
}

/** Кэш раздачи почти полон: подготовка следующих серий вытеснит скачанное. Варианты — сбросить или убрать раздачу. */
function CacheWarnings({ caches, anilistId }: { caches: TorrentCache[]; anilistId: number }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const full = caches.filter((c) => c.capacity > 0 && c.filled / c.capacity >= CACHE_WARN);
  if (!full.length) return null;
  const act = async (c: TorrentCache, action: "drop" | "remove") => {
    const ok = await confirm(action === "drop"
      ? { title: "Сбросить кэш раздачи?", text: "Всё скачанное из раздачи освободится, подготовленные серии придётся готовить заново.", confirm: "Сбросить" }
      : { title: "Убрать раздачу?", text: "Раздача и серии «Стрима» из неё пропадут; посмотреть снова — через «Озвучки».", confirm: "Убрать", danger: true });
    if (!ok) return;
    await api("/api/downloads/cache", { method: "POST", json: { hash: c.hash, action } });
    await qc.invalidateQueries({ queryKey: ["episode-status", anilistId] });
  };
  return (
    <div className="space-y-2">
      {full.map((c) => (
        <div key={c.hash} className="tone-warning soft flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-inset">
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Кэш раздачи заполнен на {Math.round((c.filled / c.capacity) * 100)}% ({gb(c.filled)} из {gb(c.capacity)}): подготовка следующих серий
            вытеснит уже скачанное (сначала — то, что дальше всего от просмотра).
          </p>
          <Button size="sm" onClick={() => act(c, "drop")}>Сбросить кэш</Button>
          <Button size="sm" variant="ghost" onClick={() => act(c, "remove")}>Убрать раздачу</Button>
        </div>
      ))}
    </div>
  );
}

const STATE_TIP: Record<EpisodeStatus["state"], string> = {
  library: "В библиотеке", stream: "«Стрим»", downloading: "Качается", aired: "Нет раздачи", upcoming: "Ещё не вышла",
};

/** Лента серий: кадр, номер и название, готовность (кэш TorrServer, «Подготовить»), прогресс, галочка. */
function EpisodeStrip({ id, current, statuses, watched, positions, titles, onPick }: {
  id: number; current: number; statuses: EpisodeStatus[]; watched: number;
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
  const [find, setFind] = useState("");
  const pos = new Map(positions.map((p) => [p.ep, p]));
  // Текущая серия — в середине ленты
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-ep="${current}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [current, statuses.length]);
  const jump = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(find);
    if (n >= 1 && n <= statuses.length) strip.current?.querySelector<HTMLElement>(`[data-ep="${n}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-bold">Серии <span className="text-sm font-normal text-gray-500">{statuses.length}</span></h2>
        {statuses.some((s) => s.ep > watched + 1) && (
          <button onClick={toggleShots} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
            title="Кадры и названия серий дальше вашей размыты, чтобы не подсмотреть сюжет">
            {shots ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            {shots ? "Размыть серии дальше моей" : "Показать кадры и названия"}
          </button>
        )}
        <form onSubmit={jump} className="ml-auto flex items-center gap-1 rounded-lg bg-gray-800/60 px-2 ring-1 ring-gray-700">
          <MagnifyingGlassIcon className="h-4 w-4 text-gray-500" />
          <input value={find} onChange={(e) => setFind(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Серия №" inputMode="numeric"
            className="h-8 w-20 bg-transparent text-sm outline-none placeholder:text-gray-500" />
        </form>
      </div>
      <div ref={strip} className="flex snap-x items-start gap-2 overflow-x-auto pb-2">
        {statuses.map((s) => {
          const t = titles.get(s.ep);
          const p = pos.get(s.ep);
          const can = playable(s);
          const seen = s.ep <= watched;
          const progress = seen ? 1 : p?.dur ? Math.min(1, p.pos / p.dur) : 0;
          // Дальше следующей серии — кадр и название размыты (не подсмотреть сюжет); открытая сейчас — видна
          const hide = !shots && s.ep > watched + 1 && s.ep !== current;
          return (
            <div key={s.ep} data-ep={s.ep} className={cx("w-44 shrink-0 snap-start overflow-hidden rounded-lg bg-gray-800/60 ring-1",
              s.ep === current ? "ring-2 ring-accent-400" : "ring-gray-700", !can && "opacity-60")}>
              <button onClick={() => onPick(s.ep)} disabled={!can} title={STATE_TIP[s.state]} className="block w-full text-left disabled:cursor-not-allowed">
                <div className="relative aspect-video overflow-hidden bg-gray-900">
                  {t?.still && <Img src={t.still} size="thumb" className={cx("absolute inset-0 h-full w-full object-cover", hide && "blur-[2px] brightness-75")} />}
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-xs font-semibold tabular-nums text-white">{s.ep}</span>
                  {seen && <span className="absolute right-1.5 top-1.5 rounded-full bg-black/70 p-0.5"><CheckIcon className="h-3.5 w-3.5 text-positive-300" /></span>}
                  {p && !seen && p.pos > 5 && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] text-gray-200">{clock(p.pos)}</span>}
                  {/* Прогресс просмотра */}
                  {progress > 0 && <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50"><span className="block h-full bg-accent-400" style={{ width: `${progress * 100}%` }} /></span>}
                </div>
                <p className={cx("truncate px-2 pt-1.5 text-xs text-gray-200", hide && t?.title && "select-none blur-[4px]")}>{t?.title ?? `Серия ${s.ep}`}</p>
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
  if (s.state === "library") return <span className="text-positive-300">В библиотеке</span>;
  if (s.state === "downloading") return <span className="text-info-300">Качается {Math.round((s.pct ?? 0) * 100)}%</span>;
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
