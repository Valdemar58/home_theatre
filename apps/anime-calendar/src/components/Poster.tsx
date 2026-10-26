"use client";
import type { MediaLite } from "@/lib/types";
import { cx } from "./ui";
import { useHoverCard } from "./HoverCard";
import { Img } from "./Img";

export function Poster({ media, className }: { media: Pick<MediaLite, "coverImage" | "title"> & { id?: number }; className?: string }) {
  // Полный тайтл — карточка сразу, иначе — по id (детали догрузятся)
  const hover = useHoverCard("format" in media ? (media as MediaLite) : (media.id ?? 0));
  return (
    <div {...(media.id ? hover : {})}
      className={cx("relative aspect-[2/3] overflow-hidden rounded-lg bg-gray-700 ring-1 ring-gray-700", className)}
      style={{ backgroundColor: media.coverImage.color ?? undefined }}
    >
      {media.coverImage.large && (
        <Img src={media.coverImage.large} size="card" className="absolute inset-0 h-full w-full object-cover" />
      )}
    </div>
  );
}
