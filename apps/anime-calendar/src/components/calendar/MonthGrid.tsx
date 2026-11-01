"use client";
import { useEffect, useRef, useState } from "react";
import type { DayItem, GridDay } from "@/lib/schedule";
import { WEEKDAYS } from "@/lib/time";
import { cx, Skel } from "../ui";
import { CellRow, type OpenDay } from "./shared";

const ROW = 24; // высота строки тайтла с отступом
const HEADER = 28; // число дня

/** Сколько строк влезает в ячейку: считаем по реальной высоте, а не фиксированные 3. */
function useCapacity() {
  const ref = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCapacity(Math.max(1, Math.floor((entry.contentRect.height - HEADER) / ROW)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, capacity };
}

function DayCell({ day, items, today, past, onOpen, loading }: {
  day: GridDay;
  items: DayItem[];
  today: string;
  past: boolean;
  onOpen: OpenDay;
  loading?: boolean;
}) {
  const { ref, capacity } = useCapacity();
  const shown = items.slice(0, capacity);
  const hidden = items.length - shown.length;
  return (
    <div ref={ref}
      className={cx("group relative flex min-h-0 flex-col overflow-hidden p-1.5 transition",
        day.inMonth ? "bg-gray-900" : "bg-gray-950/60", past && day.inMonth && "bg-gray-900/60",
        day.key === today && "ring-2 ring-inset ring-indigo-500")}>
      <button onClick={() => onOpen(day.key)} className="mb-1 flex h-6 shrink-0 items-center justify-between rounded px-1 hover:bg-gray-800">
        <span className={cx("text-xs font-semibold",
          day.key === today ? "rounded-full bg-indigo-600 px-1.5 text-white" : day.inMonth ? (past ? "text-gray-500" : "text-gray-200") : "text-gray-700")}>
          {day.day}
        </span>
        {/* Не влезло — счётчик в заголовке, а не отдельной строкой: так в дне видно больше тайтлов */}
        {hidden > 0 && (
          <span className="hidden rounded-full bg-gray-800 px-1.5 text-[10px] font-semibold text-indigo-300 group-hover:bg-indigo-600 group-hover:text-white sm:inline">
            +{hidden}
          </span>
        )}
      </button>
      {items.length > 0 && <button onClick={() => onOpen(day.key)} aria-label={`${day.day}: ${items.length} выпусков, открыть день`}
        className="flex min-h-9 flex-1 items-center justify-center rounded-md bg-indigo-500/15 text-xs font-semibold text-indigo-200 sm:hidden">{items.length}</button>}
      {loading && <Skel className="h-9 w-full sm:hidden" />}
      <div className={cx("hidden min-h-0 space-y-0.5 sm:block", (!day.inMonth || past) && "opacity-60")}>
        {/* Пока расписание грузится — строки-заглушки разной длины, число дня уже настоящее */}
        {loading && Array.from({ length: Math.min(capacity, 1 + (day.day % 3)) }, (_, i) => <Skel key={i} className={cx("h-5.5", i % 2 ? "w-2/3" : "w-full")} />)}
        {shown.map((item) => (
          <CellRow key={`${item.media.id}-${item.airing.episode}`} item={item}
            onClick={() => onOpen(day.key, item.media.id)} />
        ))}
      </div>
    </div>
  );
}

export function MonthGrid({ days, byDay, today, onOpen, height, loading }: {
  days: GridDay[];
  byDay: Map<string, DayItem[]>;
  today: string;
  onOpen: OpenDay;
  /** Высота сетки (Tailwind-классы); по умолчанию — на весь экран */
  height?: string;
  /** Расписание ещё не пришло: сетка настоящая, выпуски — заглушками */
  loading?: boolean;
}) {

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-gray-800" aria-busy={loading || undefined}>
      <div className="grid grid-cols-7 bg-gray-800/80 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {WEEKDAYS.map((d, i) => <div key={d} className={cx("py-2", i >= 5 && "text-indigo-300/80")}>{d}</div>)}
      </div>
      {/* Сетка занимает экран целиком: чем выше окно, тем больше тайтлов видно в дне */}
      <div className={cx("grid grid-cols-7 gap-px bg-gray-800", height ?? "h-[calc(100vh-15rem)] min-h-[36rem]")}
        style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}>
        {days.map((d) => (
          <DayCell key={d.key} day={d} items={byDay.get(d.key) ?? []} today={today} past={d.key < today}
            onOpen={onOpen} loading={loading} />
        ))}
      </div>
    </div>
  );
}
