"use client";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { isStrip, spreadsOf, type BookKind } from "@/lib/books";
import { cx } from "../ui";

// Ридер манги (TASKS 5.4). Постранично — справа налево (японская манга) или слева направо, на широком экране —
// разворот из двух страниц (обложка и широкие страницы — по одной); лентой — манхва и маньхуа. Режим и направление
// запоминаются у книги, вписывание и ширина ленты — общие. Позиция — индекс страницы.

export type MangaMode = "paged" | "strip";
export type MangaDir = "rtl" | "ltr";
export type MangaSettings = { mode: MangaMode; dir: MangaDir; fit: "height" | "width"; double: boolean; stripWidth: number };
type Global = Pick<MangaSettings, "fit" | "double" | "stripWidth">;
type PerBook = Pick<MangaSettings, "mode" | "dir">;
type Page = { url: string; w?: number | null; h?: number | null };

const GLOBAL_KEY = "manga-settings";
const bookKey = (id: number) => `manga-book:${id}`;
const GLOBAL_DEFAULTS: Global = { fit: "height", double: true, stripWidth: 48 };
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

export function useMangaSettings(id: number, kind: BookKind | undefined): [MangaSettings, (s: Partial<MangaSettings>) => void] {
  const [g, setG] = useState<Global>(GLOBAL_DEFAULTS);
  const [b, setB] = useState<Partial<PerBook>>({});
  useEffect(() => {
    setG({ ...GLOBAL_DEFAULTS, ...load<Global>(GLOBAL_KEY) });
    setB(load<PerBook>(bookKey(id)));
  }, [id]);
  const settings = { ...g, ...bookDefaults(kind), ...b };
  const update = (x: Partial<MangaSettings>) => {
    const { mode, dir, ...rest } = x;
    if (Object.keys(rest).length) setG((cur) => { const n = { ...cur, ...rest }; store(GLOBAL_KEY, n); return n; });
    if (mode || dir) setB((cur) => {
      const n = { ...cur, ...(mode ? { mode } : {}), ...(dir ? { dir } : {}) };
      store(bookKey(id), n);
      return n;
    });
  };
  return [settings, update];
}

type Props = {
  pages: Page[];
  s: MangaSettings;
  restore: number;
  onPos: (i: number) => void;
  onEnd: () => void;
  prev: (() => void) | null;
  next: (() => void) | null;
  dim: string;
};

export function MangaReader(props: Props) {
  return props.s.mode === "strip" ? <Strip {...props} /> : <Paged {...props} />;
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

function Paged({ pages, s, restore, onPos, onEnd, prev, next, dim }: Props) {
  const wide = useWide();
  const spreads = useMemo(() => spreadsOf(pages, s.double && wide), [pages, s.double, wide]);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // Восстановить место (разворот, где лежит сохранённая страница)
  useEffect(() => {
    const r = Math.floor(restore);
    setAt(Math.max(0, spreads.findIndex((sp) => sp.includes(r))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);
  const cur = spreads[Math.min(at, spreads.length - 1)] ?? [];
  useEffect(() => {
    if (!cur.length) return;
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
  const toLeft = rtl ? forward : back;
  const toRight = rtl ? back : forward;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === "ArrowLeft") toLeft();
      else if (e.key === "ArrowRight") toRight();
      else if (e.key === "PageDown" || (e.key === " " && s.fit === "height")) forward();
      else if (e.key === "PageUp") back();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Нажатие: левая и правая трети — листать; свайп по горизонтали — тоже
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onClick = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.35) toLeft();
    else if (x > 0.65) toRight();
  };
  // Страницы разворота справа налево — первая справа
  const shown = rtl ? [...cur].reverse() : cur;
  const fitH = s.fit === "height";

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] flex-col">
      <div ref={box} onClick={onClick}
        onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t) return;
          const dx = e.changedTouches[0].clientX - t.x;
          const dy = e.changedTouches[0].clientY - t.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx > 0 ? toLeft : toRight)();
        }}
        className={cx("min-h-0 flex-1 select-none", fitH ? "flex items-center justify-center overflow-hidden" : "overflow-y-auto")}>
        <div className={cx("flex justify-center", fitH ? "h-full w-full" : "mx-auto w-full max-w-5xl")}>
          {shown.map((i) => (
            <img key={pages[i].url} src={pages[i].url} alt={`Страница ${i + 1}`} draggable={false}
              className={cx("block", fitH ? "h-full min-w-0 object-contain" : "h-auto min-w-0", cur.length > 1 && (fitH ? "max-w-[50%]" : "w-1/2"), cur.length === 1 && !fitH && "w-full")}
              style={fitH && pages[i].w && pages[i].h ? { aspectRatio: `${pages[i].w} / ${pages[i].h}` } : undefined} />
          ))}
        </div>
      </div>
      {/* Низ: листание, номер страницы, ползунок (по направлению чтения) */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: dim }}>
        <button onClick={toLeft} className="rounded p-1" title={rtl ? "Дальше" : "Назад"}><ChevronLeftIcon className="h-5 w-5" /></button>
        <input type="range" min={0} max={Math.max(0, spreads.length - 1)} value={rtl ? spreads.length - 1 - at : at}
          onChange={(e) => { const v = Number(e.target.value); setAt(rtl ? spreads.length - 1 - v : v); }}
          className="min-w-0 flex-1 accent-current" aria-label="Страница" />
        <span className="w-16 shrink-0 text-center tabular-nums">{cur.length ? cur.map((i) => i + 1).join("–") : 0} / {pages.length}</span>
        <button onClick={toRight} className="rounded p-1" title={rtl ? "Назад" : "Дальше"}><ChevronRightIcon className="h-5 w-5" /></button>
      </div>
    </div>
  );
}

function Strip({ pages, s, restore, onPos, onEnd, next, prev }: Props) {
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
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === "ArrowLeft" && prev) prev();
      if (e.key === "ArrowRight" && next) next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);

  return (
    <div ref={root} className="mx-auto" style={{ maxWidth: `${s.stripWidth}rem` }}>
      {pages.map((p, i) => (
        // Ширина и высота заранее — лента не прыгает при загрузке
        <img key={p.url} data-i={i} src={p.url} alt={`Страница ${i + 1}`} loading={i < 4 ? "eager" : "lazy"} className="block w-full"
          style={p.w && p.h ? { aspectRatio: `${p.w} / ${p.h}` } : { minHeight: "50vh" }} />
      ))}
      <div ref={end} className="h-1" />
    </div>
  );
}

export function MangaSettingsPanel({ s, set }: { s: MangaSettings; set: (x: Partial<MangaSettings>) => void }) {
  const row = "flex items-center justify-between gap-3";
  const btn = (on: boolean) => cx("rounded-md px-2.5 py-1 text-sm ring-1", on ? "tone-accent solid ring-transparent" : "ring-gray-500/40");
  return (
    <div className="sticky top-[7.25rem] z-10 mx-auto mt-2 w-[min(24rem,calc(100%-2rem))] space-y-3 rounded-xl bg-gray-900/95 p-4 text-sm text-gray-100 shadow-2xl ring-1 ring-gray-700">
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
      <p className="text-xs text-gray-400">{s.mode === "paged" ? "Листать — стрелки, края страницы или свайп." : "Главы — стрелки ← →."}</p>
    </div>
  );
}
