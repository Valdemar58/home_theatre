import { StarIcon } from "@heroicons/react/20/solid";
import type { MediaLite } from "@/lib/types";
import { cx } from "./ui";

/**
 * «★ 9.3 MAL · 9.1 AniList». Если какой-то оценки нет, она не показывается.
 * compact — одна оценка (MAL, иначе AniList) для узких карточек.
 */
export function Scores({ media, size = "sm", compact, className }: {
  media: Pick<MediaLite, "malScore" | "averageScore">;
  size?: "xs" | "sm" | "md";
  compact?: boolean;
  className?: string;
}) {
  const mal = media.malScore;
  const anilist = media.averageScore && !(compact && mal) ? media.averageScore / 10 : null;
  if (!mal && !anilist) return null;
  const star = size === "md" ? "h-4 w-4" : size === "sm" ? "h-3.5 w-3.5" : "h-3 w-3";
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap", className)}>
      <StarIcon className={cx(star, "text-yellow-400")} />
      {mal && (
        <span title="Оценка MyAnimeList">
          <b className="font-semibold">{mal.toFixed(2).replace(/0$/, "")}</b> <span className="opacity-60">MAL</span>
        </span>
      )}
      {mal && anilist && <span className="opacity-40">·</span>}
      {anilist && (
        <span title="Оценка AniList">
          {mal ? anilist.toFixed(1) : <b className="font-semibold">{anilist.toFixed(1)}</b>} <span className="opacity-60">AniList</span>
        </span>
      )}
    </span>
  );
}
