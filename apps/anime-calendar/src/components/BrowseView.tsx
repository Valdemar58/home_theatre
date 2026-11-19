"use client";
import { AdjustmentsHorizontalIcon } from "@heroicons/react/24/outline";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, useList } from "@/lib/client";
import { activeFilterCount, filtersToParams, matchesMedia, type Filters } from "@/lib/filters";
import { SEASON_LABELS } from "@/lib/labels";
import type { MediaLite } from "@/lib/types";
import { useInView } from "@/lib/useInView";
import { useUrlState } from "@/lib/useUrlState";
import { FilterPanel } from "./FilterPanel";
import { FilterPresets } from "./FilterPresets";
import { TitleCard } from "./TitleCard";
import { Button, EmptyState, ErrorBox, Modal, SkelPosters } from "./ui";

const SORTS: [string, string][] = [
  ["POPULARITY_DESC", "Популярные"],
  ["SCORE_DESC", "По оценке AniList"],
  ["TRENDING_DESC", "В тренде"],
  ["START_DATE_DESC", "Новые"],
];

/** «Каталог», «Осень 2026», «2010–2015», «Зима, Весна · с 2020». */
function periodTitle(f: Filters): string {
  const years = f.yearFrom && f.yearFrom === f.yearTo ? String(f.yearFrom)
    : f.yearFrom && f.yearTo ? `${f.yearFrom}–${f.yearTo}`
    : f.yearFrom ? `с ${f.yearFrom}` : f.yearTo ? `по ${f.yearTo}` : "";
  const seasons = f.seasons.map((s) => SEASON_LABELS[s]).join(", ");
  if (!years && !seasons) return "Каталог";
  return f.seasons.length === 1 && years && !years.includes(" ") ? `${seasons} ${years}` : [seasons, years].filter(Boolean).join(" · ");
}

export function BrowseView() {
  const { params, filters, setFilters, setParams } = useUrlState();
  const { byId } = useList();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searching = Boolean(filters.q.trim());
  const sort = params.get("sort") ?? "";

  const query = useInfiniteQuery({
    queryKey: ["browse", sort, filtersToParams({ ...filters, list: "any" }).toString()],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const p = filtersToParams({ ...filters, list: "any" });
      if (sort) p.set("sort", sort);
      p.set("page", String(pageParam));
      return api<{ media: MediaLite[]; hasNextPage: boolean }>(`/api/browse?${p}`);
    },
    getNextPageParam: (last, pages) => (last.hasNextPage ? pages.length + 1 : undefined),
    staleTime: 10 * 60_000,
  });

  // Фильтр по спискам применяется на клиенте (AniList про наши списки не знает)
  const items = (query.data?.pages.flatMap((p) => p.media) ?? []).filter((m) => matchesMedia(m, { ...filters, q: "" }, byId.get(m.id)));
  const count = activeFilterCount(filters);
  const more = useInView<HTMLDivElement>(() => void query.fetchNextPage(), Boolean(query.hasNextPage && !query.isFetchingNextPage && !query.isLoading));
  const select = "h-9 rounded-lg border border-gray-600 bg-gray-800 px-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none";

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-2xl font-bold sm:text-3xl">{searching ? `Поиск: «${filters.q}»` : periodTitle(filters)}</h1>
          <select className={select} value={sort} onChange={(e) => setParams({ sort: e.target.value || null })}>
            <option value="">{searching ? "По совпадению" : "Популярные"}</option>
            {SORTS.slice(1).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          {searching && <Button size="sm" className="h-9" onClick={() => setFilters({ ...filters, q: "" })}>Сбросить поиск</Button>}
          <Button size="sm" className="h-9 xl:hidden" onClick={() => setFiltersOpen(true)}>
            <AdjustmentsHorizontalIcon className="h-4 w-4" /> Фильтры{count ? ` (${count})` : ""}
          </Button>
        </div>

        {!searching && <FilterPresets />}

        {query.error ? <ErrorBox error={query.error} /> : null}
        {query.isLoading ? (
          // Шапка и фильтры уже работают, вместо постеров — заглушки в той же сетке
          <div aria-busy><SkelPosters count={21} className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7" /></div>
        ) : items.length === 0 ? (
          <EmptyState title="Ничего не найдено">Попробуй ослабить фильтры.</EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7">
            {items.map((m) => <TitleCard key={m.id} media={m} entry={byId.get(m.id)} />)}
          </div>
        )}
        {/* Бесконечная лента: следующая страница — при подходе к концу; кнопка — запасной вариант */}
        <div ref={more} />
        {query.hasNextPage && (
          <div className="mt-8 flex justify-center">
            <Button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Загрузка…" : "Показать ещё"}
            </Button>
          </div>
        )}
      </div>

      <aside className="hidden w-80 shrink-0 xl:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl bg-gray-800/60 p-5 ring-1 ring-gray-700">
          <FilterPanel filters={filters} onChange={setFilters} showPeriod />
        </div>
      </aside>
      <Modal open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Фильтры">
        <FilterPanel filters={filters} onChange={setFilters} showPeriod />
      </Modal>
    </div>
  );
}
