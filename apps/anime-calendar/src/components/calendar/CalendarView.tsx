"use client";
import { ChevronLeftIcon, ChevronRightIcon, FlagIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { useCalendar, useList } from "@/lib/client";
import { matchesAiring } from "@/lib/filters";
import {
  addDays, fetchRange, groupByDay, monthGrid, todayKey, weekDays, type DayItem, type GridDay,
} from "@/lib/schedule";
import { browserTimeZone, monthName, tzLabel } from "@/lib/time";
import { useUrlState } from "@/lib/useUrlState";
import { Drawer } from "../Drawer";
import { FilterPanel } from "../FilterPanel";
import { Button, ErrorBox, Skel, Spinner } from "../ui";
import { AgendaView } from "./AgendaView";
import { DayDrawer } from "./DayDrawer";
import { MonthGrid } from "./MonthGrid";
import { QuickFilters } from "./QuickFilters";
import { Segmented, plural } from "./shared";
import { WeekView } from "./WeekView";

type View = "month" | "week" | "agenda";
const AGENDA_DAYS = 14;

function agendaDays(start: string): GridDay[] {
  return Array.from({ length: AGENDA_DAYS }, (_, i) => {
    const key = addDays(start, i);
    return { key, day: Number(key.slice(8)), inMonth: true };
  });
}

export function CalendarView() {
  const tz = useMemo(browserTimeZone, []);
  const today = todayKey(tz);
  const { params, filters, setFilters, setParams } = useUrlState();

  // На телефоне по умолчанию лента, на компьютере — месяц
  const [fallbackView, setFallbackView] = useState<View>("month");
  useEffect(() => {
    if (window.matchMedia("(max-width: 640px)").matches) setFallbackView("agenda");
  }, []);
  const param = params.get("view");
  const view: View = param === "week" || param === "agenda" || param === "month" ? param : fallbackView;

  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get("d") ?? "") ? params.get("d")! : today;
  const [year, month] = anchor.split("-").map(Number);

  const days: GridDay[] = useMemo(
    () => (view === "month" ? monthGrid(year, month - 1) : view === "week" ? weekDays(anchor) : agendaDays(anchor)),
    [view, year, month, anchor]);
  const range = fetchRange(days[0].key, days.at(-1)!.key);
  const { data, error, isFetching, isLoading } = useCalendar(range.from, range.to);
  const { byId: list } = useList();

  const [openDay, setOpenDay] = useState<{ key: string; focus: number | null } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const byDay = useMemo(() => {
    if (!data) return new Map<string, DayItem[]>();
    const grouped = groupByDay(data.airings, data.media, tz);
    for (const [key, items] of grouped) {
      grouped.set(key, items.filter((i) => matchesAiring(i.kind, i.media, filters, list.get(i.media.id))));
    }
    return grouped;
  }, [data, tz, filters, list]);

  const visible = days.filter((d) => d.inMonth).map((d) => byDay.get(d.key) ?? []);
  const total = visible.reduce((n, items) => n + items.length, 0);
  const finales = visible.reduce((n, items) => n + items.filter((i) => i.kind === "finale").length, 0);

  const shift = (dir: -1 | 1) => {
    if (view === "month") setParams({ d: new Date(Date.UTC(year, month - 1 + dir, 1)).toISOString().slice(0, 10) });
    else setParams({ d: addDays(anchor, dir * 7) });
  };
  const lastMonth = monthName(Number(days.at(-1)!.key.slice(5, 7)) - 1);
  const title =
    view === "month"
      ? `${monthName(month - 1)} ${year}`
      : `${days[0].day} ${monthName(Number(days[0].key.slice(5, 7)) - 1).slice(0, 3)} – ${days.at(-1)!.day} ${lastMonth.slice(0, 3)}`;

  return (
    <div>
      {/* Шапка */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold first-letter:uppercase sm:text-3xl">{title}</h1>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => shift(-1)} aria-label="Назад"><ChevronLeftIcon className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => setParams({ d: null })}>Сегодня</Button>
          <Button size="sm" onClick={() => shift(1)} aria-label="Вперёд"><ChevronRightIcon className="h-4 w-4" /></Button>
        </div>
        {isFetching && <Spinner className="h-5 w-5" />}
        <div className="ml-auto">
          <Segmented<View>
            value={view}
            options={[["month", "Месяц"], ["week", "Неделя"], ["agenda", "Лента"]]}
            onChange={(v) => setParams({ view: v })}
          />
        </div>
      </div>

      <div className="mb-3">
        <QuickFilters filters={filters} onChange={setFilters} onMore={() => setFiltersOpen(true)} />
      </div>

      <p className="mb-3 flex flex-wrap items-center gap-x-2 text-sm text-gray-400">
        <FlagIcon className="h-4 w-4 text-purple-400" />
        {isLoading ? <span className="inline-flex"><Skel className="h-4 w-44" /></span> : filters.mode === "finales"
          ? `${finales} ${plural(finales, "финал", "финала", "финалов")} сезонов`
          : `${total} ${plural(total, "серия", "серии", "серий")}, из них ${finales} ${plural(finales, "финал", "финала", "финалов")}`}
        <span className="text-gray-600">·</span>
        <span title={tz}>время {tzLabel(Date.now() / 1000, tz)}</span>
      </p>

      {error ? <ErrorBox error={error} /> : null}
      {/* Пока расписание грузится, сетка дней уже настоящая (числа кликабельны), выпуски — заглушками */}
      {view === "month" ? (
        <MonthGrid days={days} byDay={byDay} today={today} loading={isLoading} onOpen={(key, focus) => setOpenDay({ key, focus: focus ?? null })} />
      ) : view === "week" ? (
        <WeekView days={days} byDay={byDay} today={today} loading={isLoading} onOpen={(key, focus) => setOpenDay({ key, focus: focus ?? null })} />
      ) : (
        <AgendaView days={days} byDay={byDay} today={today} loading={isLoading} />
      )}

      <DayDrawer
        day={openDay?.key ?? null}
        focus={openDay?.focus ?? null}
        byDay={byDay}
        today={today}
        onClose={() => setOpenDay(null)}
        onNavigate={(key) => setOpenDay({ key, focus: null })}
      />

      <Drawer open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Фильтры" width="sm:w-[26rem]">
        <FilterPanel filters={filters} onChange={setFilters} showMode />
      </Drawer>
    </div>
  );
}
