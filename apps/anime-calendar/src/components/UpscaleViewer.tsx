"use client";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Segmented, cx } from "./ui";

// Полноэкранное сравнение двух версий картинки (лаборатория ИИ-апскейла).
// Режимы: шторка, рядом, A/B (пробел — переключить). Зум колесом / кнопками и перетаскивание —
// общие для обеих картинок, чтобы смотреть одно и то же место. Обе рисуются в одной ширине
// (по большей), меньшая растягивается браузером — так видно, что добавила модель.

export type ViewerItem = { id: string; label: string; src: string; width: number; note?: string };

type Mode = "slider" | "side" | "ab";

export function UpscaleViewer({ items, initial, onClose }: { items: ViewerItem[]; initial: [string, string]; onClose: () => void }) {
  const [a, setA] = useState(initial[0]);
  const [b, setB] = useState(initial[1]);
  const [mode, setMode] = useState<Mode>("slider");
  const [split, setSplit] = useState(50);
  const [showB, setShowB] = useState(true);
  // «Вписать» (по умолчанию) или масштаб относительно 1:1 самой крупной версии
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [ratio, setRatio] = useState(1.5);
  const [area, setArea] = useState({ w: 1200, h: 800 });
  const areaRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [smooth, setSmooth] = useState(true);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const A = items.find((i) => i.id === a) ?? items[0];
  const B = items.find((i) => i.id === b) ?? items[1] ?? items[0];
  const W = Math.max(...items.map((i) => i.width || 0), 600);
  const cols = mode === "side" ? 2 : 1;
  const fit = Math.min(area.w / cols / W, area.h / (W * ratio)) * 0.96;
  const zoom = zoomMode === "fit" ? fit : zoomMode;
  const setZoom = (f: (z: number) => number) => setZoomMode(Math.min(8, Math.max(0.1, f(zoom))));

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === " ") { e.preventDefault(); setShowB((v) => !v); }
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(8, z * 1.5));
      if (e.key === "-") setZoom((z) => Math.max(0.25, z / 1.5));
      if (e.key === "0") { setZoomMode("fit"); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => setZoom((z) => z * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  const down = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
  };
  const up = () => { drag.current = null; };

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  const imgStyle = (it: ViewerItem): React.CSSProperties => ({
    width: W, maxWidth: "none", display: "block",
    imageRendering: !smooth && it.width < W ? "pixelated" : "auto",
  });
  const select = (value: string, set: (v: string) => void) => (
    <select value={value} onChange={(e) => set(e.target.value)}
      className="h-8 rounded-lg border border-gray-600 bg-gray-800 px-2 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none">
      {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
    </select>
  );

  // Обычная функция, а не компонент: иначе на каждом движении при перетаскивании панель
  // пересоздавалась бы и теряла захват указателя
  const pane = (it?: ViewerItem, children?: React.ReactNode) => (
    <div className="relative min-h-0 min-w-0 flex-1 cursor-grab overflow-hidden bg-[repeating-conic-gradient(#1f2937_0_25%,#111827_0_50%)] bg-[length:24px_24px] active:cursor-grabbing"
      onWheel={onWheel} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="absolute left-1/2 top-1/2" style={{ transform: `translate(-50%, -50%) ${transform}`, transformOrigin: "center" }}>
        {children ?? (it && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={it.src} alt="" draggable={false} style={imgStyle(it)}
            onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setRatio(i.naturalHeight / i.naturalWidth); }} />
        ))}
      </div>
      {it ? <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">{it.label}{it.note ? ` · ${it.note}` : ""}</span> : (
        <>
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">A: {A.label}{A.note ? ` · ${A.note}` : ""}</span>
          <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">B: {B.label}{B.note ? ` · ${B.note}` : ""}</span>
        </>
      )}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-950">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-2 text-sm text-gray-300">
        <span className="text-gray-500">A</span>{select(a, setA)}
        <span className="text-gray-500">B</span>{select(b, setB)}
        <Segmented value={mode} onChange={(v) => setMode(v as Mode)} options={[["slider", "Шторка"], ["side", "Рядом"], ["ab", "A/B (пробел)"]]} />
        <Segmented value={String(zoomMode)} onChange={(v) => { setZoomMode(v === "fit" ? "fit" : Number(v)); setPan({ x: 0, y: 0 }); }}
          options={[["fit", "Вписать"], ["1", "1:1"], ["2", "×2"], ["4", "×4"]]} />
        <span className="w-12 text-xs tabular-nums text-gray-500">{Math.round(zoom * 100)}%</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} className="accent-indigo-500" />
          сглаживать меньшую
        </label>
        <span className="text-xs text-gray-500">колесо — зум, тянуть — двигать, 0 — вписать</span>
        <button onClick={onClose} className="ml-auto rounded p-1.5 hover:bg-white/10" aria-label="Закрыть"><XMarkIcon className="h-6 w-6" /></button>
      </div>

      <div ref={areaRef} className="flex min-h-0 flex-1">
        {mode === "side" ? (
          <>
            {pane(A)}
            <div className="w-px bg-gray-700" />
            {pane(B)}
          </>
        ) : mode === "ab" ? (
          pane(showB ? B : A)
        ) : (
          pane(undefined, (
            <div className="relative" style={{ width: W }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={B.src} alt="" draggable={false} style={imgStyle(B)}
                onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setRatio(i.naturalHeight / i.naturalWidth); }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={A.src} alt="" draggable={false} style={{ ...imgStyle(A), position: "absolute", inset: 0, height: "100%", clipPath: `inset(0 ${100 - split}% 0 0)` }} />
              <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${split}%` }} />
            </div>
          ))
        )}
      </div>

      <div className={cx("flex items-center gap-3 border-t border-gray-800 px-4 py-2 text-xs text-gray-400", mode !== "slider" && "hidden")}>
        <span className="w-48 truncate text-right">← {A.label}</span>
        <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="flex-1 accent-amber-400" />
        <span className="w-48 truncate">{B.label} →</span>
      </div>
    </div>,
    document.body,
  );
}
