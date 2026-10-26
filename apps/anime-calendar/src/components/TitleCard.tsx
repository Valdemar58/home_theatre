"use client";
import Link from "next/link";
import { FORMAT_LABELS, LIST_LABELS, label } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import { formatAiring, relative } from "@/lib/time";
import type { ListEntry, MediaLite } from "@/lib/types";
import { entryKey, STATUS_COLORS } from "./ListControl";
import { Scores } from "./Scores";
import { cx } from "./ui";
import { type HoverExtra, useHoverCard } from "./HoverCard";
import { Img } from "./Img";

/** Карточка-постер как в Seerr: бейджи сверху, название при наведении. */
export type CardCorner = { kind: "match" | "similarity"; value: number };

export function TitleCard({ media, entry, footer, match, corner, hoverExtra }: {
  media: MediaLite;
  entry?: ListEntry;
  footer?: React.ReactNode;
  /** Прогноз «насколько понравится» — плашкой в углу (для тайтлов не из списка) */
  match?: number | null;
  /** Плашка в углу: прогноз или похожесть (вместо match) */
  corner?: CardCorner | null;
  /** Доп. секции всплывающей карточки (например, похожесть в «Похожем») */
  hoverExtra?: HoverExtra;
}) {
  const hover = useHoverCard(media, hoverExtra);
  const next = media.nextAiringEpisode;
  const badge = corner !== undefined ? corner : match != null ? { kind: "match" as const, value: match } : null;
  return (
    <div className="group">
      <Link {...hover}
        href={`/anime/${media.id}`}
        className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-gray-800 shadow-lg ring-1 ring-gray-700 transition duration-300 hover:scale-[1.03] hover:ring-gray-500"
        style={{ backgroundColor: media.coverImage.color ?? undefined }}
      >
        {media.coverImage.large && <Img src={media.coverImage.large} size="card" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-2">
          <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-900/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-200 ring-1 ring-gray-600">
            {label(FORMAT_LABELS, media.format)}
          </span>
          {entry ? (
            <span className={cx("min-w-0 truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold text-white", STATUS_COLORS[entryKey(entry)])}>
              {LIST_LABELS[entryKey(entry)]}
            </span>
          ) : badge && <CornerBadge {...badge} />}
        </div>
        <div className="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-gray-950 via-gray-950/40 to-transparent p-3 opacity-90 transition group-hover:opacity-100">
          <p className="line-clamp-2 text-sm font-semibold leading-tight text-white">{displayTitle(media.title)}</p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-300">
            {media.seasonYear && <span>{media.seasonYear}</span>}
            <Scores media={media} size="xs" compact />
          </div>
          {media.finaleAt && media.finaleAt * 1000 > Date.now() && media.nextAiringEpisode?.episode !== media.episodes && (
            <p className="mt-1 text-[11px] font-medium text-purple-300">Финал {relative(media.finaleAt)}</p>
          )}
          {next && (
            <p className="mt-1 text-[11px] font-medium text-indigo-300" title={formatAiring(next.airingAt).full}>
              Эп. {next.episode}{media.episodes === next.episode ? " (финал)" : ""} ·{" "}
              <span className="capitalize">{formatAiring(next.airingAt).weekday.slice(0, 2)}</span> {formatAiring(next.airingAt).time}
              <span className="text-gray-400"> · {relative(next.airingAt)}</span>
            </p>
          )}
        </div>
      </Link>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

function CornerBadge({ kind, value }: CardCorner) {
  if (kind === "similarity") {
    return (
      <span title="Насколько похоже на этот тайтл" className="rounded-full bg-gray-900/80 px-2 py-0.5 text-[10px] font-bold tabular-nums text-sky-200 ring-1 ring-sky-400/50 backdrop-blur">
        ≈ {value}%
      </span>
    );
  }
  return (
    <span title="Прогноз: насколько вам понравится" className={cx("rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ring-1 backdrop-blur",
      value >= 85 ? "bg-green-600/80 text-white ring-green-400/60" : value >= 65 ? "bg-indigo-600/80 text-white ring-indigo-400/60" : "bg-gray-900/80 text-gray-200 ring-gray-600")}>
      {value}%
    </span>
  );
}
