"use client";
import type { DayItem, GridDay } from "@/lib/schedule";
import { AnimeQuick } from "../AnimeQuick";
import { EmptyState, Skel, cx } from "../ui";
import { dayStats, dayTitle } from "./shared";

/** Лента: дни сверху вниз, крупные карточки. Удобно на телефоне и чтобы просмотреть неделю целиком. */
export function AgendaView({ days, byDay, today, loading }: { days: GridDay[]; byDay: Map<string, DayItem[]>; today: string; loading?: boolean }) {
  if (loading) return <AgendaSkeleton />;
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

/** Пока расписание грузится: два дня с карточками той же формы (постер и строки справа). */
function AgendaSkeleton() {
  return (
    <div className="space-y-8" aria-busy>
      {[0, 1].map((d) => (
        <section key={d}>
          <div className="mb-3 flex items-baseline gap-x-3 py-2"><Skel className="h-6 w-40" /><Skel className="h-4 w-24" /></div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-800">
                <Skel className="aspect-2/3 w-24 shrink-0 rounded-lg sm:w-28" />
                <div className="min-w-0 flex-1 space-y-2"><Skel className="h-5 w-3/4" /><Skel className="h-3 w-1/2" /><Skel className="h-4 w-2/3" /><Skel className="h-4 w-1/2" /></div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
