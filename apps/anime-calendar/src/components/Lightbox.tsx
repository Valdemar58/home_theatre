"use client";
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { imgSrc } from "@/lib/img";
import { IMAGE_KIND_LABELS } from "@/lib/labels";
import type { GalleryImage } from "@/lib/types";
import { ThumbStrip, usePortion, useSwipe } from "./ThumbStrip";
import { cx } from "./ui";
import { useUpscale } from "@/lib/upscale-client";
import { UpscaleBadge } from "./Img";

/** Полноэкранный просмотр картинок: стрелки, Esc, свайп по кадру, лента миниатюр. Индекс — у родителя. */
export function Lightbox({ images, index, onIndex, onClose }: {
  images: GalleryImage[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const { shown, more } = usePortion(images.length, index);
  const go = useCallback((d: number) => onIndex((index + d + images.length) % images.length), [index, images.length, onIndex]);
  const swipe = useSwipe(go);

  useEffect(() => {
    // Перехват на погружении: клавиши не доходят до галереи под оверлеем (иначе двойной шаг)
    const onKey = (e: KeyboardEvent) => {
      if (!["Escape", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);

  const img = images[index];
  const up = useUpscale(img.url, "full");
  return (
    <div className="fixed inset-0 z-60 flex flex-col bg-black/95" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-300" onClick={(e) => e.stopPropagation()}>
        <span>
          {index + 1} / {images.length} · {IMAGE_KIND_LABELS[img.kind]} · {img.source}
        </span>
        <div className="flex items-center gap-3">
          <UpscaleBadge src={img.url} />
          <a href={img.url} target="_blank" rel="noreferrer" className="hover:text-white">Источник</a>
          <button onClick={onClose} className="rounded p-1.5 hover:bg-white/10" aria-label="Закрыть">
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 sm:px-16" {...swipe}>
        {loaded !== img.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc(img.thumb, "thumb")} alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain px-2 opacity-90 blur-sm sm:px-16" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={img.url}
          src={imgSrc(img.url, "full", up.upscaled)}
          alt=""
          onLoad={() => setLoaded(img.url)}
          onClick={(e) => e.stopPropagation()}
          className={cx("relative max-h-full max-w-full object-contain shadow-2xl transition-opacity", loaded === img.url ? "opacity-100" : "opacity-0")}
        />
        {images.length > 1 && (
          <>
            <button onClick={(e) => { e.stopPropagation(); go(-1); }}
              className="absolute left-2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 sm:left-4" aria-label="Назад">
              <ChevronLeftIcon className="h-7 w-7" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); go(1); }}
              className="absolute right-2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 sm:right-4" aria-label="Вперёд">
              <ChevronRightIcon className="h-7 w-7" />
            </button>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div className="px-4" onClick={(e) => e.stopPropagation()}>
          <ThumbStrip images={images} active={index} onSelect={onIndex} shown={shown} onMore={more} tone="dark" />
        </div>
      )}
    </div>
  );
}
