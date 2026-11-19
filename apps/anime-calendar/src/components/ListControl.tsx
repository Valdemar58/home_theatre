"use client";
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useList, useListMutation } from "@/lib/client";
import { episodeProgress } from "@/lib/entry-rules";
import { LIST_LABELS } from "@/lib/labels";
import { LIST_STATUSES, type ListEntry, type ListStatus, type MediaLite } from "@/lib/types";
import { CONTROL_BASE, CONTROL_NEUTRAL, CONTROL_SIZES, cx } from "./ui";

export const STATUS_COLORS: Record<ListStatus | "waiting", string> = {
  watching: "bg-green-600 border-green-500",
  planned: "bg-indigo-600 border-indigo-500",
  waiting: "bg-purple-600 border-purple-500",
  completed: "bg-sky-600 border-sky-500",
  on_hold: "bg-yellow-600 border-yellow-500",
  dropped: "bg-red-700 border-red-600",
  rewatching: "bg-teal-600 border-teal-500",
};

/** Кнопка статуса: нейтральная с оттенком цвета статуса (в одной системе с остальными кнопками). */
const STATUS_TINT: Record<ListStatus | "waiting", string> = {
  watching: "bg-green-500/15 ring-green-500/50 text-green-100 hover:bg-green-500/25",
  planned: "bg-indigo-500/15 ring-indigo-500/50 text-indigo-100 hover:bg-indigo-500/25",
  waiting: "bg-purple-500/15 ring-purple-500/50 text-purple-100 hover:bg-purple-500/25",
  completed: "bg-sky-500/15 ring-sky-500/50 text-sky-100 hover:bg-sky-500/25",
  on_hold: "bg-yellow-500/15 ring-yellow-500/50 text-yellow-100 hover:bg-yellow-500/25",
  dropped: "bg-red-500/15 ring-red-500/50 text-red-100 hover:bg-red-500/25",
  rewatching: "bg-teal-500/15 ring-teal-500/50 text-teal-100 hover:bg-teal-500/25",
};

export const entryKey = (e: Pick<ListEntry, "status" | "waiting">) => (e.waiting ? "waiting" : e.status);

type Option = { key: ListStatus | "waiting"; patch: { status: ListStatus; waiting: boolean } };
const OPTIONS: Option[] = [
  { key: "watching", patch: { status: "watching", waiting: false } },
  { key: "planned", patch: { status: "planned", waiting: false } },
  { key: "waiting", patch: { status: "planned", waiting: true } },
  ...LIST_STATUSES.filter((s) => !["watching", "planned"].includes(s)).map(
    (s): Option => ({ key: s, patch: { status: s, waiting: false } })),
];

export function ListControl({ media, compact }: { media: MediaLite; compact?: boolean }) {
  const { byId } = useList();
  const { upsert, remove } = useListMutation();
  const entry = byId.get(media.id);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const current = entry ? entryKey(entry) : null;
  // Статус по отметке серии (Смотрю / Пересматриваю / Просмотрено) решает сервер — lib/entry-rules.ts
  const setEpisodes = (n: number) => upsert.mutate({ media, patch: { episodes: n } });
  const { fresh, remaining } = entry ? episodeProgress(entry, media) : { fresh: 0, remaining: 0 };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className={cx(CONTROL_BASE, CONTROL_SIZES[compact ? "sm" : "md"], current ? STATUS_TINT[current] : CONTROL_NEUTRAL)}
        >
          {current ? <span className={cx("h-2 w-2 rounded-full border", STATUS_COLORS[current])} /> : <PlusIcon className="h-4 w-4" />}
          {current ? LIST_LABELS[current] : "В список"}
          <ChevronDownIcon className="h-4 w-4 opacity-70" />
        </button>
        {open && (
          <div className="mobile-popover absolute left-0 z-40 mt-1 w-52 overflow-hidden rounded-lg bg-gray-800 py-1 shadow-xl ring-1 ring-gray-600">
            {OPTIONS.map((o) => (
              <button
                key={o.key}
                onClick={() => {
                  upsert.mutate({ media, patch: o.patch });
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700"
              >
                <span className="flex items-center gap-2">
                  <span className={cx("h-2.5 w-2.5 rounded-full border", STATUS_COLORS[o.key])} />
                  {LIST_LABELS[o.key]}
                </span>
                {current === o.key && <CheckIcon className="h-4 w-4 text-indigo-400" />}
              </button>
            ))}
            {entry && (
              <button
                onClick={() => {
                  remove.mutate(media.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 border-t border-gray-700 px-3 py-2 text-left text-sm text-red-300 hover:bg-gray-700"
              >
                <TrashIcon className="h-4 w-4" /> Убрать из списков
              </button>
            )}
          </div>
        )}
      </div>

      {entry && ["watching", "rewatching", "on_hold"].includes(entry.status) && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5">
        <div className={cx(CONTROL_BASE, CONTROL_SIZES[compact ? "sm" : "md"], "gap-0 overflow-hidden bg-gray-800/80 px-0 text-gray-100 ring-gray-600")}>
          <button className="flex h-full items-center px-2 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-40" disabled={entry.episodes <= 0}
            onClick={() => setEpisodes(entry.episodes - 1)} aria-label="Минус серия">
            <MinusIcon className="h-4 w-4" />
          </button>
          <span className={cx("whitespace-nowrap text-center tabular-nums", compact ? "min-w-10" : "min-w-14")} title="Просмотрено серий">
            {entry.episodes}/{media.episodes ?? "?"}
          </span>
          <button className="flex h-full items-center px-2 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-40"
            disabled={Boolean(media.episodes && entry.episodes >= media.episodes)}
            onClick={() => setEpisodes(entry.episodes + 1)} aria-label="Плюс серия">
            <PlusIcon className="h-4 w-4" />
          </button>
        </div>
          {fresh > 0 ? (
            <span className="mr-1.5 whitespace-nowrap rounded-md bg-indigo-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-200"
              title={`Вышло ${fresh} с вашей последней отметки (всего не просмотрено: ${remaining})`}>
              +{fresh}{compact ? "" : " новых"}
            </span>
          ) : remaining > 0 && (
            <span className="mr-2 whitespace-nowrap text-[11px] text-gray-400" title="Вышедших, но ещё не просмотренных">
              {compact ? `−${remaining}` : `осталось ${remaining}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
