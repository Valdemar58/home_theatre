"use client";
import Link from "next/link";
import { useRef } from "react";
import { useList, useListMutation, useUserList } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import { formatDate, relative } from "@/lib/time";
import type { ListEntryWithMedia, ListStatus } from "@/lib/types";
import { useUrlState } from "@/lib/useUrlState";
import { entryKey, ListControl } from "./ListControl";
import { ListsSwitch } from "./SharedListsView";
import { TitleCard } from "./TitleCard";
import { cx, EmptyState, ErrorBox, Skel } from "./ui";

const TABS: (ListStatus | "waiting")[] = ["watching", "waiting", "planned", "completed", "on_hold", "dropped", "rewatching"];

/** Ближайшее событие тайтла: следующая серия или финал. */
const nextAt = (e: ListEntryWithMedia) => e.media?.nextAiringEpisode?.airingAt ?? Number.MAX_SAFE_INTEGER;

/** Мои списки или (owner) чужие — только чтение, со своим статусом рядом. */
export function ListsView({ owner }: { owner?: { id: number; name: string } } = {}) {
  const mine = useList();
  const theirs = useUserList(owner?.id ?? 0, Boolean(owner));
  const { data, isLoading, error } = owner ? theirs : mine;
  const { params, setParams } = useUrlState();
  const tab = (params.get("tab") as (typeof TABS)[number]) || "watching";
  const { upsert } = useListMutation();
  // Состав вкладки на момент открытия: сменивший статус тайтл остаётся на месте (серым, с «Вернуть»)
  // и переезжает при смене вкладки или обновлении страницы
  const snapshot = useRef<{ tab: string; ids: Set<number> } | null>(null);

  if (error) return <ErrorBox error={error} />;

  const all = data ?? [];
  const counts = Object.fromEntries(TABS.map((t) => [t, all.filter((e) => entryKey(e) === t).length]));
  // Снимок берём только по загруженному списку, иначе вкладка «застынет» пустой
  if (!isLoading && snapshot.current?.tab !== tab) snapshot.current = { tab, ids: new Set(all.filter((e) => entryKey(e) === tab).map((e) => e.anilistId)) };
  const pinned = owner ? new Set<number>() : snapshot.current?.ids ?? new Set<number>();
  let items = all.filter((e) => entryKey(e) === tab || pinned.has(e.anilistId));
  const back = (e: ListEntryWithMedia) => e.media && upsert.mutate({
    media: e.media, patch: tab === "waiting" ? { status: "planned", waiting: true } : { status: tab as ListStatus, waiting: false },
  });
  // Для онгоингов сначала то, что выходит раньше
  if (tab === "watching" || tab === "waiting") items = [...items].sort((a, b) => nextAt(a) - nextAt(b));

  return (
    <div>
      {!owner && <ListsSwitch active="mine" />}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-700">
        {TABS.map((t) => (
          <button key={t} onClick={() => setParams({ tab: t === "watching" ? null : t })}
            className={cx("-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition",
              tab === t ? "border-indigo-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200")}>
            {LIST_LABELS[t]}{" "}
            {isLoading
              ? <span className="inline-flex align-middle"><Skel className="ml-1 h-5 w-7 rounded-full" /></span>
              : <span className="ml-1 rounded-full bg-gray-700 px-2 py-0.5 text-xs">{counts[t]}</span>}
          </button>
        ))}
      </div>

      {isLoading ? (
        // Постеры с местом под кнопку списка — сетка та же, что у настоящих карточек
        <div aria-busy className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i}>
              <Skel className="aspect-2/3 w-full rounded-xl" />
              <Skel className="mt-2 h-7 w-28 rounded-lg" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        owner ? <EmptyState title="Здесь пока пусто">{owner.name} ещё ничего сюда не добавил.</EmptyState> : <EmptyState title="Здесь пока пусто">
          Добавляй тайтлы из <Link href="/calendar" className="text-indigo-300 underline">календаря</Link> или{" "}
          <Link href="/browse" className="text-indigo-300 underline">каталога</Link>. Если привязан Shikimori, списки подтянутся оттуда.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7">
          {items.map((e) =>
            e.media ? (
              entryKey(e) === tab ? (
                <TitleCard key={e.anilistId} media={e.media}
                  footer={owner ? <TheirEntry e={e} mine={mine.byId.get(e.anilistId)} /> : <ListControl media={e.media} compact />} />
              ) : (
                <div key={e.anilistId} className="relative">
                  <div className="pointer-events-none opacity-35 grayscale"><TitleCard media={e.media} /></div>
                  <div className="absolute inset-x-2 top-1/3 flex flex-col items-center gap-2 rounded-lg bg-gray-900/90 p-3 text-center text-sm ring-1 ring-gray-600">
                    <span className="text-gray-300">Перемещено в «{LIST_LABELS[entryKey(e)]}»</span>
                    <button onClick={() => back(e)} className="rounded-md border border-gray-600 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700">
                      Вернуть
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div key={e.anilistId} className="text-sm text-gray-400">#{e.anilistId} (загружается)</div>
            ))}
        </div>
      )}

      {tab === "waiting" && items.some((e) => e.media?.nextAiringEpisode) && (
        <div className="mt-10 rounded-xl bg-gray-800/50 p-5 ring-1 ring-gray-700">
          <h2 className="mb-3 font-semibold">Ближайшие события</h2>
          <ul className="space-y-1.5 text-sm">
            {items.filter((e) => e.media?.nextAiringEpisode).map((e) => {
              const m = e.media!;
              const next = m.nextAiringEpisode!;
              return (
                <li key={e.anilistId} className="flex justify-between gap-4">
                  <Link href={`/anime/${m.id}`} className="truncate hover:text-indigo-300">{displayTitle(m.title)}</Link>
                  <span className="shrink-0 text-right text-gray-400">
                    эп. {next.episode}{m.episodes === next.episode ? " (финал)" : ""} {relative(next.airingAt)}
                    {m.finaleAt && m.episodes !== next.episode && (
                      <span className="block text-xs text-purple-300">финал: {formatDate(m.finaleAt, true)}, {relative(m.finaleAt)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Подпись под карточкой в чужом списке: его оценка/серии/«советую» и мой статус. */
function TheirEntry({ e, mine }: { e: ListEntryWithMedia; mine?: ListEntryWithMedia }) {
  const total = e.media?.episodes;
  return (
    <div className="space-y-0.5 text-xs">
      <p className="flex flex-wrap gap-x-2 text-gray-300">
        {e.score > 0 && <span className="text-amber-300">★ {e.score}</span>}
        {e.status !== "completed" && e.episodes > 0 && <span>{e.episodes}{total ? `/${total}` : ""} эп.</span>}
        {e.recommend === true && <span className="text-green-300">советует</span>}
        {e.recommend === false && <span className="text-red-300">не советует</span>}
      </p>
      <p className={mine ? "text-indigo-300" : "text-gray-500"}>{mine ? `у вас: ${LIST_LABELS[entryKey(mine)].toLowerCase()}` : "нет у вас"}</p>
    </div>
  );
}
