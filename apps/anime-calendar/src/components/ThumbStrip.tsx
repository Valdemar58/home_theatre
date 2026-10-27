"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { imgSrc } from "@/lib/img";
import type { GalleryImage } from "@/lib/types";
import { cx } from "./ui";

/** Сколько миниатюр показывать за раз: следующая порция — при подходе к концу ленты. */
export const PORTION = 10;

/**
 * Сколько картинок уже «открыто» в ленте: порция растёт, когда хвост ленты виден
 * или выбранная картинка подошла к концу загруженного.
 */
export function usePortion(total: number, active: number) {
  const [count, setCount] = useState(PORTION);
  // выбранная картинка у края загруженного — следующая порция открывается заранее
  const need = Math.ceil((active + 3) / PORTION) * PORTION;
  const shown = Math.min(total, Math.max(count, need));
  const more = useCallback(() => setCount(Math.min(total, shown + PORTION)), [total, shown]);
  return { shown, more };
}

/** Свайп влево/вправо — только на том элементе, куда повешены обработчики (не на ленте). */
export function useSwipe(go: (d: number) => void) {
  const start = useRef<number | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => { start.current = e.touches[0].clientX; },
    onTouchEnd: (e: React.TouchEvent) => {
      if (start.current === null) return;
      const dx = e.changedTouches[0].clientX - start.current;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      start.current = null;
    },
  };
}

/**
 * Горизонтальная лента миниатюр: фиксированные размеры (лента не «прыгает» при загрузке),
 * активная держится по центру, колесо мыши листает по горизонтали, хвост догружается порциями.
 */
export function ThumbStrip({ images, active, onSelect, shown, onMore, tone = "page" }: {
  images: GalleryImage[];
  active: number;
  onSelect: (n: number) => void;
  shown: number;
  onMore: () => void;
  tone?: "page" | "dark";
}) {
  const strip = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);

  // Активная миниатюра — по центру ленты (без scrollIntoView: он прокручивает и страницу)
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-n="${active}"]`);
    const box = strip.current;
    if (!el || !box) return;
    box.scrollTo({ left: el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2, behavior: "smooth" });
  }, [active, shown]);

  // Колесо → горизонтальная прокрутка (React вешает onWheel пассивным, preventDefault не сработает)
  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || box.scrollWidth <= box.clientWidth) return;
      const atStart = box.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = box.scrollLeft + box.clientWidth >= box.scrollWidth - 1 && e.deltaY > 0;
      if (atStart || atEnd) return; // на краях отдаём прокрутку странице
      e.preventDefault();
      box.scrollLeft += e.deltaY;
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  // Хвост ленты стал виден — следующая порция
  useEffect(() => {
    const el = tail.current;
    if (!el || shown >= images.length) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onMore(), {
      root: strip.current,
      rootMargin: "0px 200px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, images.length, onMore]);

  return (
    <div ref={strip} className="overflow-x-auto overscroll-x-contain py-2 [scrollbar-width:thin]">
      {/* w-max + mx-auto: короткая лента по центру, длинная прокручивается с самого начала */}
      <div className="mx-auto flex w-max gap-2 px-1">
        {images.slice(0, shown).map((im, n) => (
          <button key={`${n}:${im.url}`} data-n={n} onClick={() => onSelect(n)} title={im.caption ?? `${n + 1} / ${images.length}`}
            className={cx(
              "h-16 shrink-0 overflow-hidden rounded-md ring-2 transition",
              im.kind === "poster" || im.kind === "portrait" ? "aspect-2/3" : "aspect-video",
              tone === "dark" ? "bg-white/5" : "bg-gray-800",
              n === active ? "ring-indigo-400" : "opacity-60 ring-transparent hover:opacity-100",
            )}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgSrc(im.thumb, "thumb")} alt="" loading="lazy" className="h-full w-full object-cover" />
          </button>
        ))}
        {shown < images.length && (
          <div ref={tail}
            className={cx("flex h-16 shrink-0 items-center rounded-md px-3 text-xs",
              tone === "dark" ? "bg-white/5 text-gray-400" : "bg-gray-800 text-gray-400")}>
            ещё {images.length - shown}
          </div>
        )}
      </div>
    </div>
  );
}
