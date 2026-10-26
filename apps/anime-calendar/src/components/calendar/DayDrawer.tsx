"use client";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef } from "react";
import { addDays, type DayItem } from "@/lib/schedule";
import { AnimeQuick } from "../AnimeQuick";
import { Drawer } from "../Drawer";
import { cx } from "../ui";
import { dayStats, dayTitle } from "./shared";

/** Панель дня: все серии крупными карточками; выбранный тайтл прокручен и подсвечен. */
export function DayDrawer({ day, focus, byDay, today, onClose, onNavigate }: {
  day: string | null;
  focus: number | null;
  byDay: Map<string, DayItem[]>;
  today: string;
  onClose: () => void;
  onNavigate: (key: string) => void;
}) {
  const items = day ? [...(byDay.get(day) ?? [])].sort((a, b) => a.airing.airingAt - b.airing.airingAt) : [];
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus && focusRef.current) focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, day]);

  return (
    <Drawer
      open={Boolean(day)}
      onClose={onClose}
      title={day ? dayTitle(day, today) : ""}
      subtitle={items.length ? dayStats(items) : "Нет серий по текущим фильтрам"}
      actions={day && (
        <div className="flex gap-1">
          <button onClick={() => onNavigate(addDays(day, -1))} className="rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Предыдущий день">
            <ChevronLeftIcon className="h-5 w-5" />
          </button>
          <button onClick={() => onNavigate(addDays(day, 1))} className="rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Следующий день">
            <ChevronRightIcon className="h-5 w-5" />
          </button>
        </div>
      )}
    >
      <div className="space-y-3">
        {items.map((item) => {
          const focused = item.media.id === focus;
          return (
            <div key={`${item.media.id}-${item.airing.episode}`} ref={focused ? focusRef : undefined}
              className={cx("rounded-xl p-3 ring-1 transition",
                focused ? "bg-indigo-600/15 ring-2 ring-indigo-500" : item.kind === "finale" ? "bg-gray-800/50 ring-purple-500/50" : "bg-gray-800/50 ring-gray-800")}>
              <AnimeQuick media={item.media} airing={{ ...item.airing, kind: item.kind }} />
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}
