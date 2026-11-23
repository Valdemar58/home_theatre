"use client";
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, BackwardIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, Cog6ToothIcon, ForwardIcon,
  InformationCircleIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon, ViewfinderCircleIcon,
} from "@heroicons/react/24/solid";
import type Hls from "hls.js";
import type JASSUB from "jassub";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { COMPAT_KEY, rememberedSub, subChoiceOf, type FrameItem, type PlayCaps, type PlayInfo, type PlayStatus, type SubChoice, videoTrackOf } from "@/lib/player";
import { positionAt, type RoomState } from "@/lib/room";
import { RoomPlayback } from "@/lib/room-playback";
import { bindMediaSession } from "@/lib/media-session";
import { DesktopRecovery } from "@/lib/desktop-recovery";
import { cx, ErrorBox, Spinner } from "../ui";
import { StreamStatus, type Stage } from "./StreamStatus";
import { connectDesktop, type DesktopDiagnostics } from "@/lib/desktop-transport";

// Плеер серии: поток Jellyfin через календарь (HLS — hls.js, Safari — сам), ASS — JASSUB (libass в браузере,
// шрифты из вложений файла), остальные субтитры — <track> (Jellyfin отдаёт их как WebVTT). Смена озвучки — новая
// сессия с той же позиции (Jellyfin перекодирует звук под выбранную дорожку). Позиция — на сервер раз в 10 с.

const QUALITY_KEY = "player-bitrate";
const AUTOSKIP_KEY = "player-autoskip";
const SPEED_KEY = "player-speed";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const speedLabel = (s: number) => `${String(s).replace(".", ",")}×`;
const SEG_LABEL = { op: "опенинг", ed: "эндинг" } as const;
const VOLUME_KEY = "player-volume";
const SUB_KEY = "player-sub-lang";
const subTitleKey = (anilistId: number) => `player-sub:${anilistId}`;
// Слой «Надписи поверх»: off / ru (русские надписи) / translate (по-русски из полной дорожки)
const SIGNS_KEY = "player-signs";
// «Авто» — решает сервер: дома исходное, из интернета 6 Мбит/с
const QUALITIES = [
  { label: "Авто", value: 0 },
  { label: "Исходное", value: 120e6 },
  { label: "8 Мбит/с", value: 8e6 },
  { label: "4 Мбит/с", value: 4e6 },
  { label: "2 Мбит/с", value: 2e6 },
];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* без хранилища — не запоминаем */ } },
};

/**
 * Параметры куска новой сессии (renew): её идентификаторы, но время — этого куска из прежнего адреса. Jellyfin по
 * runtimeTicks решает, с какой секунды перезапустить перекодирование; с временем первого куска новой сессии он
 * запускал ffmpeg без -ss — куски с номером 78 и картинкой с начала серии (TASKS 9.7, прыжок назад после пропуска OP).
 */
function remapQuery(sessionQuery: string, oldUrl: string): string {
  const q = new URLSearchParams(sessionQuery);
  const old = new URL(oldUrl, location.href).searchParams;
  for (const [k, v] of old) if (/ticks/i.test(k)) q.set(k, v);
  return `?${q}`;
}

/** Запомненный выбор субтитров; старый формат — только язык («ru» / «off»). */
function readChoice(key: string): SubChoice | null {
  const v = store.get(key);
  if (!v) return null;
  if (v === "off") return { off: true };
  try { return JSON.parse(v) as SubChoice; } catch { return { from: "file", lang: v, label: "" }; }
}

/**
 * Что браузер декодирует сам (HEVC 10 бит — Chrome/Edge с аппаратным декодером, Safari).
 * Совместимый режим — всегда H.264: браузер может заявлять HEVC, а показывать чёрный экран.
 */
function detectCaps(): PlayCaps {
  const ok = (c: string) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`);
  const compat = store.get(COMPAT_KEY) === "1";
  return { hevc: !compat && ok("hvc1.2.4.L120.B0"), av1: !compat && ok("av01.0.08M.10"), maxBitrate: Number(store.get(QUALITY_KEY)) || 0 };
}

/** H.264 + AAC в MSE — без них не сыграть ничего (Jellyfin перекодирует именно в них). */
const canPlayBasic = () => typeof MediaSource === "undefined" || MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"');

/** Сколько ждать картинку, прежде чем предложить перезапуск или совместимый режим. */
const STALL_MS = 20_000;

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

/** Управление плеером снаружи (боковая панель страницы): озвучка и субтитры. */
/** Слой надписей: перевод готовится, показан, в дорожке нет надписей, ошибка. */
export type SignsState = "loading" | "ready" | "empty" | "error" | null;

export type PlayerControls = {
  diagnostics?: () => Record<string, number | boolean | null> | null;
  setAudio: (index: number) => void;
  /** Озвучка из раздачи «Стрима» отдельным файлом: сервер скачает звук серии и включит его */
  setVoice: (group: string) => void;
  setSub: (index: number | null) => void;
  /** Сдвиг субтитров, с: плюс — позже (тайминг другого релиза) */
  setSubDelay: (sec: number) => void;
  /** Надписи поверх субтитров (отдельный слой) */
  setSigns: (index: number | null) => void;
  /** Размер текстовых субтитров, % (ASS рисуется стилями файла) */
  setSubSize: (pct: number) => void;
  reload: () => void;
  /** Где сейчас и идёт ли просмотр (комната создаётся с этого места) */
  position: () => { pos: number; playing: boolean };
};
export type SubSettings = { delay: number; size: number };

/** Комната совместного просмотра: плеер держится её позиции, свои пауза и перемотка уходят всем. */
export type RoomSync = {
  policy?: import("@/lib/sync-policy").SyncPolicy;
  id?: string;
  state: RoomState;
  canControl: boolean;
  serverNow: () => number;
  command: (action: "play" | "pause" | "seek", pos: number) => Promise<unknown> | void;
  report: (r: { telemetry?: unknown; playbackError?: boolean; buffering: boolean; bw: number | null; drift: number | null; position?: number; buffered?: [number, number][] }) => void;
};

export function Player({ anilistId, ep, source, desktopRoom, title, onEnded, next, onReport, children, autoPlay, preview, onState, onConnection, controls, room, fullscreenRoot }: {
  onConnection?: (value: DesktopDiagnostics | null) => void;
  desktopRoom?: string;
  anilistId: number;
  source?: string;
  /** Что разворачивать во весь экран: обёртка снаружи переживает смену серии (плеер пересоздаётся) — экран не сворачивается */
  fullscreenRoot?: React.RefObject<HTMLElement | null>;
  ep: number;
  title: string;
  /** Сразу смотреть (автопереход); иначе — превью серии и кнопка ▶ (сессия Jellyfin готовится заранее) */
  autoPlay?: boolean;
  preview?: { still: string | null; heading: string; text: string | null };
  /** Сессия и выбранные субтитры — для боковой панели */
  onState?: (s: { info: PlayInfo | null; sub: number | null; subs: SubSettings; signs: number | null; signsState: SignsState; preparing:boolean; started:boolean }) => void;
  controls?: React.MutableRefObject<PlayerControls | null>;
  /** Смотрим в комнате */
  room?: RoomSync | null;
  /** Досмотрели до конца — следующая серия (если есть) */
  onEnded?: (duration: number) => void;
  next?: { label: string; go: () => void } | null;
  onReport?: (r: { marked: boolean }) => void;
  /** Слой поверх видео (пропуск опенинга и т. п.); получает текущее время */
  children?: (t: number, seek: (to: number) => void) => React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const ass = useRef<JASSUB | null>(null);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(store.get(VOLUME_KEY) ?? 1));
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(() => typeof document !== "undefined" && Boolean(document.fullscreenElement));
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState(false);
  // Скорость — общая для всех серий; в комнате всегда 1× (скоростью комната подтягивает отстающих)
  const [speed, setSpeed] = useState(() => (SPEEDS.includes(Number(store.get(SPEED_KEY))) ? Number(store.get(SPEED_KEY)) : 1));
  const [sub, setSub] = useState<number | null>(null);
  // Надписи поверх субтитров — свой JASSUB; из полной дорожки с переводом — сначала ждём сервер
  const [signs, setSigns] = useState<number | null>(null);
  const [signsState, setSignsState] = useState<SignsState>(null);
  const assSigns = useRef<JASSUB | null>(null);
  // «Перевести кадр» на паузе: надписи кадра с переводом поверх видео (до «смотреть» или перемотки)
  const [frame, setFrame] = useState<{ t: number; items: FrameItem[] | null } | null>(null);
  // Сдвиг — свой у тайтла (релизы разные), размер — общий
  const delayKey = `sub-delay:${anilistId}`;
  const [subDelay, setSubDelay] = useState(() => Number(store.get(delayKey)) || 0);
  const [subSize, setSubSize] = useState(() => Number(store.get("player-sub-size")) || 100);
  const track = useRef<HTMLTrackElement>(null);
  const sid = useRef<string | null>(null);
  // Что сейчас с потоком: панель состояния и сторож «картинка не пошла»
  const [stage, setStage] = useState<Stage>({ step: "session", since: Date.now() });
  const [showStatus, setShowStatus] = useState(false);
  const [stalled, setStalled] = useState(false);
  const progressAt = useRef(Date.now());
  const coverageSid = useRef<string | null>(null);
  // HEVC заявлен в этой сессии (видео идёт как есть) и сколько раз уже восстанавливались после сбоя
  const hevcSent = useRef(false);
  const recoveries = useRef(0);
  // Сбои загрузки кусков подряд и новые сессии подряд (сбрасываются первым же пришедшим куском)
  const netFails = useRef(0);
  const renewals = useRef(0);
  // Новая сессия без пересоздания плеера: тот же hls.js, а куски просятся у новой сессии (номера кусков у Jellyfin —
  // от начала файла, у старой и новой сессии одни и те же), запас в буфере остаётся
  const swap = useRef(false);
  const startAt = useRef(0);
  const remap = useRef<{ from: string; dir: string; query: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bufferAhead, setBufferAhead] = useState(0);
  const [desktopNet, setDesktopNet] = useState<DesktopDiagnostics | null>(null);
  const desktopNetRef = useRef(desktopNet); desktopNetRef.current = desktopNet;
  const connectionReport = useRef(onConnection); connectionReport.current = onConnection;
  const desktopUnavailable = desktopNet?.mode === "closed" && !desktopNet.directBytes && !desktopNet.relayBytes;
  // До нажатия ▶ — превью: сессия уже открыта (Jellyfin прочитал файл), поток не запрошен
  const [started, setStarted] = useState(Boolean(autoPlay));
  // Пропуск опенинга/эндинга: сам (настройка) — один раз за серию, отмотали назад вручную — не прыгаем снова
  const [autoSkip, setAutoSkip] = useState(() => store.get(AUTOSKIP_KEY) === "1");
  const skipped = useRef(new Set<string>());
  // Серия кончилась — отсчёт до следующей (отменяется)
  const [countdown, setCountdown] = useState<number | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const nativeFullscreen = useRef(false);
  const pictureInPicture = useRef(false);
  const nativeActive = () => nativeFullscreen.current || pictureInPicture.current || document.hidden;
  const playback = useRef<RoomPlayback | null>(null);
  const inRoom = Boolean(room);
  // Насколько плеер разошёлся с комнатой (для отчёта)
  const drift = useRef<number | null>(null);
  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 3000);
  }, []);
  if (!playback.current) playback.current = new RoomPlayback(() => video.current, () => roomRef.current, flash, Date.now, setAutoplayBlocked);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) { next?.go(); return; }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, next]);

  // ---------------------------------------------------------------- сессия и поток
  const open = useCallback(async (opts: { audio?: number | null; voice?: string; start?: number | null } = {}) => {
    coverageSid.current = null;
    setLoading(true);
    setError(null);
    setStalled(false);
    setDesktopNet(null);
    connectionReport.current?.(null);
    progressAt.current = Date.now();
    setStage({ step: "session", since: Date.now() });
    try {
      const caps = detectCaps();
      // Браузер не играет даже H.264 + AAC (встроенный просмотрщик VS Code — Electron без этих кодеков): сказать сразу
      if (!canPlayBasic()) throw new Error("Этот просмотрщик не умеет видео H.264/AAC (например, встроенный браузер VS Code) — откройте страницу в Chrome, Edge или Firefox");
      // В комнате — с её позиции
      const rm = roomRef.current;
      const start = opts.start ?? (rm ? positionAt(rm.state, rm.serverNow()) : undefined);
      const r = await api<PlayInfo>("/api/play", { method: "POST", ...(desktopRoom ? { signal: AbortSignal.timeout(15000) } : {}), json: { anilistId, ep, source, desktopRoom, caps, ...opts, start, replace: sid.current } });
      hevcSent.current = caps.hevc;
      recoveries.current = 0;
      sid.current = r.sid;
      setInfo(r);
      // Выбор субтитров запоминается у тайтла (та же дорожка в следующих сериях и после перезагрузки), без него —
      // язык последнего выбора в любом тайтле
      const saved = readChoice(subTitleKey(anilistId)) ?? readChoice(SUB_KEY);
      const picked = rememberedSub(r.subs, saved, r.subIndex);
      setSub((prev) => (opts.audio !== undefined || opts.voice ? prev : picked));
    } catch (e) {
      setError(["TimeoutError", "AbortError"].includes((e as Error).name) ? new Error("Сервер не ответил на запрос просмотра. Проверьте связь с комнатой и повторите подключение.") : e);
      setLoading(false);
    }
  }, [anilistId, ep, source, desktopRoom]);

  useEffect(() => {
    void open();
    const v = video.current;
    return () => {
      // Закрыли плеер — запомнить, где остановились, и остановить перекодирование
      if (sid.current) {
        void fetch(`/api/play/${sid.current}`, {
          method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pos: v?.currentTime ?? 0,
            played: v && coverageSid.current === sid.current ? Array.from({ length: v.played.length }, (_, i) => [v.played.start(i), v.played.end(i)]) : [] }),
        });
      }
      sid.current = null;
    };
  }, [open]);

  // Поток пропал (календарь перезапускался, Jellyfin остановил перекодирование): новая сессия с текущей секунды,
  // поданная в тот же hls.js — картинка тем временем идёт из запаса
  const renewing = useRef(false);
  const renew = useCallback(async () => {
    const v = video.current;
    if (!v || !sid.current || renewing.current) return;
    if (desktopRoom) { await open({ start: v.currentTime }); return; }
    renewing.current = true;
    try {
      const old = sid.current;
      const r = await api<PlayInfo>("/api/play", { method: "POST", json: { anilistId, ep, source, caps: detectCaps(), audio: info?.audioIndex ?? null, start: v.currentTime, replace: sid.current } });
      // Адрес кусков новой сессии: каталог и параметры — из её плейлиста
      const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      const variant = new URL(first(await (await fetch(r.src)).text()) ?? "", new URL(r.src, location.href));
      const seg = new URL(first(await (await fetch(variant)).text()) ?? "", variant);
      remap.current = { from: remap.current?.from ?? `/api/play/${old}/`, dir: seg.pathname.replace(/[^/]+$/, ""), query: seg.search };
      sid.current = r.sid;
      // Seamless renewal retains the same media element and its played TimeRanges.
      coverageSid.current = r.sid;
      swap.current = true;
      setInfo(r);
      hls.current?.startLoad(v.currentTime);
    } catch (e) {
      setError(e);
    } finally {
      renewing.current = false;
    }
  }, [anilistId, ep, info?.audioIndex, desktopRoom, open]);
  /** Сессии на сервере больше нет (404) — повторять бесполезно, сразу новая (не больше 3 раз без единого куска). */
  const sessionLost = useCallback(() => {
    if (renewals.current++ < 3) void renew();
    else setError(new Error("Поток прервался: сессия просмотра пропала"));
  }, [renew]);

  // Привязать поток к <video>
  useEffect(() => {
    const v = video.current;
    if (!v || !info || !started) return;
    if (swap.current && hls.current) {
      swap.current = false;
      return;
    }
    swap.current = false;
    remap.current = null;
    let alive = true;
    let disconnectDesktop: (() => void) | undefined;
    const at = info.start;
    startAt.current = at;
    const attach = async () => {
      if (info.desktop) {
        disconnectDesktop = await connectDesktop(info.desktop.lease, value => { if (alive) { setDesktopNet(value); connectionReport.current?.(value); } }, new URLSearchParams(location.search).get("relay") === "1");
        if (!alive) { disconnectDesktop(); return; }
      }
      hls.current?.destroy();
      hls.current = null;
      // hls.js — везде, где есть MSE: свежий Chrome умеет HLS и сам, но со своим буфером и без старта с позиции
      // (чёрный экран на холодной раздаче). Встроенный HLS — только где hls.js не работает (iPhone)
      const { default: H } = info.hls ? await import("hls.js") : { default: null };
      if (!alive) return;
      if (H && H.isSupported()) {
        // Перекодирование первого сегмента — несколько секунд: ждём дольше обычного. Загрузка — сразу с нужной
        // позиции, без пробного первого сегмента (замер скорости): из холодной раздачи это лишние 10–20 МБ
        // Шкала = время файла: Jellyfin пишет метки как в файле, но при копировании видео первый кусок начинается
        // с опорного кадра раньше своего места в плейлисте, а hls.js берёт начало отсчёта от первого куска — и вся
        // шкала (субтитры, главы, OP/ED, позиция) уезжает на секунды. Init-сегмент грузится до разбора первого куска:
        // по нему задаём hls.js начало отсчёта 0 (videoTrackOf — номер и единица времени видеодорожки)
        type InitPts = { baseTime: number; timescale: number; trackId: number };
        let self: { streamController?: { initPTS: (InitPts | undefined)[] } } | null = null;
        type LoadArgs = [{ frag?: { sn: unknown; cc: number } }, unknown, { onSuccess: (r: { data: unknown }, ...rest: unknown[]) => void }];
        const Base = H.DefaultConfig.loader as unknown as new (c: unknown) => { load(...a: LoadArgs): void };
        class FileTimeLoader extends Base {
          load(ctx: LoadArgs[0], cfg: unknown, cb: LoadArgs[2]) {
            const frag = ctx.frag;
            if (frag?.sn !== "initSegment") return super.load(ctx, cfg, cb);
            super.load(ctx, cfg, { ...cb, onSuccess: (r, ...rest) => {
              const sc = self?.streamController;
              const vt = r.data instanceof ArrayBuffer ? videoTrackOf(r.data) : null;
              if (vt && sc && !sc.initPTS[frag.cc]) sc.initPTS[frag.cc] = { baseTime: 0, ...vt };
              cb.onSuccess(r, ...rest);
            } });
          }
        }
        const h = new H({
          fLoader: FileTimeLoader as never,
          autoStartLoad: false, testBandwidth: false, manifestLoadingTimeOut: 30_000,
          // Сессия сменилась на ходу (renew) — кусок просим у новой
          xhrSetup: (xhr, url) => {
            const m = remap.current;
            const n = m && url.includes(m.from) ? /\/(\d+)\.mp4(\?|$)/.exec(url)?.[1] : null;
            if (m && n) xhr.open("GET", `${m.dir}${n}.mp4${remapQuery(m.query, url)}`, true);
          },
          maxBufferLength: 60, backBufferLength: 90,
          // Кусок не пришёл — повторить несколько раз с паузой (Jellyfin мог перезапускать перекодирование)
          fragLoadPolicy: { default: {
            maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          } },
        });
        self = h as unknown as typeof self;
        h.on(H.Events.ERROR, (_e, d) => {
          // Кусок — 404: сессии на сервере больше нет (календарь перезапускался); hls.js сам повторял бы его без конца
          if (d.details === H.ErrorDetails.FRAG_LOAD_ERROR && d.response?.code === 404 && hls.current === h) {
            h.stopLoad();
            sessionLost();
            return;
          }
          if (!d.fatal) return;
          if (d.type === H.ErrorTypes.MEDIA_ERROR) {
            // Браузер заявил HEVC, но не декодирует (так бывает в Electron, без аппаратного ускорения) — H.264
            if (hevcSent.current) {
              store.set(COMPAT_KEY, "1");
              setNotice("Браузер не смог показать HEVC — переключаюсь на H.264 (совместимый режим, запомнен)");
              void open({ audio: info.audioIndex, start: v.currentTime || at });
              return;
            }
            if (recoveries.current++ < 2) { h.recoverMediaError(); return; }
          } else if (d.type === H.ErrorTypes.NETWORK_ERROR) {
            // Тихо: сначала ещё раз с этого места, потом — новая сессия; ошибка — только если и это не помогло
            const n = ++netFails.current;
            if (n <= 2) {
              setTimeout(() => { if (hls.current === h) h.startLoad(v.currentTime || at); }, 2000 * n);
              return;
            }
            if (renewals.current++ < 3) {
              netFails.current = 0;
              void renew();
              return;
            }
          }
          setError(new Error(`Поток прервался: ${d.details}`));
        });
        h.on(H.Events.MANIFEST_PARSED, () => {
          setStage((s) => (s.step === "playing" ? s : { step: "manifest", since: Date.now() }));
          h.startLoad(startAt.current);
        });
        // init-сегмент (без номера) — Jellyfin ещё запускает перекодирование
        h.on(H.Events.FRAG_LOADING, (_e, d) => setStage((s) => (s.step === "playing" || d.frag.sn === "initSegment" ? s : { step: "fragment", since: Date.now(), sn: Number(d.frag.sn), at: d.frag.start })));
        h.on(H.Events.FRAG_LOADED, (_e, d) => {
          netFails.current = 0;
          renewals.current = 0;
          setStage((s) => (s.step === "playing" ? s : {
            ...s, lastMs: Math.round(d.frag.stats.loading.end - d.frag.stats.loading.start), lastBytes: d.frag.stats.total,
          }));
        });
        h.loadSource(info.src);
        h.attachMedia(v);
        hls.current = h;
      } else {
        v.src = info.src;
        v.currentTime = at;
        setStage({ step: "fragment", since: Date.now() });
      }
      v.volume = volume;
      if (!roomRef.current || roomRef.current.state.playing) await playback.current!.setPlaying(true);
    };
    void attach().catch(e => { if (alive) { setError(e); setLoading(false); } });
    return () => { alive = false; disconnectDesktop?.(); };
    // volume — только начальное значение
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, started]);

  // Боковая панель страницы: что открыто и чем управлять
  useEffect(() => { onState?.({ info, sub, subs: { delay: subDelay, size: subSize }, signs, signsState, preparing:!error&&(!info||(started&&loading)), started }); }, [info, sub, subDelay, subSize, signs, signsState, loading, started, error, onState]);

  useEffect(() => () => { hls.current?.destroy(); ass.current?.destroy(); assSigns.current?.destroy(); }, []);

  // Загрузка — по состоянию видео, а не по событиям (Chrome шлёт «playing», пока hls.js ещё не подключил поток):
  // не пауза и нечего показывать — грузится. Сторож: так дольше 20 с — показать состояние и предложить выход
  useEffect(() => {
    const t = setInterval(() => {
      const v = video.current;
      if (!v || !info) return;
      const waiting = !desktopUnavailable && !v.paused && v.readyState < 3;
      setLoading(waiting);
      // Ошибка, а запас ещё играет — ни сторожа, ни состояния (ошибку покажем, когда картинка встанет)
      if (error) return;
      if (!waiting) progressAt.current = Date.now();
      if (!v.paused && v.readyState >= 3) setStage((s) => (s.step === "playing" ? s : { step: "playing", since: Date.now() }));
      setStalled(waiting && Date.now() - progressAt.current > STALL_MS);
    }, 500);
    return () => clearInterval(t);
  }, [info, error, desktopUnavailable]);
  useEffect(() => {
    if (!desktopRoom || !info || !started) return;
    let attemptedAt = 0, ready = false;
    const timer = setInterval(() => {
      const v = video.current; if (!v || ready) return;
      if (v.readyState >= 2) { ready = true; return; }
      if (!v.paused || roomRef.current?.state.playing) attemptedAt ||= Date.now();
      if (attemptedAt && Date.now() - attemptedAt > 35000) { ready = true; setError(new Error("Первый кадр не получен за 35 секунд. Проверьте связь с комнатой и хостом, затем повторите подключение.")); }
    }, 500);
    return () => clearInterval(timer);
  }, [desktopRoom, info, started]);
  // Раздача «Стрима»: скорость, пиры, подготовка и скачанные куски (полоска под шкалой) — раз в 3 с
  const { data: status } = useQuery({
    queryKey: ["play-status", info?.sid],
    queryFn: () => api<PlayStatus>(`/api/play/${info!.sid}`),
    enabled: Boolean(info?.stream),
    refetchInterval: 3000,
  });
  const compat = store.get(COMPAT_KEY) === "1";
  const restart = (useCompat: boolean) => {
    if (useCompat) store.set(COMPAT_KEY, "1");
    void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime || info?.start || 0 });
  };

  // ---------------------------------------------------------------- субтитры
  useEffect(() => {
    const v = video.current;
    ass.current?.destroy();
    ass.current = null;
    if (!v || !info) return;
    const s = info.subs.find((x) => x.index === sub);
    if (!s?.ass) return;
    let alive = true;
    void import("jassub").then(({ default: J }) => {
      if (!alive) return;
      ass.current = new J({
        video: v, subUrl: s.url, fonts: info.fonts, timeOffset: -subDelay,
        workerUrl: "/jassub/jassub-worker.js", wasmUrl: "/jassub/jassub-worker.wasm", modernWasmUrl: "/jassub/jassub-worker-modern.wasm",
        availableFonts: { "liberation sans": "/jassub/default.woff2" }, fallbackFont: "liberation sans",
      });
    });
    return () => { alive = false; };
    // Сдвиг меняется отдельно (ниже) — без пересоздания
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, info]);

  // Слой надписей — по прошлому выбору, если такая дорожка есть (смена озвучки сохраняет выбранную)
  useEffect(() => {
    if (!info) return;
    setSigns((prev) => {
      if (prev !== null && info.subs.some((s) => s.index === prev)) return prev;
      const pref = store.get(SIGNS_KEY);
      if (pref === "translate") return info.subs.find((s) => s.fromSub?.translate)?.index ?? null;
      if (pref === "ru") return info.subs.find((s) => s.signs && s.lang === "rus" && !s.fromSub?.translate)?.index ?? null;
      return null;
    });
  }, [info]);
  useEffect(() => {
    const v = video.current;
    assSigns.current?.destroy();
    assSigns.current = null;
    setSignsState(null);
    const s = info?.subs.find((x) => x.index === signs);
    // Тот же файл, что и основные субтитры, — второй раз не рисуем
    if (!v || !info || !s?.ass || s.index === sub) return;
    let alive = true;
    void (async () => {
      let content: string | undefined;
      if (s.fromSub) {
        // Надписи из полной дорожки собирает сервер (перевод — первый раз до минуты)
        setSignsState("loading");
        try {
          const r = await fetch(s.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          content = await r.text();
          if (r.headers.get("X-Signs-Count") === "0") { if (alive) setSignsState("empty"); return; }
        } catch {
          if (alive) setSignsState("error");
          return;
        }
      }
      const { default: J } = await import("jassub");
      if (!alive) return;
      assSigns.current = new J({
        video: v, ...(content ? { subContent: content } : { subUrl: s.url }), fonts: info.fonts, timeOffset: -subDelay,
        workerUrl: "/jassub/jassub-worker.js", wasmUrl: "/jassub/jassub-worker.wasm", modernWasmUrl: "/jassub/jassub-worker-modern.wasm",
        availableFonts: { "liberation sans": "/jassub/default.woff2" }, fallbackFont: "liberation sans",
      });
      setSignsState("ready");
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signs, info, sub]);

  // Сдвиг субтитров: ASS — timeOffset JASSUB, текстовые — сами реплики (исходное время — в WeakMap)
  const original = useRef(new WeakMap<TextTrackCue, [number, number]>());
  const shiftCues = useCallback(() => {
    const cues = track.current?.track.cues;
    if (!cues) return;
    for (const c of Array.from(cues)) {
      const o = original.current.get(c) ?? [c.startTime, c.endTime];
      original.current.set(c, o);
      c.startTime = o[0] + subDelay;
      c.endTime = o[1] + subDelay;
    }
  }, [subDelay]);
  useEffect(() => {
    const v = video.current;
    for (const a of [ass.current, assSigns.current]) {
      if (!a) continue;
      const j = a as unknown as { timeOffset: number; sendMessage?: (t: string, d: unknown) => void };
      j.timeOffset = -subDelay;
      // JASSUB берёт сдвиг при новом кадре — на паузе кадров нет: перерисовать сразу, чтобы сдвиг был виден вживую
      if (v?.paused) j.sendMessage?.("demand", { time: v.currentTime - subDelay });
    }
    shiftCues();
  }, [subDelay, shiftCues]);
  const changeDelay = (sec: number) => {
    const d = Math.round(sec * 10) / 10;
    setSubDelay(d);
    store.set(delayKey, String(d));
    flash(`Сдвиг субтитров: ${d > 0 ? "+" : ""}${d.toFixed(1).replace(".", ",")} с`);
  };
  const vttSub = info?.subs.find((x) => x.index === sub && !x.ass);

  const chooseSub = (index: number | null) => {
    const s = info?.subs.find((x) => x.index === index);
    setSub(s ? s.index : null);
    const choice = JSON.stringify(subChoiceOf(s));
    store.set(subTitleKey(anilistId), choice);
    // Общий выбор (для тайтлов, где ещё не выбирали) — только с языком: дорожку без языка в другом тайтле не найти
    if (!s || s.lang) store.set(SUB_KEY, choice);
  };
  const chooseSigns = (index: number | null) => {
    const s = info?.subs.find((x) => x.index === index);
    setSigns(s ? s.index : null);
    store.set(SIGNS_KEY, !s ? "off" : s.fromSub?.translate ? "translate" : "ru");
  };
  if (controls) {
    controls.current = {
      diagnostics: () => {
        const v = video.current; if (!v) return null;
        let ahead = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
        return { paused: v.paused, ended: v.ended, seeking: v.seeking, readyState: v.readyState, networkState: v.networkState, currentTime: v.currentTime, bufferedAhead: ahead, playbackRate: v.playbackRate, muted: v.muted, volume: v.volume, errorCode: v.error?.code ?? null, autoplayBlocked, decodedFrames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null };
      },
      setAudio: (i) => { if (i !== info?.audioIndex) void open({ audio: i, start: video.current?.currentTime || info?.start || 0 }); },
      setVoice: (group) => void open({ voice: group, start: video.current?.currentTime || info?.start || 0 }),
      setSub: chooseSub,
      setSigns: chooseSigns,
      setSubDelay: changeDelay,
      setSubSize: (pct) => { setSubSize(pct); store.set("player-sub-size", String(pct)); },
      // Появились новые дорожки (скачали с Jimaku) — та же серия с той же секунды
      reload: () => void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime || info?.start || 0 }),
      position: () => ({ pos: video.current?.currentTime || info?.start || 0, playing: Boolean(video.current && !video.current.paused) }),
    };
  }

  // ---------------------------------------------------------------- позиция на сервер
  const send = useCallback(() => {
    const v = video.current;
    if (!sid.current || !v || !v.currentTime || coverageSid.current !== sid.current) return;
    const played = coverageSid.current === sid.current
      ? Array.from({ length: v.played.length }, (_, i) => [v.played.start(i), v.played.end(i)]) : [];
    const rm = roomRef.current;
    void api<{ marked: boolean }>(`/api/play/${sid.current}`, { method: "POST", json: { pos: v.currentTime, played,
      room: rm?.id && rm.state.session ? { id:rm.id,revision:rm.state.session.revision } : undefined } }).then(onReport)
      // Сессии больше нет (календарь перезапускался) — новая, пока запас ещё играет
      .catch((e: unknown) => { if (/Сессия просмотра закончилась/.test(String((e as Error).message))) sessionLost(); });
  }, [onReport, sessionLost]);
  useEffect(() => {
    const t = setInterval(send, 10_000);
    const hide = () => send();
    window.addEventListener("pagehide", hide);
    window.addEventListener("server-maintenance", hide);
    return () => { clearInterval(t); window.removeEventListener("pagehide", hide); window.removeEventListener("server-maintenance", hide); };
  }, [send]);

  // ---------------------------------------------------------------- управление
  const toggle = useCallback(() => {
    if (!started) { setStarted(true); return; }
    const v = video.current;
    if (!v) return;
    const rm = roomRef.current;
    if (autoplayBlocked && (!rm || rm.state.playing)) { void playback.current!.setPlaying(true, true); return; }
    if (rm) {
      if (rm.state.session && rm.state.session.phase !== "watching") { flash("Используйте управление переходом по плану"); return; }
      if (!rm.canControl) {
        // A viewer may unlock browser autoplay locally without controlling the room.
        if (rm.state.playing && v.paused) void playback.current!.setPlaying(true, true);
        else flash("Управляет организатор комнаты");
        return;
      }
      // Видео ещё не загрузилось — позиция комнаты, а не ноль
      playback.current!.request(v.paused ? "play" : "pause", v.ended ? 0 : v.readyState ? v.currentTime : positionAt(rm.state, rm.serverNow()));
    }
    void playback.current!.setPlaying(v.paused, true);
  }, [started, flash, desktopRoom, autoplayBlocked]);
  const seek = useCallback((to: number) => {
    const v = video.current;
    if (!v) return;
    setFrame(null);
    const rm = roomRef.current;
    if (rm?.state.session && rm.state.session.phase !== "watching") return;
    if (rm && !rm.canControl) { flash("Управляет организатор комнаты"); return; }
    const t = Math.max(0, Math.min(to, (info?.duration || v.duration || to) - 0.5));
    playback.current!.setPosition(t);
    // Время на панели — сразу, не дожидаясь загрузки (timeupdate придёт только после неё)
    setTime(t);
    if (rm) playback.current!.request("seek", t);
  }, [info, flash]);

  // ---------------------------------------------------------------- комната
  // Держаться позиции комнаты: пауза/просмотр как у неё, расхождение — скоростью или перемоткой (lib/room correction)
  useEffect(() => {
    if (!inRoom || !started || !info) return;
    const tick = () => { const d = playback.current!.sync(); if (d !== null) drift.current = Math.round(d * 10) / 10; };
    tick();
    const t = setInterval(tick, 200);
    return () => {
      clearInterval(t);
      if (video.current) video.current.playbackRate = 1;
    };
  }, [inRoom, started, info, room?.state.at, room?.state.playing]);
  // Отчёт комнате: грузится ли (дольше 1 с — комната ждёт), скорость потока, расхождение; раз в 5 с и при перемене
  useEffect(() => {
    if (!inRoom || !started) return;
    let since: number | null = null;
    let was: boolean | null = null;
    const tick = (force: boolean) => {
      const rm = roomRef.current;
      const v = video.current;
      if (!rm || !v) return;
      // Загрузился — когда впереди хотя бы 5 с (иначе комната будет играть по 2 с и снова ждать)
      const b = v.buffered;
      let ahead = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
      setBufferAhead(ahead);
      // Native MP4 buffering is controlled by the browser; on pause it may stop
      // fetching before five seconds. Requiring more would deadlock the barrier.
      const low = autoplayBlocked || v.readyState < 3 || (!desktopRoom && was === true && ahead < 5 && v.currentTime + ahead < (v.duration || Infinity) - 1);
      if (low && !v.ended) since ??= Date.now(); else since = null;
      const buffering = since !== null && (was === true || Date.now() - since > 1000);
      if (!force && buffering === was) return;
      was = buffering;
      const bw = hls.current?.bandwidthEstimate;
      const net = desktopNetRef.current;
      rm.report({ telemetry: { client: /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|FxiOS/.test(navigator.userAgent) ? "safari" : "other", element: controls?.current?.diagnostics?.(), transport: { mode: net?.mode, ice: net?.progress?.ice, channel: net?.progress?.channel, packets: net?.progress?.packets, directBytes: net?.directBytes, relayBytes: net?.relayBytes } }, playbackError: Boolean(error) || desktopUnavailable, buffering, bw: bw && Number.isFinite(bw) ? Math.round(bw) : null, drift: drift.current, position: v.currentTime, buffered: Array.from({ length: Math.min(b.length, 16) }, (_, i) => [b.start(i), b.end(i)] as [number, number]) });
    };
    tick(true);
    const fast = setInterval(() => tick(false), 500);
    const slow = setInterval(() => tick(true), 5000);
    return () => { clearInterval(fast); clearInterval(slow); };
  }, [inRoom, started, desktopRoom, Boolean(error), desktopUnavailable, autoplayBlocked]);
  // Some native MP4 loaders abandon a long-stalled Range response while paused.
  // Retry the same lease only AFTER exhaustion, never during buffered playback.
  useEffect(() => {
    if (!desktopRoom || !started || !info?.desktop || !["direct", "relay"].includes(desktopNet?.mode ?? "")) return;
    const recovery = new DesktopRecovery();
    const timer = setInterval(() => {
      const v = video.current, rm = roomRef.current;
      if (!v || !rm) return;
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      const net = desktopNetRef.current;
      const eligible = !rm.state.playing && rm.state.hold.length > 0 && v.readyState < 3 && !v.ended && ahead <= 0.5 && !autoplayBlocked;
      if (!recovery.observe(Date.now(), eligible, `${net?.progress?.packets ?? 0}:${net?.directBytes ?? 0}:${net?.relayBytes ?? 0}`)) return;
      const target = positionAt(rm.state, rm.serverNow());
      v.load(); v.currentTime = Math.max(0, Math.min(target, (info.duration || Infinity) - 0.1));
    }, 1000);
    return () => clearInterval(timer);
  }, [desktopRoom, started, info, desktopNet?.mode, autoplayBlocked]);
  // Скорость: новый источник (смена озвучки, перезапуск) сбрасывает её к defaultPlaybackRate — ставим оба
  const applySpeed = useCallback(() => {
    const v = video.current;
    if (!v || roomRef.current) return;
    v.defaultPlaybackRate = speed;
    v.playbackRate = speed;
  }, [speed]);
  useEffect(() => applySpeed(), [applySpeed, inRoom, info, started]);
  const changeSpeed = useCallback((s: number) => {
    if (roomRef.current) { flash("В комнате скорость всегда 1× — иначе разойдётесь"); return; }
    setSpeed(s);
    store.set(SPEED_KEY, String(s));
    flash(`Скорость ${speedLabel(s)}`);
  }, [flash]);

  const fullscreen = useCallback(() => {
    const target = fullscreenRoot?.current ?? box.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const native = () => {
      if (v?.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); } catch { flash("Полный экран доступен после начала воспроизведения"); }
      } else flash("Браузер не поддерживает полноэкранный режим");
    };
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (target?.requestFullscreen) void target.requestFullscreen().catch(native);
    else native();
  }, [fullscreenRoot, flash]);
  const setVol = (x: number) => {
    const v = video.current;
    if (!v) return;
    v.volume = x;
    v.muted = x === 0;
    setVolume(x);
    setMuted(x === 0);
    store.set(VOLUME_KEY, String(x));
  };

  useEffect(() => {
    // Следующая серия открылась уже во весь экран (обёртка развёрнута) — сразу в этом виде
    const v = video.current;
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    const onNativeBegin = () => { nativeFullscreen.current = true; setFull(true); };
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const isPiP = () => document.pictureInPictureElement === v || (v as (HTMLVideoElement & { webkitPresentationMode?: string }) | null)?.webkitPresentationMode === "picture-in-picture" || pictureInPicture.current;
    const onNativeEnd = () => {
      nativeFullscreen.current = false; setFull(false); playback.current!.transition();
      // WebKit can announce fullscreen exit before the PiP presentation change.
      clearTimeout(exitTimer); exitTimer = setTimeout(() => playback.current!.endFullscreen(isPiP()), 150);
    };
    const onPiP = () => { pictureInPicture.current = document.pictureInPictureElement === v || (v as (HTMLVideoElement & { webkitPresentationMode?: string }) | null)?.webkitPresentationMode === "picture-in-picture"; };
    const onEnterPiP = () => { pictureInPicture.current = true; };
    const onLeavePiP = () => { pictureInPicture.current = false; };
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    v?.addEventListener("webkitbeginfullscreen", onNativeBegin);
    v?.addEventListener("webkitendfullscreen", onNativeEnd);
    v?.addEventListener("webkitpresentationmodechanged", onPiP);
    v?.addEventListener("enterpictureinpicture", onEnterPiP);
    v?.addEventListener("leavepictureinpicture", onLeavePiP);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      v?.removeEventListener("webkitbeginfullscreen", onNativeBegin);
      v?.removeEventListener("webkitendfullscreen", onNativeEnd);
      clearTimeout(exitTimer);
      v?.removeEventListener("webkitpresentationmodechanged", onPiP);
      v?.removeEventListener("enterpictureinpicture", onEnterPiP);
      v?.removeEventListener("leavepictureinpicture", onLeavePiP);
    };
  }, []);

  useEffect(() => {
    if (!started || !info || !("mediaSession" in navigator)) return;
    return bindMediaSession(navigator.mediaSession, {
      play: () => { const r = roomRef.current; if (r?.state.playing && video.current?.paused) { void playback.current!.setPlaying(true, true); return; } if (r && !r.canControl) return; if (r) playback.current!.request("play", video.current?.currentTime || 0); void playback.current!.setPlaying(true, true); },
      pause: () => { const r = roomRef.current; if (r && !r.canControl) return; if (r) playback.current!.request("pause", video.current?.currentTime || 0); void playback.current!.setPlaying(false); },
      seek, position: () => video.current?.currentTime || 0, duration: () => info.duration || video.current?.duration || 0, rate: () => video.current?.playbackRate || 1, paused: () => video.current?.paused ?? true,
    });
  }, [started, info, seek]);

  // Перевести кадр: пауза (если шло) → сервер берёт кадр у этой секунды, модель со зрением читает надписи
  const translateFrame = useCallback(async () => {
    const v = video.current;
    if (!v || !sid.current || !started) return;
    if (desktopRoom) { flash("Перевод кадра пока доступен только для серверного источника"); return; }
    if (!v.paused) {
      const rm = roomRef.current;
      if (rm && !rm.canControl) { flash("Перевести кадр можно на паузе — паузу ставит организатор"); return; }
      if (rm) playback.current!.request("pause", v.currentTime);
      void playback.current!.setPlaying(false);
    }
    const t = v.currentTime;
    setFrame({ t, items: null });
    try {
      const r = await api<{ items: FrameItem[] }>(`/api/play/${sid.current}/frame`, { method: "POST", json: { t } });
      setFrame((f) => (f?.t === t ? { t, items: r.items } : f));
      if (!r.items.length) { setFrame(null); flash("В кадре надписей не нашлось"); }
    } catch (e) {
      setFrame(null);
      flash(`Не получилось прочитать кадр: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [started, flash, desktopRoom]);

  // Горячие клавиши: пробел/K — пауза, ←/→ — 10 с, ↑/↓ — громкость, F — экран, M — звук, N — следующая, T — перевести кадр,
  // Z/X — субтитры раньше/позже на 0,1 с (с Shift — на 1 с)
  const delayRef = useRef(subDelay);
  delayRef.current = subDelay;
  const changeDelayRef = useRef(changeDelay);
  changeDelayRef.current = changeDelay;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.defaultPrevented || el.closest("input, textarea, select, button, a, [role='button'], [role='checkbox'], [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = video.current;
      if (!v) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") toggle();
      else if (k === "arrowleft") seek(v.currentTime - 10);
      else if (k === "arrowright") seek(v.currentTime + 10);
      else if (k === "arrowup") setVol(Math.min(1, v.volume + 0.1));
      else if (k === "arrowdown") setVol(Math.max(0, v.volume - 0.1));
      else if (k === "f" || k === "а") fullscreen();
      else if (k === "m" || k === "ь") { v.muted = !v.muted; setMuted(v.muted); }
      else if ((k === "n" || k === "т") && next) next.go();
      else if (k === "t" || k === "е") void translateFrame();
      else if (k === "z" || k === "я") changeDelayRef.current(delayRef.current - (e.shiftKey ? 1 : 0.1));
      else if (k === "x" || k === "ч") changeDelayRef.current(delayRef.current + (e.shiftKey ? 1 : 0.1));
      // Shift + < / > — скорость (как на YouTube; в русской раскладке — Б / Ю)
      else if (e.shiftKey && (k === "<" || k === ">" || k === "б" || k === "ю")) {
        const i = SPEEDS.indexOf(speed) + (k === "<" || k === "б" ? -1 : 1);
        if (i >= 0 && i < SPEEDS.length) changeSpeed(SPEEDS[i]);
      }
      else if (k === "escape" && menu) setMenu(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setVol меняется каждый рендер, но читает только video.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggle, seek, fullscreen, next, translateFrame, speed, changeSpeed, menu]);

  // Панель прячется через 3 с без движения мыши (во время просмотра)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 3000);
  };
  const hidden = idle && playing && !menu;

  const duration = info?.duration || video.current?.duration || 0;
  // Отрезок, в котором сейчас идёт серия (кнопка «Пропустить» — до последних 2 с отрезка)
  const seg = started ? info?.segments.find((x) => time >= x.start && time < x.end - 2) : undefined;
  useEffect(() => {
    // В комнате пропускает тот, кто управляет (у остальных перемотка придёт от комнаты)
    if (!seg || !autoSkip || (room && !room.canControl)) return;
    const id = `${seg.kind}:${seg.start}`;
    if (skipped.current.has(id)) return;
    skipped.current.add(id);
    seek(seg.end);
    setNotice(`Пропустил ${SEG_LABEL[seg.kind]}`);
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [seg, autoSkip, seek, room]);
  const pct = (t: number) => `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;

  return (
    <div ref={box} onPointerMove={wake} onPointerDown={wake} onMouseLeave={() => setIdle(true)}
      className={cx("player group relative w-full overflow-hidden bg-black", full ? "h-dvh" : "aspect-video rounded-xl ring-1 ring-gray-700", desktopUnavailable && "min-h-72", hidden && "cursor-none")}>
      {/* Размер текстовых субтитров (реплики <track>) */}
      <style>{`.ac-video::cue { font-size: ${subSize}%; }`}</style>
      <video ref={video} className="ac-video h-full w-full" playsInline preload="auto"
        onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => { setPlaying(true); setFrame(null); playback.current!.nativePlayback(true, nativeActive()); }} onPause={() => { setPlaying(false); send(); playback.current!.nativePlayback(false, nativeActive()); }}
        onSeeked={() => playback.current!.nativeSeek(nativeActive())}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onSeeking={(e) => setTime(e.currentTarget.currentTime)} onLoadedMetadata={() => { coverageSid.current = sid.current; applySpeed(); }}
        onProgress={(e) => { const b = e.currentTarget.buffered; setBuffered(b.length ? b.end(b.length - 1) : 0); }}
        onEnded={(e) => { send(); onEnded?.(e.currentTarget.duration); if (next && !room?.state.session) setCountdown(10); }}>
        {vttSub && <track ref={track} key={vttSub.url} kind="subtitles" src={vttSub.url} srcLang={vttSub.lang ?? "und"} label={vttSub.label} default onLoad={shiftCues} />}
      </video>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 max-h-[calc(100%-5rem)] space-y-2 overflow-y-auto px-3 pt-3">
        <p className={cx("truncate text-sm font-medium text-white/90 drop-shadow-md transition-opacity", hidden && "opacity-0", desktopNet?.mode === "recovering" && "hidden sm:block")}>{title}</p>
      {(desktopNet?.mode === "recovering" || desktopNet?.notice) && <p role="status" className="w-fit max-w-full rounded-lg bg-black/85 px-3 py-2 text-xs text-gray-100">{desktopNet.mode === "recovering" ? desktopNet.reason : desktopNet.notice}</p>}
      {desktopNet && desktopNet.mode !== "recovering" && !hidden && <details className="pointer-events-auto w-fit max-w-full rounded-lg bg-black/80 px-3 py-2 text-xs text-gray-200">
        <summary className="cursor-pointer focus-visible:outline-accent-400">{desktopNet.mode === "direct" ? "С хоста напрямую" : desktopNet.mode === "relay" ? "Через сервер" : desktopNet.mode === "closed" ? "Связь с хостом потеряна" : "Подключаем хост…"}</summary>
        <p className="mt-2">{desktopNet.reason}</p><p className="mt-1 tabular-nums">Запас видео: {bufferAhead.toFixed(1)} с</p><p className="mt-1 tabular-nums">Напрямую: {(desktopNet.directBytes / 1048576).toFixed(1)} МиБ · через сервер: {(desktopNet.relayBytes / 1048576).toFixed(1)} МиБ</p>
      </details>}
      <div className="pointer-events-auto">{children?.(time, seek)}</div>
      </div>

      {!started && <Preview preview={preview} start={info?.start ?? 0} ready={Boolean(info)} onPlay={() => setStarted(true)} />}
      {started && autoplayBlocked && !error && <div className="absolute inset-0 z-30 grid place-content-center gap-3 bg-black/75 p-5 text-center"><p className="text-sm text-gray-200">Браузер ожидает нажатия для запуска видео со звуком</p><button className="min-h-11 rounded-lg bg-gray-800 px-4 py-2 text-sm text-white hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-accent-400" onClick={() => { void playback.current!.setPlaying(true, true).then(() => { if (roomRef.current && !roomRef.current.state.playing) void playback.current!.setPlaying(false); }); }}>Включить видео и звук</button></div>}
      {started && loading && !error && !desktopUnavailable && <div className="pointer-events-none absolute inset-0 grid place-items-center"><Spinner className="h-10 w-10 text-white/80" /></div>}
      {desktopUnavailable && !error && <div role="alert" className="absolute inset-0 z-30 grid place-content-center overflow-y-auto bg-black/95 p-4"><div className="mx-auto max-w-lg space-y-3"><p className="font-medium text-gray-100">Не удалось подключить видеопоток</p><p className="text-sm leading-relaxed text-gray-300">{desktopNet.reason}</p><button className="min-h-11 rounded-lg bg-gray-800 px-4 py-2 text-sm text-gray-100 hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-accent-400" onClick={() => void open({ start: video.current?.currentTime || 0 })}>Повторить подключение</button></div></div>}
      {/* Состояние потока: пока грузится (или по кнопке «i») — что делает Jellyfin и раздача */}
      {desktopRoom && !desktopUnavailable && !error && started && (loading || showStatus || stalled || (desktopNet?.mode === "closed" && !playing)) && <div className="absolute inset-x-4 bottom-20 rounded-lg bg-black/85 p-3 text-sm text-gray-200">
        <p>{desktopNet?.mode === "closed" ? desktopNet.reason : stalled ? "Хост не доставляет видео. Проверьте подключение или выберите другой источник комнаты." : loading ? "Получаем видео с desktop-хоста…" : "Подготовленная копия H.264/AAC · перемотка по файлу"}</p>
        <button className="mt-2 text-accent-200 hover:text-white focus-visible:outline-accent-400" onClick={() => void open({ start: video.current?.currentTime || 0 })}>Переподключиться</button>
        {showStatus && <button className="ml-4 text-gray-400 hover:text-white" onClick={() => setShowStatus(false)}>Закрыть</button>}
      </div>}
      {!desktopRoom && !error && started && (loading || showStatus || stalled) && (
        <StreamStatus status={status} stage={stage} transcode={info?.transcode ?? null} stalled={stalled} compat={compat}
          onRestart={() => restart(false)} onCompat={() => restart(true)} onClose={showStatus ? () => setShowStatus(false) : undefined} />
      )}
      {/* Ошибка — только когда картинка встала: пока идёт запас, плеер восстанавливается молча */}
      {Boolean(error) && (!playing || loading) && <div className="absolute inset-x-6 top-1/3"><ErrorBox error={error} />{desktopRoom && <button className="mt-3 rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700" onClick={() => void open({ start: video.current?.currentTime || 0 })}>Повторить подключение</button>}</div>}
      {frame && <FrameLayer frame={frame} video={video.current} />}
      {seg && !autoSkip && (
        <button onClick={() => { skipped.current.add(`${seg.kind}:${seg.start}`); seek(seg.end); }}
          className="absolute bottom-24 right-4 z-30 rounded-lg bg-black/80 px-4 py-2.5 text-sm font-medium text-white shadow-xl ring-1 ring-white/20 hover:bg-black/90">
          Пропустить {SEG_LABEL[seg.kind]} ›
        </button>
      )}
      {countdown !== null && next && (
        <div className="absolute bottom-24 right-4 z-30 w-72 space-y-2 rounded-xl bg-black/85 p-4 text-sm text-white shadow-2xl ring-1 ring-white/10">
          <p className="text-gray-300">Следующая — <b className="text-white">{next.label}</b> через {countdown} с</p>
          <div className="h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full bg-accent-400 transition-all duration-1000 ease-linear" style={{ width: `${(1 - countdown / 10) * 100}%` }} /></div>
          <div className="flex gap-2">
            <button onClick={() => next.go()} className="flex-1 rounded-md bg-accent-500 px-3 py-1.5 font-medium hover:bg-accent-400">Смотреть сейчас</button>
            <button onClick={() => setCountdown(null)} className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20">Отмена</button>
          </div>
        </div>
      )}
      {notice && (
        <div className="absolute inset-x-0 bottom-20 z-20 mx-auto w-fit max-w-[90%] rounded-lg bg-black/80 px-3 py-2 text-sm text-warning-200 ring-1 ring-white/10">
          {notice} <button onClick={() => setNotice(null)} className="ml-2 text-gray-400 hover:text-white">×</button>
        </div>
      )}


      {/* Панель управления */}
      <div className={cx("absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/85 to-transparent px-3 pb-2 pt-10 transition-opacity", hidden && "pointer-events-none opacity-0")}>
        <SeekBar duration={duration} time={time} buffered={buffered} chapters={info?.chapters ?? []} onSeek={seek} pct={pct}
          cached={status?.stream?.cached ?? []} trick={info?.trickplay ?? null} segments={info?.segments ?? []} video={video} />
        <div className="player-controls mt-1 flex items-center gap-1 text-white">
          <Ctl onClick={toggle} label={playing ? "Пауза (пробел)" : "Смотреть (пробел)"}>
            {playing ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
          </Ctl>
          <Ctl onClick={() => seek(time - 10)} label="Назад 10 с (←)"><BackwardIcon className="h-5 w-5" /></Ctl>
          <Ctl onClick={() => seek(time + 10)} label="Вперёд 10 с (→)"><ForwardIcon className="h-5 w-5" /></Ctl>
          <div className="hidden lg:contents"><Ctl onClick={() => setVol(muted || volume === 0 ? 1 : 0)} label="Звук (M)">
            {muted || volume === 0 ? <SpeakerXMarkIcon className="h-5 w-5" /> : <SpeakerWaveIcon className="h-5 w-5" />}
          </Ctl></div>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVol(Number(e.target.value))}
            aria-label="Громкость" className="hidden w-20 accent-white lg:block" />
          <span className="player-time ml-1 shrink-0 whitespace-nowrap text-[10px] tabular-nums text-white/80 lg:ml-2 lg:text-xs">{clock(time)} / {clock(duration)}</span>
          <span className="flex-1" />
          {next && (
            <button onClick={next.go} className="hidden rounded-md px-2 py-1 text-xs font-medium text-white/90 hover:bg-white/15 lg:block" title="Следующая серия (N)">
              {next.label} ›
            </button>
          )}
          <Settings open={menu} onToggle={() => setMenu(!menu)} onClose={() => setMenu(false)} info={info} sub={sub}
            mobileActions={<>
              <Row label="Звук" value={muted || volume === 0 ? "Выключен" : "Включён"} onClick={() => setVol(muted || volume === 0 ? 1 : 0)} />
              {next && <Row label="Следующая серия" value={next.label} onClick={next.go} />}
              {started && !desktopRoom && <Row label="Перевести надписи в кадре" value="" onClick={() => { setMenu(false); void translateFrame(); }} />}
              <Row label="Состояние потока" value="" onClick={() => { setMenu(false); setShowStatus((x) => !x); }} />
            </>}
            speed={inRoom ? 1 : speed} speedLocked={inRoom} onSpeed={changeSpeed}
            quality={Number(store.get(QUALITY_KEY)) || 0} compat={compat} autoSkip={autoSkip} delay={subDelay}
            onQuality={(v) => { store.set(QUALITY_KEY, String(v)); void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime ?? 0 }); }}
            // Совместимый режим — видео всегда в H.264 (если HEVC в браузере показывает чёрный экран)
            onCompat={() => { store.set(COMPAT_KEY, compat ? "0" : "1"); void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime ?? 0 }); }}
            onAutoSkip={() => { store.set(AUTOSKIP_KEY, autoSkip ? "0" : "1"); setAutoSkip(!autoSkip); }}
            onAudio={(i) => { if (info && i !== info.audioIndex) void open({ audio: i, start: video.current?.currentTime ?? 0 }); }}
            onSub={chooseSub} onDelay={changeDelay} />
          <div className="hidden lg:contents">{started && !desktopRoom && <Ctl onClick={() => void translateFrame()} label="Перевести надписи в кадре (T)"><ViewfinderCircleIcon className="h-5 w-5" /></Ctl>}</div>
          <div className="hidden lg:contents"><Ctl onClick={() => setShowStatus((x) => !x)} label="Состояние потока"><InformationCircleIcon className="h-5 w-5" /></Ctl></div>
          <Ctl onClick={fullscreen} label="Во весь экран (F)">
            {full ? <ArrowsPointingInIcon className="h-5 w-5" /> : <ArrowsPointingOutIcon className="h-5 w-5" />}
          </Ctl>
        </div>
      </div>
    </div>
  );
}

/** Превью серии до нажатия ▶: кадр, название, описание, «продолжить с …». */
function Preview({ preview, start, ready, onPlay }: {
  preview?: { still: string | null; heading: string; text: string | null }; start: number; ready: boolean; onPlay: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 cursor-pointer" onClick={onPlay}>
      {preview?.still && <img src={imgSrc(preview.still)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/50 to-black/20" />
      <div className="absolute inset-0 grid place-items-center">
        <button aria-label="Смотреть" className="grid h-20 w-20 place-items-center rounded-full bg-accent-500/90 text-white shadow-2xl ring-4 ring-white/20 transition hover:scale-105 hover:bg-accent-400">
          <PlayIcon className="ml-1 h-10 w-10" />
        </button>
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-3 sm:p-8">
        {preview && <p className="truncate text-sm font-semibold text-white sm:text-2xl">{preview.heading}</p>}
        {preview?.text && <p className="hidden line-clamp-3 max-w-3xl text-sm text-gray-200 sm:block sm:text-base">{preview.text}</p>}
        <p className="text-sm text-gray-300">
          {start > 5 ? `Продолжить с ${clock(start)}` : ready ? "С начала" : "Готовлю поток…"}
        </p>
      </div>
    </div>
  );
}

function Ctl({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-white/90 hover:bg-white/15 hover:text-white">
      {children}
    </button>
  );
}

type SettingsPage = "main" | "speed" | "quality" | "audio" | "sub";

/**
 * Настройки плеера одной панелью (как на YouTube): главная — строки с текущим значением, по нажатию — список;
 * переключатели — на главной. Закрывается кнопкой, Esc или щелчком мимо.
 */
function Settings({ open, onToggle, onClose, info, sub, speed, speedLocked, onSpeed, quality, compat, autoSkip, delay,
  onQuality, onCompat, onAutoSkip, onAudio, onSub, onDelay, mobileActions }: {
  mobileActions?: React.ReactNode;
  open: boolean; onToggle: () => void; onClose: () => void; info: PlayInfo | null; sub: number | null;
  speed: number; speedLocked: boolean; onSpeed: (s: number) => void;
  quality: number; compat: boolean; autoSkip: boolean; delay: number;
  onQuality: (v: number) => void; onCompat: () => void; onAutoSkip: () => void;
  onAudio: (i: number) => void; onSub: (i: number | null) => void; onDelay: (sec: number) => void;
}) {
  const [page, setPage] = useState<SettingsPage>("main");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setPage("main"); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onClose]);

  const audio = info?.audio.find((a) => a.index === info.audioIndex);
  const subs = info?.subs.filter((s) => !s.fromSub) ?? [];
  const subNow = subs.find((s) => s.index === sub);
  const subLabel = (s: PlayInfo["subs"][number]) => `${s.label}${s.signs ? " (надписи)" : ""}`;
  const pick = (fn: () => void) => { fn(); setPage("main"); };

  return (
    <div ref={root} className="player-settings relative shrink-0">
      <Ctl onClick={onToggle} label="Настройки"><Cog6ToothIcon className={cx("h-5 w-5 transition-transform", open && "rotate-45")} /></Ctl>
      {open && (
        <div className="player-settings-menu absolute bottom-11 right-0 z-10 max-h-[min(24rem,70dvh)] w-72 overflow-y-auto overscroll-contain rounded-lg bg-gray-900/95 p-1 text-sm text-gray-100 shadow-xl ring-1 ring-gray-700">
          {page === "main" && (
            <>
              <div className="lg:hidden">{mobileActions}</div>
              <Row label="Скорость" value={speedLocked ? "1× · в комнате" : speedLabel(speed)} onClick={speedLocked ? undefined : () => setPage("speed")} />
              <Row label="Качество" value={`${QUALITIES.find((q) => q.value === quality)?.label ?? "Авто"}${compat ? " · H.264" : ""}`} onClick={() => setPage("quality")} />
              {info && info.audio.length > 1 && <Row label="Озвучка" value={audio?.label ?? "—"} onClick={() => setPage("audio")} />}
              {subs.length > 0 && <Row label="Субтитры" value={subNow ? subLabel(subNow) : "Выключены"} onClick={() => setPage("sub")} />}
              <div className="my-1 border-t border-gray-700/70" />
              <Switch label="Пропускать опенинг и эндинг" on={autoSkip} onClick={onAutoSkip} />
              <Switch label="Совместимый режим (H.264)" hint="Если вместо картинки чёрный экран" on={compat} onClick={onCompat} />
              {info && info.transcode.length > 0 && (
                <p className="px-2.5 pb-1 pt-2 text-[11px] text-gray-500">Jellyfin перекодирует: {info.transcode.join(", ")}</p>
              )}
            </>
          )}
          {page === "speed" && (
            <Sub title="Скорость" onBack={() => setPage("main")}>
              {SPEEDS.map((s) => <Item key={s} label={s === 1 ? "Обычная" : speedLabel(s)} active={s === speed} onClick={() => pick(() => onSpeed(s))} />)}
            </Sub>
          )}
          {page === "quality" && (
            <Sub title="Качество" onBack={() => setPage("main")}>
              {QUALITIES.map((q) => <Item key={q.value} label={q.label} active={q.value === quality} onClick={() => pick(() => { if (q.value !== quality) onQuality(q.value); })} />)}
            </Sub>
          )}
          {page === "audio" && info && (
            <Sub title="Озвучка" onBack={() => setPage("main")}>
              {info.audio.map((a) => <Item key={a.index} label={a.label} active={a.index === info.audioIndex} onClick={() => pick(() => onAudio(a.index))} />)}
            </Sub>
          )}
          {page === "sub" && (
            <Sub title="Субтитры" onBack={() => setPage("main")}>
              <Item label="Выключены" active={sub === null} onClick={() => pick(() => onSub(null))} />
              {subs.map((s) => <Item key={s.index} label={subLabel(s)} active={s.index === sub} onClick={() => pick(() => onSub(s.index))} />)}
              {sub !== null && (
                <div className="mt-1 flex items-center gap-1 border-t border-gray-700/70 px-2.5 pt-2" title="Z / X — на 0,1 с, с Shift — на 1 с">
                  <span className="flex-1 text-gray-300">Сдвиг</span>
                  <button onClick={() => onDelay(delay - 0.1)} className="rounded px-2 py-0.5 hover:bg-gray-700/70" aria-label="Раньше на 0,1 с">−</button>
                  <span className="w-14 text-center tabular-nums">{delay > 0 ? "+" : ""}{delay.toFixed(1).replace(".", ",")} с</span>
                  <button onClick={() => onDelay(delay + 0.1)} className="rounded px-2 py-0.5 hover:bg-gray-700/70" aria-label="Позже на 0,1 с">+</button>
                </div>
              )}
            </Sub>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-gray-700/70 disabled:hover:bg-transparent">
      <span className="shrink-0">{label}</span>
      <span className="ml-auto min-w-0 truncate text-gray-400" title={value}>{value}</span>
      {onClick && <ChevronRightIcon className="h-4 w-4 shrink-0 text-gray-500" />}
    </button>
  );
}

function Switch({ label, hint, on, onClick }: { label: string; hint?: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-gray-700/70">
      <span className="min-w-0 flex-1">
        {label}
        {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
      </span>
      <span className={cx("relative h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent-500" : "bg-gray-600")}>
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-4.5" : "left-0.5")} />
      </span>
    </button>
  );
}

function Sub({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <>
      <button onClick={onBack} className="mb-1 flex w-full items-center gap-1.5 rounded-md border-b border-gray-700/70 px-1.5 py-2 text-left font-medium hover:bg-gray-700/70">
        <ChevronLeftIcon className="h-4 w-4 text-gray-400" />{title}
      </button>
      {children}
    </>
  );
}

function Item({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-gray-700/70", active && "text-accent-300")}>
      <CheckIcon className={cx("h-4 w-4 shrink-0", !active && "invisible")} />
      <span className="min-w-0">{label}</span>
    </button>
  );
}

function SeekBar({ duration, time, buffered, chapters, onSeek, pct, cached, trick, segments, video }: {
  duration: number; time: number; buffered: number; chapters: { name: string; start: number }[];
  /** Скачано TorrServer — доли файла (серия «Стрима»); куда можно перематывать без ожидания */
  cached: [number, number][];
  /** Миниатюры (trickplay Jellyfin или свои у скачанной серии) — кадр над подсказкой времени */
  trick: PlayInfo["trickplay"];
  segments: PlayInfo["segments"];
  onSeek: (t: number) => void; pct: (t: number) => string;
  /** Позиция берётся прямо из видео каждый кадр — без перерисовки плеера (timeupdate приходит ~4 раза в секунду) */
  video: React.RefObject<HTMLVideoElement | null>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Тянем головку: позиция — под пальцем, перемотка — когда отпустили
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const v = video.current;
      const t = dragRef.current ?? (v && Number.isFinite(v.currentTime) && v.readyState > 0 ? v.currentTime : timeRef.current);
      const w = `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;
      if (fill.current) fill.current.style.width = w;
      if (head.current) head.current.style.left = w;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [duration, video]);
  const point = drag ?? hover;
  const chapterAt = (t: number) => [...chapters].reverse().find((c) => c.start <= t)?.name;
  // Подсказка у края шкалы не уходит за рамку плеера: центр — не ближе половины её ширины к краю
  const tip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = tip.current, b = bar.current;
    if (!el || !b || point === null || !duration) return;
    const W = b.clientWidth, w = el.offsetWidth;
    el.style.left = `${Math.max(w / 2, Math.min(W - w / 2, (point / duration) * W))}px`;
  }, [point, duration]);
  const dragging = drag !== null;
  return (
    <div ref={bar} className="group/bar relative h-5 cursor-pointer touch-none select-none" role="slider" aria-label="Перемотка" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time}
      onPointerDown={(e) => {
        if (e.button !== 0 || !duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = at(e.clientX);
        dragRef.current = t;
        setDrag(t);
      }}
      onPointerMove={(e) => {
        const t = at(e.clientX);
        if (dragRef.current !== null) { dragRef.current = t; setDrag(t); }
        else if (e.pointerType === "mouse") setHover(t);
      }}
      onPointerUp={(e) => {
        if (dragRef.current === null) return;
        const t = at(e.clientX);
        dragRef.current = null;
        setDrag(null);
        onSeek(t);
      }}
      onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
      onPointerLeave={() => setHover(null)}>
      <div className={cx("absolute inset-x-0 top-2 h-1 rounded-full bg-white/25 transition-[height,top] duration-100 group-hover/bar:top-1.5 group-hover/bar:h-2", dragging && "top-1.5 h-2")}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: pct(buffered) }} />
        <div ref={fill} className="absolute inset-y-0 left-0 rounded-full bg-accent-400" />
        {/* Опенинг и эндинг — отмечены на шкале */}
        {segments.map((sg) => (
          <span key={sg.kind + sg.start} title={SEG_LABEL[sg.kind]} className="absolute inset-y-0 bg-warning-300/45"
            style={{ left: pct(sg.start), width: `${duration ? ((sg.end - sg.start) / duration) * 100 : 0}%` }} />
        ))}
        {/* Скачанное с торрента — полоска под шкалой */}
        {cached.map(([a, b]) => (
          <span key={a} className="absolute -bottom-1.5 h-0.5 rounded-full bg-accent-500/70" style={{ left: `${a * 100}%`, width: `${Math.max(0.2, (b - a) * 100)}%` }} />
        ))}
        {chapters.filter((c) => c.start > 0).map((c) => (
          <span key={c.start} className="absolute inset-y-0 w-0.5 bg-black/60" style={{ left: pct(c.start) }} />
        ))}
      </div>
      {/* Головка: появляется при наведении, при перетаскивании — крупнее */}
      <span ref={head} className={cx("pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-300 shadow ring-2 ring-black/30 transition-transform duration-100",
        dragging ? "scale-125" : "scale-0 group-hover/bar:scale-100")} />
      {point !== null && trick && <TrickThumb trick={trick} t={point} left={pct(point)} />}
      {point !== null && (
        <span ref={tip} className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs text-white" style={{ left: pct(point) }}>
          {clock(point)}{chapterAt(point) ? ` · ${chapterAt(point)}` : ""}
        </span>
      )}
    </div>
  );
}

/** Кадр на шкале из плитки trickplay: номер кадра → плитка и место в ней. */
function TrickThumb({ trick, t, left }: { trick: NonNullable<PlayInfo["trickplay"]>; t: number; left: string }) {
  const per = trick.cols * trick.rows;
  const i = Math.min(trick.count - 1, Math.floor((t * 1000) / trick.interval));
  const tile = Math.floor(i / per);
  const x = (i % per) % trick.cols;
  const y = Math.floor((i % per) / trick.cols);
  const w = 176;
  const h = Math.round((w * trick.height) / trick.width);
  const k = w / trick.width;
  return (
    <span className="pointer-events-none absolute -translate-x-1/2 overflow-hidden rounded-md shadow-xl ring-1 ring-white/20"
      style={{ left: `clamp(${w / 2}px, ${left}, calc(100% - ${w / 2}px))`, bottom: 40, width: w, height: h, backgroundImage: `url(${trick.url}/${tile}.jpg)`,
        backgroundSize: `${trick.cols * w}px ${trick.rows * trick.height * k}px`, backgroundPosition: `-${x * w}px -${y * trick.height * k}px` }} />
  );
}

/** Надписи кадра с переводом поверх видео: рамки — в долях 0–1000 кадра, кадр вписан в плеер с полями. */
function FrameLayer({ frame, video }: { frame: { t: number; items: FrameItem[] | null }; video: HTMLVideoElement | null }) {
  if (!frame.items) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-12 z-20 mx-auto flex w-fit items-center gap-2 rounded-lg bg-black/80 px-3 py-1.5 text-sm text-white ring-1 ring-white/10">
        <Spinner className="h-4 w-4" /> Читаю надписи в кадре…
      </div>
    );
  }
  // Где на самом деле кадр внутри <video> (object-contain: поля сверху/снизу или по бокам)
  const cw = video?.clientWidth ?? 0, ch = video?.clientHeight ?? 0;
  const vw = video?.videoWidth || 16, vh = video?.videoHeight || 9;
  const s = Math.min(cw / vw, ch / vh) || 0;
  const w = vw * s, h = vh * s;
  return (
    <div className="pointer-events-none absolute z-20" style={{ left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h }}>
      {frame.items.map((it, i) => {
        const [x1, y1, x2, y2] = it.box;
        const low = y2 > 800;
        return (
          <div key={i} className="absolute rounded ring-2 ring-accent-400/90" title={it.text}
            style={{ left: `${x1 / 10}%`, top: `${y1 / 10}%`, width: `${(x2 - x1) / 10}%`, height: `${(y2 - y1) / 10}%` }}>
            <span className={cx("absolute left-0 max-w-[28rem] rounded-md bg-black/85 px-2 py-1 text-sm leading-snug text-white shadow-lg ring-1 ring-white/10", low ? "bottom-full mb-1" : "top-full mt-1")}>
              {it.ru}
            </span>
          </div>
        );
      })}
    </div>
  );
}
