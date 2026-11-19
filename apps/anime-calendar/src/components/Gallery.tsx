"use client";
import { ArrowsPointingOutIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { imgSrc } from "@/lib/img";
import { IMAGE_KIND_LABELS } from "@/lib/labels";
import type { GalleryImage } from "@/lib/types";
import { ThumbStrip, usePortion, useSwipe } from "./ThumbStrip";
import { cx } from "./ui";

/**
 * Галерея на странице тайтла: большой кадр со стрелками и лента миниатюр под ним.
 * Индекс общий с полноэкранным просмотром (onOpen), лента догружается порциями.
 */
export function Gallery({ images, index, onIndex, onOpen, portrait }: {
  images: GalleryImage[];
  index: number;
  onIndex: (n: number) => void;
  onOpen: () => void;
  /** Вертикальный кадр (облики персонажа) */
  portrait?: boolean;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const { shown, more } = usePortion(images.length, index);
  const go = (d: number) => onIndex((index + d + images.length) % images.length);
  const swipe = useSwipe(go);
  const img = images[index];

  return (
    <div>
      <div
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
          if (e.key === "Enter") onOpen();
        }}
        {...swipe}
        className={cx("group relative max-h-[70vh] w-full overflow-hidden rounded-xl bg-black ring-1 ring-gray-700 outline-none focus-visible:ring-indigo-400", portrait ? "aspect-4/5" : "aspect-video")}
      >
        {/* Пока грузится оригинал — размытая миниатюра */}
        {loaded !== img.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc(img.thumb, "thumb")} alt="" className="absolute inset-0 h-full w-full scale-105 object-contain opacity-60 blur-sm" />
        )}
        <button onClick={onOpen} className="absolute inset-0 cursor-zoom-in" title="На весь экран">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={img.url} src={imgSrc(img.url, "full")} alt="" onLoad={() => setLoaded(img.url)}
            className={cx("h-full w-full object-contain transition-opacity", loaded === img.url ? "opacity-100" : "opacity-0")} />
        </button>

        {images.length > 1 && (
          <>
            <button onClick={() => go(-1)} aria-label="Назад"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white opacity-70 transition hover:bg-black/80 group-hover:opacity-100">
              <ChevronLeftIcon className="h-6 w-6" />
            </button>
            <button onClick={() => go(1)} aria-label="Вперёд"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white opacity-70 transition hover:bg-black/80 group-hover:opacity-100">
              <ChevronRightIcon className="h-6 w-6" />
            </button>
          </>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-linear-to-t from-black/70 to-transparent px-3 pb-2 pt-8 text-xs text-gray-200">
          <span>{index + 1} / {images.length} · {img.caption ?? `${IMAGE_KIND_LABELS[img.kind]} · ${img.source}`}</span>
          <ArrowsPointingOutIcon className="h-4 w-4 opacity-0 transition group-hover:opacity-100" />
        </div>
      </div>

      {images.length > 1 && (
        <ThumbStrip images={images} active={index} onSelect={onIndex} shown={shown} onMore={more} />
      )}
    </div>
  );
}
