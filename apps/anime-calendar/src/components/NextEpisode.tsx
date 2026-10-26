"use client";
import { ClockIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { formatAiring, relative } from "@/lib/time";
import type { MediaLite } from "@/lib/types";
import { cx } from "./ui";

/** Тикает раз в минуту, чтобы «через N» обновлялось. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Блок: «Следующая серия 3 из 12 · 16 октября 17:00 МСК» и «через 4 д 3 ч» справа;
 * строка (inline, для карточек календаря) — с днём недели.
 * Время в поясе устройства, полное название пояса — в подсказке.
 */
export function NextEpisode({ media, variant = "block" }: {
  media: Pick<MediaLite, "nextAiringEpisode" | "episodes">;
  variant?: "block" | "inline";
}) {
  const now = useNow();
  const next = media.nextAiringEpisode;
  if (!next || next.airingAt * 1000 < now) return null;
  const a = formatAiring(next.airingAt);
  const finale = media.episodes === next.episode;
  const title = `${a.full} (${a.tzName})`;

  if (variant === "inline") {
    return (
      <p className="text-sm text-gray-300" title={title}>
        <span className="text-gray-400">След.: </span>
        <b className={finale ? "text-purple-300" : "text-indigo-300"}>{next.episode}-я{finale ? " (финал)" : ""}</b>
        {" · "}
        <span className="capitalize">{a.weekday}</span>, {a.time} <span className="text-gray-500">{a.tz}</span>
        <span className="text-gray-400"> · {relative(next.airingAt, now)}</span>
      </p>
    );
  }

  return (
    <div className={cx("flex flex-wrap items-center gap-4 rounded-xl p-4 ring-1",
      finale ? "bg-purple-600/15 ring-purple-500/40" : "bg-indigo-600/10 ring-indigo-500/30")} title={title}>
      <ClockIcon className={cx("h-7 w-7", finale ? "text-purple-300" : "text-indigo-300")} />
      <p className="text-lg font-semibold">
        <span className="font-normal text-gray-400">{finale ? "Финальная серия" : "Следующая серия"}</span>{" "}
        {next.episode}{media.episodes ? ` из ${media.episodes}` : ""} · {a.date} {a.time}{" "}
        <span className="text-sm font-normal text-gray-400">{a.tz}</span>
      </p>
      <span className={cx("ml-auto text-xl font-bold", finale ? "text-purple-200" : "text-indigo-200")}>{relative(next.airingAt, now)}</span>
    </div>
  );
}
