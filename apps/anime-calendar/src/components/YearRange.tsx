"use client";
import { useEffect, useState } from "react";

// Диапазон лет «с — по»: двойной слайдер + поля ввода. 0 — граница не задана (крайнее значение).

export const MIN_YEAR = 1960;
export const maxYear = () => new Date().getFullYear() + 1;

const thumb =
  "pointer-events-none absolute inset-x-0 top-1/2 h-0 w-full -translate-y-1/2 appearance-none bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer " +
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-400 " +
  "[&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-gray-900 " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer " +
  "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-indigo-400";

const input =
  "h-8 w-20 rounded-md border border-gray-600 bg-gray-800 px-2 text-center text-sm tabular-nums text-gray-200 focus:border-indigo-500 focus:outline-none";

export function YearRange({ from, to, onChange }: { from: number; to: number; onChange: (from: number, to: number) => void }) {
  const max = maxYear();
  const lo = from || MIN_YEAR;
  const hi = to || max;
  // Слайдер двигается сразу, а в URL (и запрос) значение уходит после отпускания
  const [drag, setDrag] = useState<[number, number]>([lo, hi]);
  useEffect(() => setDrag([lo, hi]), [lo, hi]);
  const commit = ([a, b]: [number, number]) => onChange(a <= MIN_YEAR ? 0 : a, b >= max ? 0 : b);
  const pct = (y: number) => ((y - MIN_YEAR) / (max - MIN_YEAR)) * 100;

  return (
    <div className="w-full space-y-3">
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gray-700" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-indigo-500"
          style={{ left: `${pct(drag[0])}%`, right: `${100 - pct(drag[1])}%` }} />
        <input type="range" min={MIN_YEAR} max={max} value={drag[0]} aria-label="Год с" className={thumb}
          onChange={(e) => setDrag([Math.min(Number(e.target.value), drag[1]), drag[1]])}
          onPointerUp={() => commit(drag)} onKeyUp={() => commit(drag)} />
        <input type="range" min={MIN_YEAR} max={max} value={drag[1]} aria-label="Год по" className={thumb}
          onChange={(e) => setDrag([drag[0], Math.max(Number(e.target.value), drag[0])])}
          onPointerUp={() => commit(drag)} onKeyUp={() => commit(drag)} />
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-400">
        с <YearInput value={from} placeholder={String(MIN_YEAR)} onCommit={(y) => commit([y || MIN_YEAR, Math.max(y, hi)])} />
        по <YearInput value={to} placeholder={String(max)} onCommit={(y) => commit([Math.min(y || max, lo), y || max])} />
        {(from || to) ? <button type="button" onClick={() => onChange(0, 0)} className="ml-auto text-xs text-indigo-300 hover:text-indigo-200">Все годы</button> : null}
      </div>
    </div>
  );
}

/** Поле года: применяется по Enter или потере фокуса; пустое — без границы. */
function YearInput({ value, placeholder, onCommit }: { value: number; placeholder: string; onCommit: (y: number) => void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const apply = () => {
    const y = Number(text);
    if (!text.trim()) return onCommit(0);
    if (y >= MIN_YEAR && y <= maxYear()) onCommit(y);
    else setText(value ? String(value) : "");
  };
  return (
    <input inputMode="numeric" maxLength={4} value={text} placeholder={placeholder} className={input}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ""))} onBlur={apply}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), apply())} />
  );
}
