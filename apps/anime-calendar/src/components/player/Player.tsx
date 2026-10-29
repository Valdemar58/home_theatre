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
import { correction, positionAt, type RoomState } from "@/lib/room";
import { cx, ErrorBox, Spinner } from "../ui";
import { StreamStatus, type Stage } from "./StreamStatus";

// Плеер серии: поток Jellyfin через календарь (HLS — hls.js, Safari — сам), ASS — JASSUB (libass в браузере,
// шрифты из вложений файла), остальные субтитры — <track> (Jellyfin отдаёт их как WebVTT). Смена озвучки — новая
// сессия с той же позиции (Jellyfin перекодирует звук под выбранную дорожку). Позиция — на сервер раз в 10 с.

const QUALITY_KEY = "player-bitrate";
const AUTOSKIP_KEY = "player-autoskip";
const SEG_LABEL = { op: "опенинг", ed: "эндинг" } as const;
const VOLUME_KEY = "player-volume";
const SUB_KEY = "player-sub-lang";
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
  state: RoomState;
  canControl: boolean;
  serverNow: () => number;
  command: (action: "play" | "pause" | "seek", pos: number) => void;
  report: (r: { buffering: boolean; bw: number | null; drift: number | null }) => void;
};

export function Player({ anilistId, ep, title, onEnded, next, onReport, children, autoPlay, preview, onState, controls, room }: {
  anilistId: number;
  ep: number;
  title: string;
  /** Сразу смотреть (автопереход); иначе — превью серии и кнопка ▶ (сессия Jellyfin готовится заранее) */
  autoPlay?: boolean;
  preview?: { still: string | null; heading: string; text: string | null };
  /** Сессия и выбранные субтитры — для боковой панели */
  onState?: (s: { info: PlayInfo | null; sub: number | null; subs: SubSettings; signs: number | null; signsState: SignsState }) => void;
  controls?: React.MutableRefObject<PlayerControls | null>;
  /** Смотрим в комнате */
  room?: RoomSync | null;
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
  // Надписи поверх субтитров — свой JASSUB; из полной дорожки с переводом — сначала ждём сервер
  const [signs, setSigns] = useState<number | null>(null);
  const [signsState, setSignsState] = useState<SignsState>(null);
  const assSigns = useRef<JASSUB | null>(null);
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
  // Сбои загрузки кусков подряд и новые сессии подряд (сбрасываются первым же пришедшим куском)
  const netFails = useRef(0);
  const renewals = useRef(0);
  // Новая сессия без пересоздания плеера: тот же hls.js, а куски просятся у новой сессии (номера кусков у Jellyfin —
  // от начала файла, у старой и новой сессии одни и те же), запас в буфере остаётся
  const swap = useRef(false);
  const startAt = useRef(0);
  const remap = useRef<{ from: string; dir: string; query: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // До нажатия ▶ — превью: сессия уже открыта (Jellyfin прочитал файл), поток не запрошен
  const [started, setStarted] = useState(Boolean(autoPlay));
  // Пропуск опенинга/эндинга: сам (настройка) — один раз за серию, отмотали назад вручную — не прыгаем снова
  const [autoSkip, setAutoSkip] = useState(() => store.get(AUTOSKIP_KEY) === "1");
  const skipped = useRef(new Set<string>());
  // Серия кончилась — отсчёт до следующей (отменяется)
  const [countdown, setCountdown] = useState<number | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const inRoom = Boolean(room);
  // Насколько плеер разошёлся с комнатой (для отчёта)
  const drift = useRef<number | null>(null);
  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 3000);
  }, []);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) { next?.go(); return; }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, next]);

  // ---------------------------------------------------------------- сессия и поток
  const open = useCallback(async (opts: { audio?: number | null; voice?: string; start?: number | null } = {}) => {
    setLoading(true);
    setError(null);
    setStalled(false);
    progressAt.current = Date.now();
    setStage({ step: "session", since: Date.now() });
    try {
      const caps = detectCaps();
      // Браузер не играет даже H.264 + AAC (встроенный просмотрщик VS Code — Electron без этих кодеков): сказать сразу
      if (!canPlayBasic()) throw new Error("Этот просмотрщик не умеет видео H.264/AAC (например, встроенный браузер VS Code) — откройте страницу в Chrome, Edge или Firefox");
      // В комнате — с её позиции
      const rm = roomRef.current;
      const start = opts.start ?? (rm ? positionAt(rm.state, rm.serverNow()) : undefined);
      const r = await api<PlayInfo>("/api/play", { method: "POST", json: { anilistId, ep, caps, ...opts, start, replace: sid.current } });
      hevcSent.current = caps.hevc;
      recoveries.current = 0;
      sid.current = r.sid;
      setInfo(r);
      // Выбор субтитров запоминается по языку (русские / английские / выкл.)
      const lang = store.get(SUB_KEY);
      const byLang = lang === "off" ? null : lang ? r.subs.find((s) => s.lang === lang && !s.signs)?.index ?? r.subIndex : r.subIndex;
      setSub((prev) => (opts.audio !== undefined || opts.voice ? prev : byLang));
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

  // Поток пропал (календарь перезапускался, Jellyfin остановил перекодирование): новая сессия с текущей секунды,
  // поданная в тот же hls.js — картинка тем временем идёт из запаса
  const renewing = useRef(false);
  const renew = useCallback(async () => {
    const v = video.current;
    if (!v || !sid.current || renewing.current) return;
    renewing.current = true;
    try {
      const old = sid.current;
      const r = await api<PlayInfo>("/api/play", { method: "POST", json: { anilistId, ep, caps: detectCaps(), audio: info?.audioIndex ?? null, start: v.currentTime, replace: sid.current } });
      // Адрес кусков новой сессии: каталог и параметры — из её плейлиста
      const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      const variant = new URL(first(await (await fetch(r.src)).text()) ?? "", new URL(r.src, location.href));
      const seg = new URL(first(await (await fetch(variant)).text()) ?? "", variant);
      remap.current = { from: remap.current?.from ?? `/api/play/${old}/`, dir: seg.pathname.replace(/[^/]+$/, ""), query: seg.search };
      sid.current = r.sid;
      swap.current = true;
      setInfo(r);
      hls.current?.startLoad(v.currentTime);
    } catch (e) {
      setError(e);
    } finally {
      renewing.current = false;
    }
  }, [anilistId, ep, info?.audioIndex]);
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
    const at = info.start;
    startAt.current = at;
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
          autoStartLoad: false, testBandwidth: false, manifestLoadingTimeOut: 30_000,
          // Сессия сменилась на ходу (renew) — кусок просим у новой
          xhrSetup: (xhr, url) => {
            const m = remap.current;
            const n = m && url.includes(m.from) ? /\/(\d+)\.mp4(\?|$)/.exec(url)?.[1] : null;
            if (m && n) xhr.open("GET", `${m.dir}${n}.mp4${m.query}`, true);
          },
          maxBufferLength: 60, backBufferLength: 90,
          // Кусок не пришёл — повторить несколько раз с паузой (Jellyfin мог перезапускать перекодирование)
          fragLoadPolicy: { default: {
            maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          } },
        });
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
      await v.play().catch(() => undefined);
    };
    void attach();
    return () => { alive = false; };
    // volume — только начальное значение
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, started]);

  // Боковая панель страницы: что открыто и чем управлять
  useEffect(() => { onState?.({ info, sub, subs: { delay: subDelay, size: subSize }, signs, signsState }); }, [info, sub, subDelay, subSize, signs, signsState, onState]);

  useEffect(() => () => { hls.current?.destroy(); ass.current?.destroy(); assSigns.current?.destroy(); }, []);

  // Загрузка — по состоянию видео, а не по событиям (Chrome шлёт «playing», пока hls.js ещё не подключил поток):
  // не пауза и нечего показывать — грузится. Сторож: так дольше 20 с — показать состояние и предложить выход
  useEffect(() => {
    const t = setInterval(() => {
      const v = video.current;
      if (!v || !info) return;
      const waiting = !v.paused && v.readyState < 3;
      setLoading(waiting);
      // Ошибка, а запас ещё играет — ни сторожа, ни состояния (ошибку покажем, когда картинка встанет)
      if (error) return;
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
    for (const a of [ass.current, assSigns.current]) if (a) (a as unknown as { timeOffset: number }).timeOffset = -subDelay;
    shiftCues();
  }, [subDelay, shiftCues]);
  const vttSub = info?.subs.find((x) => x.index === sub && !x.ass);

  const chooseSub = (index: number | null) => {
    const s = info?.subs.find((x) => x.index === index);
    setSub(s ? s.index : null);
    if (!s || !s.signs) store.set(SUB_KEY, s?.lang ?? "off");
  };
  const chooseSigns = (index: number | null) => {
    const s = info?.subs.find((x) => x.index === index);
    setSigns(s ? s.index : null);
    store.set(SIGNS_KEY, !s ? "off" : s.fromSub?.translate ? "translate" : "ru");
  };
  if (controls) {
    controls.current = {
      setAudio: (i) => { if (i !== info?.audioIndex) void open({ audio: i, start: video.current?.currentTime || info?.start || 0 }); },
      setVoice: (group) => void open({ voice: group, start: video.current?.currentTime || info?.start || 0 }),
      setSub: chooseSub,
      setSigns: chooseSigns,
      setSubDelay: (sec) => { const d = Math.round(sec * 10) / 10; setSubDelay(d); store.set(delayKey, String(d)); },
      setSubSize: (pct) => { setSubSize(pct); store.set("player-sub-size", String(pct)); },
      // Появились новые дорожки (скачали с Jimaku) — та же серия с той же секунды
      reload: () => void open({ audio: info?.audioIndex ?? null, start: video.current?.currentTime || info?.start || 0 }),
      position: () => ({ pos: video.current?.currentTime || info?.start || 0, playing: Boolean(video.current && !video.current.paused) }),
    };
  }

  // ---------------------------------------------------------------- позиция на сервер
  const send = useCallback(() => {
    const v = video.current;
    if (!sid.current || !v || !v.currentTime) return;
    void api<{ marked: boolean }>(`/api/play/${sid.current}`, { method: "POST", json: { pos: v.currentTime } }).then(onReport)
      // Сессии больше нет (календарь перезапускался) — новая, пока запас ещё играет
      .catch((e: unknown) => { if (/Сессия просмотра закончилась/.test(String((e as Error).message))) sessionLost(); });
  }, [onReport, sessionLost]);
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
    const rm = roomRef.current;
    if (rm) {
      if (!rm.canControl) { flash("Управляет организатор комнаты"); return; }
      // Видео ещё не загрузилось — позиция комнаты, а не ноль
      rm.command(v.paused ? "play" : "pause", v.readyState ? v.currentTime : positionAt(rm.state, rm.serverNow()));
    }
    if (v.paused) void v.play().catch(() => undefined); else v.pause();
  }, [started, flash]);
  const seek = useCallback((to: number) => {
    const v = video.current;
    if (!v) return;
    const rm = roomRef.current;
    if (rm && !rm.canControl) { flash("Управляет организатор комнаты"); return; }
    const t = Math.max(0, Math.min(to, (info?.duration || v.duration || to) - 0.5));
    v.currentTime = t;
    rm?.command("seek", t);
  }, [info, flash]);

  // ---------------------------------------------------------------- комната
  // Держаться позиции комнаты: пауза/просмотр как у неё, расхождение — скоростью или перемоткой (lib/room correction)
  useEffect(() => {
    if (!inRoom || !started || !info) return;
    const t = setInterval(() => {
      const rm = roomRef.current;
      const v = video.current;
      if (!rm || !v || v.ended) return;
      const s = rm.state;
      if (s.playing && v.paused) void v.play().catch(() => undefined);
      if (!s.playing && !v.paused) v.pause();
      if (v.readyState < 2 || v.seeking) return;
      const target = positionAt(s, rm.serverNow());
      drift.current = Math.round((v.currentTime - target) * 10) / 10;
      const c = correction(v.currentTime - target, s.playing);
      if (c.seek) v.currentTime = target;
      if (v.playbackRate !== c.rate) v.playbackRate = c.rate;
    }, 500);
    return () => {
      clearInterval(t);
      if (video.current) video.current.playbackRate = 1;
    };
  }, [inRoom, started, info]);
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
      const low = v.readyState < 3 || (was === true && ahead < 5 && v.currentTime + ahead < (v.duration || Infinity) - 1);
      if (low && !v.ended) since ??= Date.now(); else since = null;
      const buffering = since !== null && (was === true || Date.now() - since > 1000);
      if (!force && buffering === was) return;
      was = buffering;
      const bw = hls.current?.bandwidthEstimate;
      rm.report({ buffering, bw: bw && Number.isFinite(bw) ? Math.round(bw) : null, drift: drift.current });
    };
    tick(true);
    const fast = setInterval(() => tick(false), 500);
    const slow = setInterval(() => tick(true), 5000);
    return () => { clearInterval(fast); clearInterval(slow); };
  }, [inRoom, started]);
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
      {/* Ошибка — только когда картинка встала: пока идёт запас, плеер восстанавливается молча */}
      {Boolean(error) && (!playing || loading) && <div className="absolute inset-x-6 top-1/3"><ErrorBox error={error} /></div>}
      {children?.(time, seek)}
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

      {/* Заголовок */}
      <div className={cx("pointer-events-none absolute inset-x-0 top-0 z-10 bg-linear-to-b from-black/70 to-transparent px-4 pb-8 pt-3 transition-opacity", hidden && "opacity-0")}>
        <p className="truncate text-sm font-medium text-white/90">{title}</p>
      </div>

      {/* Панель управления */}
      <div className={cx("absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/85 to-transparent px-3 pb-2 pt-10 transition-opacity", hidden && "pointer-events-none opacity-0")}>
        <SeekBar duration={duration} time={time} buffered={buffered} chapters={info?.chapters ?? []} onSeek={seek} pct={pct}
          cached={status?.stream?.cached ?? []} trick={info?.trickplay ?? null} segments={info?.segments ?? []} />
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
              items={[{ key: -1, label: "Выключены", active: sub === null }, ...info.subs.filter((s) => !s.fromSub).map((s) => ({ key: s.index, label: `${s.label}${s.signs ? " (надписи)" : ""}`, active: s.index === sub }))]}
              onPick={(i) => { setMenu(null); chooseSub(i === -1 ? null : Number(i)); }} />
          )}
          <Menu open={menu === "quality"} onOpen={() => setMenu(menu === "quality" ? null : "quality")} label="Качество" icon={<Cog6ToothIcon className="h-5 w-5" />}
            items={[
              ...QUALITIES.map((q) => ({ key: q.value, label: q.label, active: q.value === (Number(store.get(QUALITY_KEY)) || 0) })),
              { key: -1, label: "Совместимый режим (H.264)", active: compat },
              { key: -2, label: "Пропускать опенинг и эндинг сам", active: autoSkip },
            ]}
            onPick={(v) => {
              setMenu(null);
              // Совместимый режим — переключатель: видео всегда в H.264 (если HEVC в браузере показывает чёрный экран)
              if (v === -2) {
                store.set(AUTOSKIP_KEY, autoSkip ? "0" : "1");
                setAutoSkip(!autoSkip);
                return;
              }
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

function SeekBar({ duration, time, buffered, chapters, onSeek, pct, cached, trick, segments }: {
  duration: number; time: number; buffered: number; chapters: { name: string; start: number }[];
  /** Скачано TorrServer — доли файла (серия «Стрима»); куда можно перематывать без ожидания */
  cached: [number, number][];
  /** Миниатюры (trickplay Jellyfin) — кадр над подсказкой времени */
  trick: PlayInfo["trickplay"];
  segments: PlayInfo["segments"];
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
