"use client";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { isStrip, spreadsOf, type BookKind } from "@/lib/books";
import { fitFont, type MangaAiPage } from "@/lib/manga-ocr";
import { cx } from "../ui";
import { MANGA_DEFAULTS, mangaSettings, mangaKey, tapAction, type MangaSettings } from "@/lib/manga-reader";
export type { MangaSettings, MangaMode, MangaDir } from "@/lib/manga-reader";

// Ридер манги (TASKS 5.4). Постранично — справа налево (японская манга) или слева направо, на широком экране —
// разворот из двух страниц (обложка и широкие страницы — по одной); лентой — манхва и маньхуа. Режим и направление
// запоминаются у книги, вписывание и ширина ленты — общие. Позиция — индекс страницы.

type Global = Omit<MangaSettings, "mode" | "dir">;
type PerBook = Partial<MangaSettings> & { bookOnly?: boolean };
type Page = { url: string; w?: number | null; h?: number | null };

const GLOBAL_KEY = "manga-settings";
const bookKey = (id: number) => `manga-book:${id}`;
const { mode: _mode, dir: _dir, ...GLOBAL_DEFAULTS } = MANGA_DEFAULTS;
const bookDefaults = (kind: BookKind | undefined): PerBook => ({
  mode: kind && isStrip(kind) ? "strip" : "paged",
  dir: kind === "manga" || kind === "oneshot" ? "rtl" : "ltr",
});

const load = <T,>(key: string): Partial<T> => {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<T>; } catch { return {}; }
};
const store = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* не страшно */ }
};

export function useMangaSettings(id: number, kind: BookKind | undefined): [MangaSettings, (s: Partial<MangaSettings>) => void, { bookOnly: boolean; setBookOnly: (on: boolean) => void }] {
  const [g, setG] = useState<Global>(GLOBAL_DEFAULTS);
  const [b, setB] = useState<Partial<PerBook>>({});
  useEffect(() => {
    setG({ ...GLOBAL_DEFAULTS, ...load<Global>(GLOBAL_KEY) });
    setB(load<PerBook>(bookKey(id)));
  }, [id]);
  const settings = mangaSettings({ ...g, ...bookDefaults(kind), ...b });
  const update = (x: Partial<MangaSettings>) => {
    if (b.bookOnly) {
      setB((cur) => { const n = { ...cur, ...x }; store(bookKey(id), n); return n; });
      return;
    }
    const { mode, dir, ...rest } = x;
    if (Object.keys(rest).length) setG((cur) => { const n = { ...cur, ...rest }; store(GLOBAL_KEY, n); return n; });
    if (mode || dir) setB((cur) => {
      const n = { ...cur, ...(mode ? { mode } : {}), ...(dir ? { dir } : {}) };
      store(bookKey(id), n);
      return n;
    });
  };
  const setBookOnly = (on: boolean) => setB((cur) => {
    const n: PerBook = on ? { ...settings, bookOnly: true } : { mode: cur.mode, dir: cur.dir, bookOnly: false };
    store(bookKey(id), n); return n;
  });
  return [settings, update, { bookOnly: Boolean(b.bookOnly), setBookOnly }];
}

type Props = {
  pages: Page[];
  /** Перевод ИИ поверх страниц (TASKS 5.8) — по индексу страницы; null — оригинал */
  ai?: MangaAiPage[] | null;
  s: MangaSettings;
  restore: number;
  onPos: (i: number) => void;
  onEnd: () => void;
  prev: (() => void) | null;
  next: (() => void) | null;
  dim: string;
  onToggleControls?: () => void;
};

export function MangaReader(props: Props) {
  const position = useRef(props.restore);
  const onPos = (i: number) => { position.current = i; props.onPos(i); };
  const p = { ...props, restore: position.current, onPos };
  return <div style={{ background: props.s.background === "black" ? "#000" : props.s.background === "light" ? "#fff" : "#111827" }}>
    {props.s.mode === "strip" ? <Strip {...p} /> : <Paged {...p} />}
  </div>;
}

/** Широкий экран — можно показывать разворот. */
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const check = () => setWide(window.innerWidth > window.innerHeight * 1.15 && window.innerWidth >= 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return wide;
}

function Paged({ pages, ai, s, restore, onPos, onEnd, prev, next, dim, onToggleControls }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const measure = () => { if (viewport.current) setHeight(Math.max(320, window.innerHeight - Math.max(0, viewport.current.getBoundingClientRect().top) - 12)); };
    measure(); window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const wide = useWide();
  const spreads = useMemo(() => spreadsOf(pages, s.double && wide), [pages, s.double, wide]);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const visiblePage = useRef(restore);
  // Восстановить место (разворот, где лежит сохранённая страница)
  useEffect(() => {
    const r = Math.floor(visiblePage.current);
    setAt(Math.max(0, spreads.findIndex((sp) => sp.includes(r))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, spreads]);
  const cur = spreads[Math.min(at, spreads.length - 1)] ?? [];
  useEffect(() => {
    if (!cur.length) return;
    visiblePage.current = cur[0];
    onPos(cur[0]);
    if (at >= spreads.length - 1) onEnd();
    box.current?.scrollTo({ top: 0 });
    // Предзагрузка следующих страниц
    const last = cur[cur.length - 1];
    for (const p of pages.slice(last + 1, last + 5)) { const img = new Image(); img.src = p.url; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, spreads]);

  const forward = () => (at < spreads.length - 1 ? setAt(at + 1) : next?.());
  const back = () => (at > 0 ? setAt(at - 1) : prev?.());
  const rtl = s.dir === "rtl";
  const fitH = s.fit === "height";
  const toLeft = rtl ? forward : back;
  const toRight = rtl ? back : forward;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!s.keyboard || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, select, textarea, button, a, [contenteditable=true]")) return;
      const action = mangaKey(e.key, e.shiftKey, s.dir);
      if (!action) return;
      (action === "next" ? forward : back)();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Нажатие: левый и правый края — листать в их сторону, середина — дальше; свайп по горизонтали — тоже
  const touch = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(0);
  const onClick = (e: React.MouseEvent) => {
    if (Date.now() < suppressClick.current || window.visualViewport && window.visualViewport.scale > 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const action = tapAction(x, s);
    if (action === "controls") onToggleControls?.();
    else if (action) (action === "next" ? forward : back)();
  };
  // Колесо: по высоте — листает сразу; по ширине — когда страница прокручена до края. Один жест — одна страница
  const wheelAt = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (!s.wheel || e.ctrlKey || window.visualViewport && window.visualViewport.scale > 1) return;
    if (Math.abs(e.deltaY) < 4 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const el = box.current;
    if (!fitH && el) {
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      if ((e.deltaY > 0 && !atEnd) || (e.deltaY < 0 && el.scrollTop > 0)) return;
    }
    const now = Date.now();
    if (now - wheelAt.current < 450) { wheelAt.current = now; return; }
    wheelAt.current = now;
    (e.deltaY > 0 ? forward : back)();
  };
  // Страницы разворота справа налево — первая справа
  const shown = rtl ? [...cur].reverse() : cur;

  return (
    <div ref={viewport} style={{ height }} className="flex h-[calc(100dvh-13rem)] flex-col">
      <div ref={box} onClick={onClick} onWheel={onWheel}
        onTouchStart={(e) => {
          if (e.touches.length !== 1) { touch.current = null; suppressClick.current = Date.now() + 700; return; }
          touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchMove={(e) => { if (e.touches.length !== 1) { touch.current = null; suppressClick.current = Date.now() + 700; } }}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t) return;
          const dx = e.changedTouches[0].clientX - t.x;
          const dy = e.changedTouches[0].clientY - t.y;
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) suppressClick.current = Date.now() + 700;
          if (s.swipe && (!window.visualViewport || window.visualViewport.scale === 1) && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx > 0 ? toLeft : toRight)();
        }}
        className={cx("min-h-0 flex-1 select-none", fitH ? "flex items-center justify-center overflow-hidden" : "overflow-y-auto")}>
        <div className={cx("flex justify-center", fitH ? "h-full w-full" : "mx-auto w-full max-w-5xl")}>
          {shown.map((i) => (
            <div key={pages[i].url} className={cx("relative min-w-0", fitH ? "h-full" : "h-auto", cur.length > 1 && (fitH ? "max-w-[50%]" : "w-1/2"), cur.length === 1 && !fitH && "w-full")}
              style={fitH && pages[i].w && pages[i].h ? { aspectRatio: `${pages[i].w} / ${pages[i].h}` } : undefined}>
              <img src={pages[i].url} alt={`Страница ${i + 1}`} draggable={false}
                className={cx("block", fitH ? "h-full w-auto max-w-full object-contain" : "h-auto w-full")} />
              {ai?.[i] && <AiLayer page={ai[i]} />}
            </div>
          ))}
        </div>
      </div>
      {/* Низ: листание, номер страницы, ползунок (по направлению чтения) */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: dim }}>
        <button onClick={toLeft} className="min-h-11 min-w-11 rounded p-2" title={rtl ? "Дальше" : "Назад"}><ChevronLeftIcon className="h-5 w-5" /></button>
        <input type="range" min={0} max={Math.max(0, spreads.length - 1)} value={rtl ? spreads.length - 1 - at : at}
          onChange={(e) => { const v = Number(e.target.value); setAt(rtl ? spreads.length - 1 - v : v); }}
          className="min-w-0 flex-1 accent-current" aria-label="Страница" />
        <span className="w-16 shrink-0 text-center tabular-nums">{cur.length ? cur.map((i) => i + 1).join("–") : 0} / {pages.length}</span>
        <button onClick={toRight} className="min-h-11 min-w-11 rounded p-2" title={rtl ? "Назад" : "Дальше"}><ChevronRightIcon className="h-5 w-5" /></button>
      </div>
    </div>
  );
}

function Strip({ pages, ai, s, restore, onPos, onEnd, next, prev, onToggleControls }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (restore > 0) el.querySelector<HTMLElement>(`[data-i="${Math.floor(restore)}"]`)?.scrollIntoView({ block: "start" });
    const seen = new Set<number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (e.isIntersecting) seen.add(i); else seen.delete(i);
      }
      if (seen.size) onPos(Math.min(...seen));
    }, { rootMargin: "-80px 0px -40% 0px" });
    el.querySelectorAll("[data-i]").forEach((n) => io.observe(n));
    const fin = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) onEnd(); });
    if (end.current) fin.observe(end.current);
    return () => { io.disconnect(); fin.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);
  // ← → — главы (лента листается прокруткой)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!s.keyboard || (e.target as HTMLElement).closest("input, select, textarea, button, a, [contenteditable=true]")) return;
      const action = mangaKey(e.key, e.shiftKey, s.dir);
      if (!action) return;
      e.preventDefault();
      window.scrollBy({ top: (action === "next" ? 1 : -1) * window.innerHeight * 0.8, behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.keyboard, s.dir]);

  return (
    <div ref={root} className="mx-auto" style={{ maxWidth: `${s.stripWidth}rem` }} onClick={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const action = tapAction((e.clientX - r.left) / r.width, s);
      if (action === "controls") onToggleControls?.();
      else if (action) window.scrollBy({ top: (action === "next" ? 1 : -1) * window.innerHeight * 0.8, behavior: "smooth" });
    }}>
      {pages.map((p, i) => (
        // Ширина и высота заранее — лента не прыгает при загрузке
        <div key={p.url} data-i={i} className="relative" style={{ marginBottom: s.gap }}>
          <img src={p.url} alt={`Страница ${i + 1}`} loading={i < 4 ? "eager" : "lazy"} className="block w-full"
            style={p.w && p.h ? { aspectRatio: `${p.w} / ${p.h}` } : { minHeight: "50vh" }} />
          {ai?.[i] && <AiLayer page={ai[i]} />}
        </div>
      ))}
      <div ref={end} className="h-1" />
    </div>
  );
}

/**
 * Перевод ИИ поверх страницы: пузырь закрашивается, русский текст вписывается подбором размера (по ширине картинки
 * на экране). Узкий вертикальный японский пузырь расширяется под горизонтальный текст. Исходный текст — в подсказке.
 */
function AiLayer({ page }: { page: MangaAiPage }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / page.w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.w]);
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {scale > 0 && page.bubbles.map((b, k) => {
        // Рамка распознавания облегает текст вплотную — закрашиваем с запасом 8%, чтобы края букв не выглядывали
        const px = (b.x1 - b.x0) * 0.08, py = (b.y1 - b.y0) * 0.08;
        let x0 = Math.max(0, b.x0 - px), x1 = Math.min(1000, b.x1 + px);
        const y0 = Math.max(0, b.y0 - py), y1 = Math.min(1000, b.y1 + py);
        const h = ((y1 - y0) / 1000) * page.h;
        if (b.vertical && ((x1 - x0) / 1000) * page.w < h * 0.6) {
          const half = ((h * 0.6) / page.w) * 500, c = (x0 + x1) / 2;
          x0 = Math.max(0, c - half);
          x1 = Math.min(1000, c + half);
        }
        const w = ((x1 - x0) / 1000) * page.w;
        return (
          <div key={k} title={b.text} className="pointer-events-auto absolute flex items-center justify-center overflow-hidden text-center font-semibold"
            style={{ left: `${x0 / 10}%`, top: `${y0 / 10}%`, width: `${(x1 - x0) / 10}%`, height: `${(y1 - y0) / 10}%`,
              fontSize: fitFont(b.ru, w, h) * scale, lineHeight: 1.1, borderRadius: "35%", padding: "2%", background: "#ffffff", color: "#111111" }}>
            {b.ru}
          </div>
        );
      })}
    </div>
  );
}

export function MangaSettingsPanel({ s, set, scope }: { s: MangaSettings; set: (x: Partial<MangaSettings>) => void; scope?: { bookOnly: boolean; setBookOnly: (on: boolean) => void } }) {
  const row = "flex flex-wrap items-center justify-between gap-3";
  const btn = (on: boolean) => cx("rounded-md px-2.5 py-1 text-sm ring-1", on ? "tone-accent solid ring-transparent" : "ring-gray-500/40");
  return (
    <div className="fixed right-4 top-[10rem] md:top-[7.25rem] z-30 max-h-[calc(100dvh-15rem)] md:max-h-[75dvh] w-[min(28rem,calc(100%-2rem))] space-y-3 overflow-y-auto rounded-xl bg-gray-900/95 p-4 text-sm text-gray-100 shadow-2xl ring-1 ring-gray-700">
      {scope && <label className={row}><span>Настройки только для этой книги</span><input type="checkbox" checked={scope.bookOnly} onChange={(e) => scope.setBookOnly(e.target.checked)} /></label>}
      <div className={row}><span>Режим</span><span className="flex gap-1">
        <button className={btn(s.mode === "paged")} onClick={() => set({ mode: "paged" })}>Страницы</button>
        <button className={btn(s.mode === "strip")} onClick={() => set({ mode: "strip" })}>Лента</button></span></div>
      {s.mode === "paged" ? <>
        <div className={row}><span>Направление</span><span className="flex gap-1">
          <button className={btn(s.dir === "rtl")} onClick={() => set({ dir: "rtl" })}>Справа налево</button>
          <button className={btn(s.dir === "ltr")} onClick={() => set({ dir: "ltr" })}>Слева направо</button></span></div>
        <div className={row}><span>Вписать</span><span className="flex gap-1">
          <button className={btn(s.fit === "height")} onClick={() => set({ fit: "height" })}>По высоте</button>
          <button className={btn(s.fit === "width")} onClick={() => set({ fit: "width" })}>По ширине</button></span></div>
        <div className={row}><span>Разворот</span><span className="flex gap-1">
          <button className={btn(s.double)} onClick={() => set({ double: true })}>Две страницы</button>
          <button className={btn(!s.double)} onClick={() => set({ double: false })}>Одна</button></span></div>
      </> : (
        <div className={row}><span>Ширина</span><span className="flex items-center gap-2">
          <button className={btn(false)} onClick={() => set({ stripWidth: Math.max(24, s.stripWidth - 6) })}>−</button>
          <span className="w-10 text-center tabular-nums">{Math.round((s.stripWidth / 48) * 100)}%</span>
          <button className={btn(false)} onClick={() => set({ stripWidth: Math.min(96, s.stripWidth + 6) })}>+</button></span></div>
      )}
      <div className={row}><span>Нажатия</span><select aria-label="Нажатия на страницу" className="rounded bg-gray-800 p-1" value={s.taps} onChange={(e) => set({ taps: e.target.value as MangaSettings["taps"] })}><option value="direction">По направлению чтения</option><option value="physical">Слева назад, справа вперёд</option><option value="off">Только кнопки</option></select></div>
      <div className="grid grid-cols-[3fr_4fr_3fr] overflow-hidden rounded-lg text-center text-xs ring-1 ring-gray-600">
        <div className="bg-indigo-950 p-3">{s.taps === "off" ? "—" : tapAction(0, s) === "next" ? "Дальше" : "Назад"}</div>
        <div className="bg-gray-800 p-3">Панели</div>
        <div className="bg-indigo-950 p-3">{s.taps === "off" ? "—" : tapAction(1, s) === "next" ? "Дальше" : "Назад"}</div>
      </div>
      {([['swipe', 'Свайпы'], ['keyboard', 'Клавиатура'], ['wheel', 'Колесо мыши']] as const).map(([k, label]) => <label key={k} className={row}><span>{label}</span><input type="checkbox" checked={s[k]} onChange={(e) => set({ [k]: e.target.checked })} /></label>)}
      <div className={row}><span>Фон</span><select aria-label="Фон страниц" value={s.background} className="rounded bg-gray-800 p-1" onChange={(e) => set({ background: e.target.value as MangaSettings["background"] })}><option value="dark">Тёмный</option><option value="black">Чёрный</option><option value="light">Белый</option></select></div>
      {s.mode === "strip" && <label className={row}>Промежуток страниц<input aria-label="Промежуток страниц" type="range" min="0" max="32" value={s.gap} onChange={(e) => set({ gap: Number(e.target.value) })} /></label>}
      <p className="text-xs text-gray-400">Центр — показать панели. Стрелки учитывают направление чтения. PageDown / пробел — вперёд, PageUp / Shift+пробел — назад. Кнопки доступны всегда.</p>
      <button className={btn(false)} onClick={() => set(MANGA_DEFAULTS)}>Сбросить настройки</button>
    </div>
  );
}
