"use client";
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, BackwardIcon, ChatBubbleBottomCenterTextIcon, Cog6ToothIcon, ForwardIcon,
  InformationCircleIcon, LanguageIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon,
} from "@heroicons/react/24/solid";
import type Hls from "hls.js";
import type JASSUB from "jassub";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { COMPAT_KEY, type PlayCaps, type PlayInfo, type PlayStatus } from "@/lib/player";
import { cx, ErrorBox, Spinner } from "../ui";
import { StreamStatus, type Stage } from "./StreamStatus";

// Плеер серии: поток Jellyfin через календарь (HLS — hls.js, Safari — сам), ASS — JASSUB (libass в браузере,
// шрифты из вложений файла), остальные субтитры — <track> (Jellyfin отдаёт их как WebVTT). Смена озвучки — новая
// сессия с той же позиции (Jellyfin перекодирует звук под выбранную дорожку). Позиция — на сервер раз в 10 с.

const QUALITY_KEY = "player-bitrate";
const VOLUME_KEY = "player-volume";
const SUB_KEY = "player-sub-lang";
const QUALITIES = [
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
 * Что браузер декодирует сам (HEVC 10 бит — Chrome/Edge с аппаратным декодером, Safari).
 * Совместимый режим — всегда H.264: браузер может заявлять HEVC, а показывать чёрный экран.
 */
function detectCaps(): PlayCaps {
  const ok = (c: string) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`);
  const compat = store.get(COMPAT_KEY) === "1";
  return { hevc: !compat && ok("hvc1.2.4.L120.B0"), av1: !compat && ok("av01.0.08M.10"), maxBitrate: Number(store.get(QUALITY_KEY)) || 120e6 };
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
export type PlayerControls = {
  setAudio: (index: number) => void;
  setSub: (index: number | null) => void;
  /** Сдвиг субтитров, с: плюс — позже (тайминг другого релиза) */
  setSubDelay: (sec: number) => void;
  /** Размер текстовых субтитров, % (ASS рисуется стилями файла) */
  setSubSize: (pct: number) => void;
  reload: () => void;
};
export type SubSettings = { delay: number; size: number };

export function Player({ anilistId, ep, title, onEnded, next, onReport, children, autoPlay, preview, onState, controls }: {
  anilistId: number;
  ep: number;
  title: string;
  /** Сразу смотреть (автопереход); иначе — превью серии и кнопка ▶ (сессия Jellyfin готовится заранее) */
  autoPlay?: boolean;
  preview?: { still: string | null; heading: string; text: string | null };
  /** Сессия и выбранные субтитры — для боковой панели */
  onState?: (s: { info: PlayInfo | null; sub: number | null; subs: SubSettings }) => void;
  controls?: React.MutableRefObject<PlayerControls | null>;
  /** Досмотрели до конца — следующая серия (если есть) */
  onEnded?: () => void;
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
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(store.get(VOLUME_KEY) ?? 1));
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<"audio" | "sub" | "quality" | null>(null);
  const [sub, setSub] = useState<number | null>(null);
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
  // HEVC заявлен в этой сессии (видео идёт как есть) и сколько раз уже восстанавливались после сбоя
  const hevcSent = useRef(false);
  const recoveries = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  // До нажатия ▶ — превью: сессия уже открыта (Jellyfin прочитал файл), поток не запрошен
  const [started, setStarted] = useState(Boolean(autoPlay));
  // Серия кончилась — отсчёт до следующей (отменяется)
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) { next?.go(); return; }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, next]);

  // ---------------------------------------------------------------- сессия и поток
  const open = useCallback(async (opts: { audio?: number | null; start?: number | null } = {}) => {
    setLoading(true);
    setError(null);
    setStalled(false);
    progressAt.current = Date.now();
    setStage({ step: "session", since: Date.now() });
    try {
      const caps = detectCaps();
      // Браузер не играет даже H.264 + AAC (встроенный просмотрщик VS Code — Electron без этих кодеков): сказать сразу
      if (!canPlayBasic()) throw new Error("Этот просмотрщик не умеет видео H.264/AAC (например, встроенный браузер VS Code) — откройте страницу в Chrome, Edge или Firefox");
      const r = await api<PlayInfo>("/api/play", { method: "POST", json: { anilistId, ep, caps, ...opts, replace: sid.current } });
      hevcSent.current = caps.hevc;
      recoveries.current = 0;
      sid.current = r.sid;
      setInfo(r);
      // Выбор субтитров запоминается по языку (русские / английские / выкл.)
      const lang = store.get(SUB_KEY);
      const byLang = lang === "off" ? null : lang ? r.subs.find((s) => s.lang === lang && !s.signs)?.index ?? r.subIndex : r.subIndex;
      setSub((prev) => (opts.audio !== undefined ? prev : byLang));
    } catch (e) {
      setError(e);
      setLoading(false);
    }
  }, [anilistId, ep]);

  useEffect(() => {
    void open();
    const v = video.current;
    return () => {
      // Закрыли плеер — запомнить, где остановились, и остановить перекодирование
      if (sid.current) {
        void fetch(`/api/play/${sid.current}`, {
          method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pos: v?.currentTime ?? 0 }),
        });
      }
      sid.current = null;
    };
  }, [open]);

  // Привязать поток к <video>
  useEffect(() => {
    const v = video.current;
    if (!v || !info || !started) return;
    let alive = true;
    const at = info.start;
    const attach = async () => {
      hls.current?.destroy();
      hls.current = null;
      // hls.js — везде, где есть MSE: свежий Chrome умеет HLS и сам, но со своим буфером и без старта с позиции
      // (чёрный экран на холодной раздаче). Встроенный HLS — только где hls.js не работает (iPhone)
      const { default: H } = info.hls ? await import("hls.js") : { default: null };
      if (!alive) return;
      if (H && H.isSupported()) {
        // Перекодирование первого сегмента — несколько секунд: ждём дольше обычного. Загрузка — сразу с нужной
        // позиции, без пробного первого сегмента (замер скорости): из холодной раздачи это лишние 10–20 МБ
        const h = new H({
          autoStartLoad: false, testBandwidth: false, manifestLoadingTimeOut: 30_000, fragLoadingTimeOut: 60_000,
          maxBufferLength: 60, backBufferLength: 90,
        });
        h.on(H.Events.ERROR, (_e, d) => {
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
          } else if (d.type === H.ErrorTypes.NETWORK_ERROR && recoveries.current++ < 2) {
            h.startLoad(v.currentTime || at);
            return;
          }
          setError(new Error(`Поток прервался: ${d.details}`));
        });
        h.on(H.Events.MANIFEST_PARSED, () => {
          setStage({ step: "manifest", since: Date.now() });
          h.startLoad(at);
        });
        // init-сегмент (без номера) — Jellyfin ещё запускает перекодирование
        h.on(H.Events.FRAG_LOADING, (_e, d) => setStage((s) => (s.step === "playing" || d.frag.sn === "initSegment" ? s : { step: "fragment", since: Date.now(), sn: Number(d.frag.sn), at: d.frag.start })));
        h.on(H.Events.FRAG_LOADED, (_e, d) => setStage((s) => (s.step === "playing" ? s : {
          ...s, lastMs: Math.round(d.frag.stats.loading.end - d.frag.stats.loading.start), lastBytes: d.frag.stats.total,
        })));
        h.loadSource(info.src);
        h.attachMedia(v);
        hls.current = h;
      } else {
        v.src = info.src;
        v.currentTime = at;
        setStage({ step: "fragment", since: Date.now() });
      }
      v.volume = volume;
      await v.play().catch(() => undefined);
    };
    void attach();
    return () => { alive = false; };
    // volume — только начальное значение
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, started]);

  // Боковая панель страницы: что открыто и чем управлять
  useEffect(() => { onState?.({ info, sub, subs: { delay: subDelay, size: subSize } }); }, [info, sub, subDelay, subSize, onState]);

  useEffect(() => () => { hls.current?.destroy(); ass.current?.destroy(); }, []);

  // Загрузка — по состоянию видео, а не по событиям (Chrome шлёт «playing», пока hls.js ещё не подключил поток):
  // не пауза и нечего показывать — грузится. Сторож: так дольше 20 с — показать состояние и предложить выход
  useEffect(() => {
    const t = setInterval(() => {
      const v = video.current;
      if (!v || !info || error) return;
      const waiting = !v.paused && v.readyState < 3;
      setLoading(waiting);
      if (!waiting) progressAt.current = Date.now();
      if (!v.paused && v.readyState >= 3) setStage((s) => (s.step === "playing" ? s : { step: "playing", since: Date.now() }));
      setStalled(waiting && Date.now() - progressAt.current > STALL_MS);
    }, 500);
    return () => clearInterval(t);
  }, [info, error]);
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
    if (ass.current) (ass.current as unknown as { timeOffset: number }).timeOffset = -subDelay;
    shiftCues();
  }, [subDelay, shiftCues]);
  const vttSub = info?.subs.find((x) => x.index === sub && !x.ass);

  const chooseSub = (index: number | null) => {
    const s = info?.subs.find((x) => x.index === index);
    setSub(s ? s.index : null);
    if (!s || !s.signs) store.set(SUB_KEY, s?.lang ?? "off");
  };
  if (controls) {
    controls.current = {
      setAudio: (i) => { if (i !== info?.audioIndex) void open({ audio: i, start: video.current?.currentTime || info?.start || 0 }); },
      setSub: chooseSub,
      setSubDelay: (sec) => { const d = Math.round(sec * 10) / 10; setSubDelay(d); store.set(delayKey, String(d)); },
      setSubSize: (pct) => { setSubSize(pct); store.set("player-sub-size", String(pct)); },
      // Появились новые дорожки (скачали с Jimaku) — та же серия с той же секунды
      reload: () => void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime || info?.start || 0 }),
    };
  }

  // ---------------------------------------------------------------- позиция на сервер
  const send = useCallback(() => {
    const v = video.current;
    if (!sid.current || !v || !v.currentTime) return;
    void api<{ marked: boolean }>(`/api/play/${sid.current}`, { method: "POST", json: { pos: v.currentTime } }).then(onReport).catch(() => undefined);
  }, [onReport]);
  useEffect(() => {
    const t = setInterval(send, 10_000);
    const hide = () => send();
    window.addEventListener("pagehide", hide);
    return () => { clearInterval(t); window.removeEventListener("pagehide", hide); };
  }, [send]);

  // ---------------------------------------------------------------- управление
  const toggle = useCallback(() => {
    if (!started) { setStarted(true); return; }
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, [started]);
  const seek = useCallback((to: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(to, (info?.duration || v.duration || to) - 0.5));
  }, [info]);
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  }, []);
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
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Горячие клавиши: пробел/K — пауза, ←/→ — 10 с, ↑/↓ — громкость, F — экран, M — звук, N — следующая
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
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
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setVol меняется каждый рендер, но читает только video.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggle, seek, fullscreen, next]);

  // Панель прячется через 3 с без движения мыши (во время просмотра)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 3000);
  };
  const hidden = idle && playing && !menu;

  const duration = info?.duration || video.current?.duration || 0;
  const pct = (t: number) => `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;

  return (
    <div ref={box} onMouseMove={wake} onMouseLeave={() => setIdle(true)}
      className={cx("group relative w-full overflow-hidden bg-black", full ? "h-screen" : "aspect-video rounded-xl ring-1 ring-gray-700", hidden && "cursor-none")}>
      {/* Размер текстовых субтитров (реплики <track>) */}
      <style>{`.ac-video::cue { font-size: ${subSize}%; }`}</style>
      <video ref={video} className="ac-video h-full w-full" playsInline
        onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); send(); }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onProgress={(e) => { const b = e.currentTarget.buffered; setBuffered(b.length ? b.end(b.length - 1) : 0); }}
        onEnded={() => { onEnded?.(); if (next) setCountdown(10); }}>
        {vttSub && <track ref={track} key={vttSub.url} kind="subtitles" src={vttSub.url} srcLang={vttSub.lang ?? "und"} label={vttSub.label} default onLoad={shiftCues} />}
      </video>

      {!started && <Preview preview={preview} start={info?.start ?? 0} ready={Boolean(info)} onPlay={() => setStarted(true)} />}
      {started && loading && !error && <div className="pointer-events-none absolute inset-0 grid place-items-center"><Spinner className="h-10 w-10 text-white/80" /></div>}
      {/* Состояние потока: пока грузится (или по кнопке «i») — что делает Jellyfin и раздача */}
      {!error && started && (loading || showStatus || stalled) && (
        <StreamStatus status={status} stage={stage} transcode={info?.transcode ?? null} stalled={stalled} compat={compat}
          onRestart={() => restart(false)} onCompat={() => restart(true)} onClose={showStatus ? () => setShowStatus(false) : undefined} />
      )}
      {Boolean(error) && <div className="absolute inset-x-6 top-1/3"><ErrorBox error={error} /></div>}
      {children?.(time, seek)}
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

      {/* Заголовок */}
      <div className={cx("pointer-events-none absolute inset-x-0 top-0 z-10 bg-linear-to-b from-black/70 to-transparent px-4 pb-8 pt-3 transition-opacity", hidden && "opacity-0")}>
        <p className="truncate text-sm font-medium text-white/90">{title}</p>
      </div>

      {/* Панель управления */}
      <div className={cx("absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/85 to-transparent px-3 pb-2 pt-10 transition-opacity", hidden && "pointer-events-none opacity-0")}>
        <SeekBar duration={duration} time={time} buffered={buffered} chapters={info?.chapters ?? []} onSeek={seek} pct={pct}
          cached={status?.stream?.cached ?? []} trick={info?.trickplay ?? null} />
        <div className="mt-1 flex items-center gap-1 text-white">
          <Ctl onClick={toggle} label={playing ? "Пауза (пробел)" : "Смотреть (пробел)"}>
            {playing ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
          </Ctl>
          <Ctl onClick={() => seek(time - 10)} label="Назад 10 с (←)"><BackwardIcon className="h-5 w-5" /></Ctl>
          <Ctl onClick={() => seek(time + 10)} label="Вперёд 10 с (→)"><ForwardIcon className="h-5 w-5" /></Ctl>
          <Ctl onClick={() => setVol(muted || volume === 0 ? 1 : 0)} label="Звук (M)">
            {muted || volume === 0 ? <SpeakerXMarkIcon className="h-5 w-5" /> : <SpeakerWaveIcon className="h-5 w-5" />}
          </Ctl>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVol(Number(e.target.value))}
            aria-label="Громкость" className="w-20 accent-white" />
          <span className="ml-2 text-xs tabular-nums text-white/80">{clock(time)} / {clock(duration)}</span>
          <span className="flex-1" />
          {next && (
            <button onClick={next.go} className="rounded-md px-2 py-1 text-xs font-medium text-white/90 hover:bg-white/15" title="Следующая серия (N)">
              {next.label} ›
            </button>
          )}
          {info && info.audio.length > 1 && (
            <Menu open={menu === "audio"} onOpen={() => setMenu(menu === "audio" ? null : "audio")} label="Озвучка" icon={<LanguageIcon className="h-5 w-5" />}
              items={info.audio.map((a) => ({ key: a.index, label: a.label, active: a.index === info.audioIndex }))}
              onPick={(i) => { setMenu(null); if (i !== info.audioIndex) void open({ audio: Number(i), start: video.current?.currentTime ?? 0 }); }} />
          )}
          {info && info.subs.length > 0 && (
            <Menu open={menu === "sub"} onOpen={() => setMenu(menu === "sub" ? null : "sub")} label="Субтитры" icon={<ChatBubbleBottomCenterTextIcon className="h-5 w-5" />}
              items={[{ key: -1, label: "Выключены", active: sub === null }, ...info.subs.map((s) => ({ key: s.index, label: `${s.label}${s.signs ? " (надписи)" : ""}`, active: s.index === sub }))]}
              onPick={(i) => { setMenu(null); chooseSub(i === -1 ? null : Number(i)); }} />
          )}
          <Menu open={menu === "quality"} onOpen={() => setMenu(menu === "quality" ? null : "quality")} label="Качество" icon={<Cog6ToothIcon className="h-5 w-5" />}
            items={[
              ...QUALITIES.map((q) => ({ key: q.value, label: q.label, active: q.value === (Number(store.get(QUALITY_KEY)) || 120e6) })),
              { key: -1, label: "Совместимый режим (H.264)", active: compat },
            ]}
            onPick={(v) => {
              setMenu(null);
              // Совместимый режим — переключатель: видео всегда в H.264 (если HEVC в браузере показывает чёрный экран)
              if (v === -1) store.set(COMPAT_KEY, compat ? "0" : "1");
              else store.set(QUALITY_KEY, String(v));
              void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime ?? 0 });
            }} />
          <Ctl onClick={() => setShowStatus((x) => !x)} label="Состояние потока"><InformationCircleIcon className="h-5 w-5" /></Ctl>
          <Ctl onClick={fullscreen} label="Во весь экран (F)">
            {full ? <ArrowsPointingInIcon className="h-5 w-5" /> : <ArrowsPointingOutIcon className="h-5 w-5" />}
          </Ctl>
        </div>
        {info && info.transcode.length > 0 && menu === "quality" && (
          <p className="mt-1 text-right text-[11px] text-white/50">Jellyfin перекодирует: {info.transcode.join(", ")}</p>
        )}
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
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-5 sm:p-8">
        {preview && <p className="text-lg font-semibold text-white sm:text-2xl">{preview.heading}</p>}
        {preview?.text && <p className="line-clamp-3 max-w-3xl text-sm text-gray-200 sm:text-base">{preview.text}</p>}
        <p className="text-sm text-gray-300">
          {start > 5 ? `Продолжить с ${clock(start)}` : ready ? "С начала" : "Готовлю поток…"}
        </p>
      </div>
    </div>
  );
}

function Ctl({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid h-9 w-9 place-items-center rounded-md text-white/90 hover:bg-white/15 hover:text-white">
      {children}
    </button>
  );
}

function Menu({ open, onOpen, label, icon, items, onPick }: {
  open: boolean; onOpen: () => void; label: string; icon: React.ReactNode;
  items: { key: number; label: string; active: boolean }[]; onPick: (key: number) => void;
}) {
  return (
    <div className="relative">
      <Ctl onClick={onOpen} label={label}>{icon}</Ctl>
      {open && (
        <div className="absolute bottom-11 right-0 z-10 max-h-72 min-w-48 overflow-y-auto rounded-lg bg-gray-900/95 p-1 text-sm shadow-xl ring-1 ring-gray-700">
          <p className="px-2.5 py-1 text-xs text-gray-400">{label}</p>
          {items.map((i) => (
            <button key={i.key} onClick={() => onPick(i.key)}
              className={cx("block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-gray-700/70", i.active ? "text-accent-300" : "text-gray-100")}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SeekBar({ duration, time, buffered, chapters, onSeek, pct, cached, trick }: {
  duration: number; time: number; buffered: number; chapters: { name: string; start: number }[];
  /** Скачано TorrServer — доли файла (серия «Стрима»); куда можно перематывать без ожидания */
  cached: [number, number][];
  /** Миниатюры (trickplay Jellyfin) — кадр над подсказкой времени */
  trick: PlayInfo["trickplay"];
  onSeek: (t: number) => void; pct: (t: number) => string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  const chapterAt = (t: number) => [...chapters].reverse().find((c) => c.start <= t)?.name;
  return (
    <div ref={bar} className="group/bar relative h-4 cursor-pointer" role="slider" aria-label="Перемотка" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time}
      onMouseMove={(e) => setHover(at(e.clientX))} onMouseLeave={() => setHover(null)}
      onClick={(e) => onSeek(at(e.clientX))}>
      <div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-white/25 transition-all group-hover/bar:top-1 group-hover/bar:h-2">
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: pct(buffered) }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent-400" style={{ width: pct(time) }} />
        {/* Скачанное с торрента — полоска под шкалой */}
        {cached.map(([a, b]) => (
          <span key={a} className="absolute -bottom-1.5 h-0.5 rounded-full bg-accent-500/70" style={{ left: `${a * 100}%`, width: `${Math.max(0.2, (b - a) * 100)}%` }} />
        ))}
        {chapters.filter((c) => c.start > 0).map((c) => (
          <span key={c.start} className="absolute inset-y-0 w-0.5 bg-black/60" style={{ left: pct(c.start) }} />
        ))}
      </div>
      {hover !== null && trick && <TrickThumb trick={trick} t={hover} left={pct(hover)} />}
      {hover !== null && (
        <span className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs text-white" style={{ left: pct(hover) }}>
          {clock(hover)}{chapterAt(hover) ? ` · ${chapterAt(hover)}` : ""}
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
      style={{ left, bottom: 40, width: w, height: h, backgroundImage: `url(${trick.url}/${tile}.jpg)`,
        backgroundSize: `${trick.cols * w}px ${trick.rows * trick.height * k}px`, backgroundPosition: `-${x * w}px -${y * trick.height * k}px` }} />
  );
}
