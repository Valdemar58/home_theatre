"use client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, useCalendar, useList } from "@/lib/client";
import { addDays, fetchRange, groupByDay, todayKey, weekDays, type DayItem } from "@/lib/schedule";
import { browserTimeZone } from "@/lib/time";
import type { RecoResponse } from "@/server/reco/engine";
import { AnimeQuick } from "./AnimeQuick";
import { AgendaView } from "./calendar/AgendaView";
import { MonthGrid } from "./calendar/MonthGrid";
import { CellRow } from "./calendar/shared";
import { WeekView } from "./calendar/WeekView";
import { ListControl } from "./ListControl";
import { Poster } from "./Poster";
import { RecCard } from "./RecommendationsView";
import { TitleCard } from "./TitleCard";
import { SkelPosters } from "./ui";

// Временная страница (TASKS.md 3.9): все варианты представления тайтла на реальных данных —
// для обратной связи по унификации карточек и всплывающего окна при наведении.

function Variant({ id, title, where, children }: { id: string; title: string; where: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl bg-gray-800/40 p-5 ring-1 ring-gray-700">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="rounded-md bg-indigo-600 px-2 py-0.5 text-sm font-bold">{id}</span>
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-gray-400">где: {where}</span>
      </div>
      {children}
    </section>
  );
}

export function CardsPreview() {
  const { data: list } = useList();
  const tz = browserTimeZone();
  const today = todayKey(tz);
  // Две недели: сетке месяца нужно несколько строк, иначе одна неделя растягивается на весь экран
  const days = weekDays(today);
  const twoWeeks = [...days, ...weekDays(addDays(today, 7))];
  const range = fetchRange(days[0].key, addDays(twoWeeks[13].key, 1));
  const { data: cal } = useCalendar(range.from, range.to);
  const byDay = useMemo(() => (cal ? groupByDay(cal.airings, cal.media, tz) : new Map<string, DayItem[]>()), [cal, tz]);
  const { data: reco } = useQuery({ queryKey: ["recommendations"], queryFn: () => api<RecoResponse>("/api/recommendations"), staleTime: 10 * 60_000 });

  const intro = (
    <div>
      <h1 className="text-2xl font-bold">Варианты карточек</h1>
      <p className="mt-1 text-sm text-gray-400">
        Все места, где показывается тайтл, — на ваших данных. Ссылайтесь на номера (A1, B2…) в отзыве:
        что унифицировать, какой вариант взять за основу, где нужно всплывающее окно при наведении.
      </p>
    </div>
  );
  // Список ещё не пришёл: заголовки вариантов настоящие, постеры — заглушки
  if (!list) return (
    <div className="space-y-6" aria-busy>
      {intro}
      <Variant id="A1" title="Постер-карточка" where="каталог, «Связанное», «Похожее» (без статуса)">
        <SkelPosters count={3} className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4" />
      </Variant>
      <Variant id="A2" title="Постер-карточка со статусом / прогнозом" where="каталог (тайтл в списке), «Похожее» (прогноз в углу)">
        <SkelPosters count={4} className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4" />
      </Variant>
    </div>
  );
  const withMedia = list.filter((e) => e.media);
  const watching = withMedia.find((e) => e.status === "watching") ?? withMedia[0];
  const completed = withMedia.find((e) => e.status === "completed" && e.score) ?? withMedia.find((e) => e.status === "completed") ?? withMedia[1];
  const planned = withMedia.find((e) => e.status === "planned") ?? withMedia[2];
  const anyDay = [...byDay.values()].flat();
  const sampleItem = anyDay[0];

  return (
    <div className="space-y-6">
      {intro}

      <Variant id="A1" title="Постер-карточка" where="каталог, «Связанное», «Похожее» (без статуса)">
        <div className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
          {[watching, completed, planned].filter(Boolean).map((e) => <TitleCard key={e!.anilistId} media={e!.media!} />)}
        </div>
      </Variant>

      <Variant id="A2" title="Постер-карточка со статусом / прогнозом" where="каталог (тайтл в списке), «Похожее» (прогноз в углу)">
        <div className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
          {watching && <TitleCard media={watching.media!} entry={watching} />}
          {completed && <TitleCard media={completed.media!} entry={completed} />}
          {planned && <TitleCard media={planned.media!} match={92} />}
          {planned && <TitleCard media={planned.media!} match={58} />}
        </div>
      </Variant>

      <Variant id="A3" title="Постер-карточка со статусом и сериями" where="«Мои списки»">
        <div className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
          {[watching, completed].filter(Boolean).map((e) => (
            <TitleCard key={e!.anilistId} media={e!.media!} footer={<ListControl media={e!.media!} compact />} />
          ))}
        </div>
      </Variant>

      <Variant id="B1" title="Строка выпуска в ячейке календаря" where="календарь: месяц, ячейка дня">
        <div className="max-w-xs space-y-1 rounded-lg bg-gray-900/60 p-2">
          {anyDay.slice(0, 4).map((i) => <CellRow key={`${i.media.id}-${i.airing.episode}`} item={i} onClick={() => undefined} />)}
        </div>
      </Variant>

      <Variant id="B2" title="Календарь: месяц" where="календарь → месяц">
        <MonthGrid days={twoWeeks} byDay={byDay} today={today} onOpen={() => undefined} height="h-[30rem]" />
      </Variant>

      <Variant id="B3" title="Календарь: неделя" where="календарь → неделя">
        <WeekView days={days} byDay={byDay} today={today} onOpen={() => undefined} />
      </Variant>

      <Variant id="B4" title="Календарь: лента" where="календарь → лента">
        <AgendaView days={days.slice(0, 2)} byDay={byDay} today={today} />
      </Variant>

      <Variant id="B5" title="Быстрый просмотр" where="календарь → панель дня (клик по выпуску)">
        <div className="max-w-xl rounded-lg bg-gray-900/60 p-4">
          {sampleItem ? <AnimeQuick media={sampleItem.media} airing={{ ...sampleItem.airing, kind: sampleItem.kind }} /> : watching && <AnimeQuick media={watching.media!} />}
        </div>
      </Variant>

      <Variant id="C1" title="Карточка рекомендации" where="«Для тебя»">
        {reco?.items?.length ? (
          <div className="grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-2">{reco.items.slice(0, 2).map((r) => <RecCard key={r.id} r={r} />)}</div>
        ) : <p className="text-sm text-gray-400">Рекомендации ещё считаются — загляните позже.</p>}
      </Variant>

      <Variant id="D1" title="Голый постер" where="быстрый просмотр, шапка тайтла (крупно)">
        <div className="flex gap-4">
          {[watching, completed].filter(Boolean).map((e) => <div key={e!.anilistId} className="w-28"><Poster media={e!.media!} /></div>)}
        </div>
      </Variant>

      <Variant id="F1" title="Всплывающая карточка" where="наведение на любую карточку (A1–A3, B1–B3, C1), только с мышью">
        <p className="text-sm text-gray-300">
          Наведите на любую карточку выше и подержите 0,4 с: полное название, альтернативные, жанры, синопсис,
          прогноз (и похожесть в «Похожем»), статус в списке, «Запросить», «Озвучки».
        </p>
      </Variant>

      <Variant id="E1" title="Другие места (не на этой странице)" where="—">
        <ul className="list-inside list-disc text-sm text-gray-300">
          <li>Панель выбранного узла на странице «Граф» — постер + жанры + кнопки.</li>
          <li>Строки предпросмотра синхронизации AniLib (Настройки) — мини-постер + изменения.</li>
          <li>Шапка страницы тайтла — большой постер, бейджи, кнопки действий (к ней — задача 3.1).</li>
        </ul>
      </Variant>
    </div>
  );
}
