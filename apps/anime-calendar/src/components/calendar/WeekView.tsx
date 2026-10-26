"use client";
import { displayTitle, type DayItem, type GridDay } from "@/lib/schedule";
import { formatTime, WEEKDAYS } from "@/lib/time";
import { KindBadge } from "../AnimeQuick";
import { cx } from "../ui";
import { ListDot, type OpenDay } from "./shared";
import { imgSrc } from "@/lib/img";
import { HoverZone } from "../HoverCard";

/** Неделя: 7 колонок с карточками по времени и линией «сейчас» в текущем дне. */
export function WeekView({ days, byDay, today, onOpen }: {
  days: GridDay[];
  byDay: Map<string, DayItem[]>;
  today: string;
  onOpen: OpenDay;
}) {
  const nowSec = Date.now() / 1000;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
      {days.map((d, i) => {
        const items = [...(byDay.get(d.key) ?? [])].sort((a, b) => a.airing.airingAt - b.airing.airingAt);
        const isToday = d.key === today;
        // Индекс, перед которым рисуем линию «сейчас»
        const nowIndex = isToday ? items.findIndex((it) => it.airing.airingAt > nowSec) : -1;
        return (
          <section key={d.key} className={cx("flex min-w-0 flex-col rounded-xl bg-gray-800/40 ring-1",
            isToday ? "ring-indigo-500" : "ring-gray-800", d.key < today && "opacity-70")}>
            <button onClick={() => onOpen(d.key)} className="flex items-baseline justify-between rounded-t-xl px-3 py-2 hover:bg-gray-800">
              <span className={cx("text-sm font-semibold", i >= 5 ? "text-indigo-300" : "text-gray-300")}>{WEEKDAYS[i]}</span>
              <span className={cx("text-xl font-bold", isToday && "text-indigo-400")}>{d.day}</span>
            </button>
            <div className="flex-1 space-y-1.5 p-2 pt-0">
              {items.length === 0 && <p className="py-6 text-center text-xs text-gray-600">Нет серий</p>}
              {items.map((item, n) => (
                <div key={`${item.media.id}-${item.airing.episode}`}>
                  {n === nowIndex && (
                    <div className="my-1 flex items-center gap-1 text-[10px] font-semibold text-red-400">
                      <span className="h-px flex-1 bg-red-500" /> сейчас <span className="h-px flex-1 bg-red-500" />
                    </div>
                  )}
                  <HoverZone media={item.media}>
                  <button onClick={() => onOpen(d.key, item.media.id)}
                    className={cx("flex w-full gap-2 rounded-lg p-1.5 text-left transition hover:bg-gray-700/60",
                      item.kind === "finale" && "bg-purple-600/15 ring-1 ring-purple-500/50")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imgSrc(item.media.coverImage.large ?? "", "thumb")} alt="" loading="lazy" className="h-[72px] w-12 shrink-0 rounded-md object-cover"
                      style={{ backgroundColor: item.media.coverImage.color ?? undefined }} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="line-clamp-2 text-xs font-medium leading-tight">{displayTitle(item.media.title)}</p>
                      <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
                        <span className="tabular-nums">{formatTime(item.airing.airingAt)}</span>
                        <ListDot mediaId={item.media.id} />
                      </p>
                      <KindBadge kind={item.kind} episode={item.airing.episode} total={item.media.episodes} />
                    </div>
                  </button>
                  </HoverZone>
                </div>
              ))}
              {isToday && nowIndex === -1 && items.length > 0 && (
                <div className="my-1 flex items-center gap-1 text-[10px] font-semibold text-red-400">
                  <span className="h-px flex-1 bg-red-500" /> сейчас <span className="h-px flex-1 bg-red-500" />
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
