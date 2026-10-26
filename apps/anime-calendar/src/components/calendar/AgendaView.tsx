"use client";
import type { DayItem, GridDay } from "@/lib/schedule";
import { AnimeQuick } from "../AnimeQuick";
import { EmptyState, cx } from "../ui";
import { dayStats, dayTitle } from "./shared";

/** Лента: дни сверху вниз, крупные карточки. Удобно на телефоне и чтобы просмотреть неделю целиком. */
export function AgendaView({ days, byDay, today }: { days: GridDay[]; byDay: Map<string, DayItem[]>; today: string }) {
  const withItems = days.filter((d) => (byDay.get(d.key) ?? []).length);
  if (!withItems.length) return <EmptyState title="В эти дни ничего не выходит">Попробуй «Все серии» или ослабь фильтры.</EmptyState>;
  return (
    <div className="space-y-8">
      {withItems.map((d) => {
        const items = [...byDay.get(d.key)!].sort((a, b) => a.airing.airingAt - b.airing.airingAt);
        return (
          <section key={d.key}>
            <header className={cx("sticky top-16 z-10 -mx-4 mb-3 flex flex-wrap items-baseline gap-x-3 bg-gray-900/90 px-4 py-2 backdrop-blur lg:-mx-8 lg:px-8",
              d.key === today && "text-indigo-300")}>
              <h2 className="text-lg font-bold first-letter:uppercase">{dayTitle(d.key, today)}</h2>
              <span className="text-sm text-gray-500">{dayStats(items)}</span>
            </header>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {items.map((item) => (
                <div key={`${item.media.id}-${item.airing.episode}`}
                  className={cx("rounded-xl bg-gray-800/50 p-3 ring-1", item.kind === "finale" ? "ring-purple-500/60" : "ring-gray-800")}>
                  <AnimeQuick media={item.media} airing={{ ...item.airing, kind: item.kind }} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
