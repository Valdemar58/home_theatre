"use client";
import Link from "next/link";
import { PlayIcon } from "@heroicons/react/24/outline";
import { titleWatchTarget } from "@/lib/title-watch";
import { STATUS_LABELS, label } from "@/lib/labels";
import type { AnimeDetails } from "@/lib/types";

export function TitleWatchStatus({ media, watched, now }: { media: AnimeDetails; watched: number; now: number }) {
  const { aired, complete, target } = titleWatchTarget(media, watched, Math.floor(now / 1000));
  const available = target !== null;
  return <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 py-2">
    <div className="min-w-0">
      <p className="font-medium text-gray-100">{watched > 0 ? complete ? "Просмотрено" : available ? `Продолжить с ${target} серии` : "Вы посмотрели все вышедшие серии" : label(STATUS_LABELS, media.status)}</p>
      <p className="mt-1 text-sm text-gray-400">{aired !== null ? `Вышло ${aired}${media.episodes ? ` из ${media.episodes}` : ""} серий` : "Количество вышедших серий уточняется"}{!available && watched > 0 && media.status !== "FINISHED" ? " · Ждём продолжения" : ""}</p>
    </div>
    {available ? <Link href={`/anime/${media.id}/watch/${target}`} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-300"><PlayIcon className="h-4 w-4" />{complete ? "Пересмотреть" : "Смотреть"}</Link>
      : <button disabled className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-gray-800 px-5 py-2 text-sm text-gray-400"><PlayIcon className="h-4 w-4" />Смотреть</button>}
  </div>;
}
