"use client";
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, BackwardIcon, ChatBubbleBottomCenterTextIcon, Cog6ToothIcon, ForwardIcon,
  LanguageIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon,
} from "@heroicons/react/24/solid";
import type Hls from "hls.js";
import type JASSUB from "jassub";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { PlayCaps, PlayInfo } from "@/lib/player";
import { cx, ErrorBox, Spinner } from "../ui";

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

/** Что браузер декодирует сам (HEVC 10 бит — Chrome/Edge с аппаратным декодером, Safari). */
function detectCaps(): PlayCaps {
  const ok = (c: string) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`);
  return { hevc: ok("hvc1.2.4.L120.B0"), av1: ok("av01.0.08M.10"), maxBitrate: Number(store.get(QUALITY_KEY)) || 120e6 };
}

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

export function Player({ anilistId, ep, title, onEnded, next, onReport, children }: {
  anilistId: number;
  ep: number;
  title: string;
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
  const sid = useRef<string | null>(null);

  // ---------------------------------------------------------------- сессия и поток
  const open = useCallback(async (opts: { audio?: number | null; start?: number | null } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<PlayInfo>("/api/play", { method: "POST", json: { anilistId, ep, caps: detectCaps(), ...opts, replace: sid.current } });
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
    if (!v || !info) return;
    let alive = true;
    const at = info.start;
    const attach = async () => {
      hls.current?.destroy();
      hls.current = null;
      if (info.hls && !v.canPlayType("application/vnd.apple.mpegurl")) {
        const { default: H } = await import("hls.js");
        if (!alive) return;
        // Перекодирование первого сегмента — несколько секунд: ждём дольше обычного
        const h = new H({ startPosition: at, manifestLoadingTimeOut: 30_000, fragLoadingTimeOut: 60_000, maxBufferLength: 60, backBufferLength: 90 });
        h.on(H.Events.ERROR, (_e, d) => { if (d.fatal) setError(new Error(`Поток прервался: ${d.details}`)); });
        h.loadSource(info.src);
        h.attachMedia(v);
        hls.current = h;
      } else {
        v.src = info.src;
        v.currentTime = at;
      }
      v.volume = volume;
      await v.play().catch(() => undefined);
    };
    void attach();
    return () => { alive = false; };
    // volume — только начальное значение
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  useEffect(() => () => { hls.current?.destroy(); ass.current?.destroy(); }, []);

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
        video: v, subUrl: s.url, fonts: info.fonts,
        workerUrl: "/jassub/jassub-worker.js", wasmUrl: "/jassub/jassub-worker.wasm", modernWasmUrl: "/jassub/jassub-worker-modern.wasm",
        availableFonts: { "liberation sans": "/jassub/default.woff2" }, fallbackFont: "liberation sans",
      });
    });
    return () => { alive = false; };
  }, [sub, info]);
  const vttSub = info?.subs.find((x) => x.index === sub && !x.ass);

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
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, []);
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
      <video ref={video} className="h-full w-full" playsInline
        onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); send(); }}
        onWaiting={() => setLoading(true)} onPlaying={() => setLoading(false)} onCanPlay={() => setLoading(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onProgress={(e) => { const b = e.currentTarget.buffered; setBuffered(b.length ? b.end(b.length - 1) : 0); }}
        onEnded={onEnded}>
        {vttSub && <track key={vttSub.url} kind="subtitles" src={vttSub.url} srcLang={vttSub.lang ?? "und"} label={vttSub.label} default />}
      </video>

      {loading && !error && <div className="pointer-events-none absolute inset-0 grid place-items-center"><Spinner className="h-10 w-10 text-white/80" /></div>}
      {Boolean(error) && <div className="absolute inset-x-6 top-1/3"><ErrorBox error={error} /></div>}
      {children?.(time, seek)}

      {/* Заголовок */}
      <div className={cx("pointer-events-none absolute inset-x-0 top-0 z-10 bg-linear-to-b from-black/70 to-transparent px-4 pb-8 pt-3 transition-opacity", hidden && "opacity-0")}>
        <p className="truncate text-sm font-medium text-white/90">{title}</p>
      </div>

      {/* Панель управления */}
      <div className={cx("absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/85 to-transparent px-3 pb-2 pt-10 transition-opacity", hidden && "pointer-events-none opacity-0")}>
        <SeekBar duration={duration} time={time} buffered={buffered} chapters={info?.chapters ?? []} onSeek={seek} pct={pct} />
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
              onPick={(i) => {
                setMenu(null);
                const s = info.subs.find((x) => x.index === Number(i));
                setSub(s ? s.index : null);
                if (!s || !s.signs) store.set(SUB_KEY, s?.lang ?? "off");
              }} />
          )}
          <Menu open={menu === "quality"} onOpen={() => setMenu(menu === "quality" ? null : "quality")} label="Качество" icon={<Cog6ToothIcon className="h-5 w-5" />}
            items={QUALITIES.map((q) => ({ key: q.value, label: q.label, active: q.value === (Number(store.get(QUALITY_KEY)) || 120e6) }))}
            onPick={(v) => { setMenu(null); store.set(QUALITY_KEY, String(v)); void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime ?? 0 }); }} />
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

function SeekBar({ duration, time, buffered, chapters, onSeek, pct }: {
  duration: number; time: number; buffered: number; chapters: { name: string; start: number }[];
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
        {chapters.filter((c) => c.start > 0).map((c) => (
          <span key={c.start} className="absolute inset-y-0 w-0.5 bg-black/60" style={{ left: pct(c.start) }} />
        ))}
      </div>
      {hover !== null && (
        <span className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs text-white" style={{ left: pct(hover) }}>
          {clock(hover)}{chapterAt(hover) ? ` · ${chapterAt(hover)}` : ""}
        </span>
      )}
    </div>
  );
}
