"use client";
import { useId, useRef, useState } from "react";
import { cx } from "./ui";

// Лёгкие SVG-графики на цветах палитры (без библиотек): радар, столбики, кривая, кольцо, полосы.
// Все реагируют на наведение: подсветка элемента и подсказка с цифрами.

const C = (tone: string, step = 400) => `var(--color-${tone}-${step})`;

/** Подсказка над графиком (координаты — в процентах от контейнера). */
function Tip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-gray-950/95 px-2.5 py-1.5 text-xs text-gray-100 shadow-xl ring-1 ring-gray-700"
      style={{ left: `${x}%`, top: `calc(${y}% - 8px)` }}>
      {children}
    </div>
  );
}

/** Радар («роза ветров»): значения 0–1, подписи по кругу; наведение на ось — подсказка. */
export function Radar({ items, size = 280, tone = "accent", rings = 4 }: {
  items: { label: string; value: number; hint?: string }[]; size?: number; tone?: string; rings?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(3, items.length);
  // Поля под подписи (самая длинная — «Сверхъестественное»)
  const r = size / 2 - 72;
  const cx0 = size / 2;
  const cy0 = size / 2;
  const pt = (i: number, k: number) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx0 + Math.cos(a) * r * k, cy0 + Math.sin(a) * r * k] as const;
  };
  const poly = items.map((it, i) => pt(i, Math.max(0.04, it.value)).join(",")).join(" ");
  const h = hover !== null ? pt(hover, Math.max(0.04, items[hover].value)) : null;
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-full overflow-visible">
        <defs>
          <radialGradient id={`r${id}`}>
            <stop offset="0" stopColor={C(tone, 300)} stopOpacity="0.55" />
            <stop offset="1" stopColor={C(tone, 500)} stopOpacity="0.25" />
          </radialGradient>
        </defs>
        {Array.from({ length: rings }, (_, k) => (
          <polygon key={k} points={items.map((_, i) => pt(i, (k + 1) / rings).join(",")).join(" ")}
            fill="none" stroke="var(--color-neutral-700)" strokeOpacity={k === rings - 1 ? 0.9 : 0.5} />
        ))}
        {items.map((_, i) => (
          <line key={i} x1={cx0} y1={cy0} x2={pt(i, 1)[0]} y2={pt(i, 1)[1]}
            stroke={hover === i ? C(tone, 300) : "var(--color-neutral-700)"} strokeOpacity={hover === i ? 0.9 : 0.5} className="transition-[stroke] duration-200" />
        ))}
        <polygon points={poly} fill={`url(#r${id})`} stroke={C(tone, 300)} strokeWidth="2" strokeLinejoin="round" />
        {items.map((it, i) => {
          const [x, y] = pt(i, Math.max(0.04, it.value));
          return <circle key={i} cx={x} cy={y} r={hover === i ? 6 : 3.5} fill={C(tone, hover === i ? 100 : 200)} className="transition-all duration-200" />;
        })}
        {items.map((it, i) => {
          const [x, y] = pt(i, 1.18);
          const anchor = Math.abs(x - cx0) < 8 ? "middle" : x > cx0 ? "start" : "end";
          return (
            <text key={i} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fontSize="11"
              fill={hover === i ? C(tone, 200) : "var(--color-neutral-300)"} fontWeight={hover === i ? 600 : 400} className="transition-colors duration-200">{it.label}</text>
          );
        })}
        {/* Зоны наведения: сектор вокруг каждой оси */}
        {items.map((_, i) => {
          const [x1, y1] = pt(i - 0.5, 1.3);
          const [x2, y2] = pt(i + 0.5, 1.3);
          return <polygon key={i} points={`${cx0},${cy0} ${x1},${y1} ${x2},${y2}`} fill="transparent" onMouseEnter={() => setHover(i)} />;
        })}
      </svg>
      {hover !== null && h && <Tip x={(h[0] / size) * 100} y={(h[1] / size) * 100}>{items[hover].hint ?? items[hover].label}</Tip>}
    </div>
  );
}

/** Вертикальные столбики с подписями снизу; наведение — подсказка. */
export function Columns({ items, height = 120, tone = "accent", highlight }: {
  items: { label: string; value: number; title?: string }[]; height?: number; tone?: string; highlight?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="relative flex items-end gap-1" style={{ height: height + 20 }} onMouseLeave={() => setHover(null)}>
      {items.map((it, i) => {
        const on = hover === i || (hover === null && highlight === i);
        return (
          <div key={i} className="flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end gap-1" onMouseEnter={() => setHover(i)}>
            <div className="w-full rounded-t-md transition-all duration-200" style={{
              height: Math.max(2, (it.value / max) * height),
              background: `linear-gradient(to top, ${C(tone, on ? 500 : 700)}, ${C(tone, on ? 300 : 500)})`,
              opacity: it.value ? (hover === null || hover === i ? 1 : 0.55) : 0.3,
            }} />
            <span className={cx("w-full truncate text-center text-[10px] transition-colors", hover === i ? "text-gray-200" : "text-gray-500")}>{it.label}</span>
          </div>
        );
      })}
      {hover !== null && (
        <Tip x={((hover + 0.5) / items.length) * 100} y={100 - ((Math.max(2, (items[hover].value / max) * height) + 20) / (height + 20)) * 100}>
          {items[hover].title ?? `${items[hover].label}: ${items[hover].value}`}
        </Tip>
      )}
    </div>
  );
}

/** Плавная кривая с заливкой; наведение — вертикальная линия, точка и подсказка. */
export function AreaChart({ points, height = 160, tone = "positive", format }: {
  points: { label: string; value: number; title?: string }[]; height?: number; tone?: string; format?: (v: number) => string;
}) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const pad = 8;
  const max = Math.max(1, ...points.map((p) => p.value));
  const xy = points.map((p, i) => [pad + (i / Math.max(1, points.length - 1)) * (W - 2 * pad), H - pad - (p.value / max) * (H - 2 * pad)] as const);
  // Монотонная кривая (без «перелётов» ниже нуля): касательные по Фритчу — Карлсону
  const path = (() => {
    if (xy.length < 2) return "";
    const m = xy.map((_, i) => {
      if (i === 0 || i === xy.length - 1) return 0;
      const d0 = (xy[i][1] - xy[i - 1][1]) / (xy[i][0] - xy[i - 1][0]);
      const d1 = (xy[i + 1][1] - xy[i][1]) / (xy[i + 1][0] - xy[i][0]);
      return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
    });
    let d = `M${xy[0][0]},${xy[0][1]}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const dx = (xy[i + 1][0] - xy[i][0]) / 3;
      d += ` C${xy[i][0] + dx},${xy[i][1] + m[i] * dx} ${xy[i + 1][0] - dx},${xy[i + 1][1] - m[i + 1] * dx} ${xy[i + 1][0]},${xy[i + 1][1]}`;
    }
    return d;
  })();
  const onMove = (e: React.MouseEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((x - pad) / (W - 2 * pad)) * (points.length - 1)))));
  };
  const step = Math.ceil(points.length / 7);
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C(tone, 400)} stopOpacity="0.45" />
            <stop offset="1" stopColor={C(tone, 600)} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((k) => <line key={k} x1={0} x2={W} y1={pad + k * (H - 2 * pad)} y2={pad + k * (H - 2 * pad)} stroke="var(--color-neutral-800)" />)}
        {path && <path d={`${path} L${xy.at(-1)![0]},${H} L${xy[0][0]},${H} Z`} fill={`url(#a${id})`} />}
        {path && <path d={path} fill="none" stroke={C(tone, 300)} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
        {hover !== null && (
          <>
            <line x1={xy[hover][0]} x2={xy[hover][0]} y1={0} y2={H} stroke={C(tone, 300)} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
            <circle cx={xy[hover][0]} cy={xy[hover][1]} r="5" fill={C(tone, 200)} stroke="var(--color-neutral-900)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-gray-500">
        {points.map((p, i) => (i % step === 0 || i === points.length - 1 ? <span key={i}>{p.label}</span> : null))}
      </div>
      {hover !== null && (
        <Tip x={(xy[hover][0] / W) * 100} y={(xy[hover][1] / H) * 100 * (H / (H + 16))}>
          {points[hover].title ?? `${points[hover].label}: ${format ? format(points[hover].value) : points[hover].value}`}
        </Tip>
      )}
    </div>
  );
}

/** Кольцо долей (форматы, статусы); наведение — доля в центре. */
export function Donut({ items, size = 140, center }: { items: { label: string; value: number; tone: string }[]; size?: number; center?: React.ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let acc = 0;
  return (
    <div className="relative" style={{ width: size, height: size }} onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--color-neutral-800)" strokeWidth="14" />
        {items.map((it, i) => {
          const len = (it.value / total) * 100;
          const el = <circle key={it.label} cx="50" cy="50" r="40" fill="none" stroke={C(it.tone, hover === i ? 300 : 400)} strokeWidth={hover === i ? 17 : 14}
            pathLength={100} strokeDasharray={`${Math.max(0, len - 0.8)} 100`} strokeDashoffset={-acc} className="cursor-default transition-all duration-200"
            onMouseEnter={() => setHover(i)} />;
          acc += len;
          return el;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        {hover !== null ? (
          <><b className="text-lg">{Math.round((items[hover].value / total) * 100)}%</b><span className="max-w-16 truncate text-[10px] text-gray-400">{items[hover].label}</span></>
        ) : center}
      </div>
    </div>
  );
}

/** Горизонтальная полоса 0–100 с подписью (атрибуты); наведение — что это и из чего посчитано. */
export function StatBar({ name, value, hint, desc, tone = "accent" }: { name: string; value: number; hint?: string; desc?: string; tone?: string }) {
  return (
    <div className="group relative">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-gray-300 transition-colors group-hover:text-white">{name}</span>
        <span className="font-semibold tabular-nums text-gray-100">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-800">
        <div className="h-full rounded-full transition-all duration-300 group-hover:brightness-125" style={{ width: `${value}%`, background: `linear-gradient(90deg, ${C(tone, 600)}, ${C(tone, 300)})` }} />
      </div>
      {(desc || hint) && (
        <div className="pointer-events-none invisible absolute left-0 right-0 top-full z-20 mt-1.5 rounded-lg bg-gray-950/95 p-2.5 text-xs opacity-0 shadow-xl ring-1 ring-gray-700 transition duration-150 group-hover:visible group-hover:opacity-100">
          {desc && <p className="text-gray-200">{desc}</p>}
          {hint && <p className="mt-1 text-gray-400">Сейчас: {hint}</p>}
        </div>
      )}
    </div>
  );
}
