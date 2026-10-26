"use client";
import { SparklesIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import { imgSrc, isCacheable, type ImgSize } from "@/lib/img";
import { useUpscale } from "@/lib/upscale-client";
import { cx } from "./ui";

/**
 * Картинка в два этапа: сразу — крошечная размытая копия (32px, сотни байт),
 * поверх неё плавно проявляется нормальная, когда догрузится.
 * ИИ-апскейл (card/full): когда улучшенная версия готова, она подгружается заранее и подменяет
 * картинку без мигания. Родитель задаёт размер и overflow-hidden; className — для обеих
 * (обычно absolute inset-0 object-cover).
 */
export function Img({ src, size, className, alt = "", lazy = true, upscale = size === "card" || size === "full" }: {
  src: string;
  size: ImgSize;
  className?: string;
  alt?: string;
  lazy?: boolean;
  /** Просить ИИ-апскейл (по умолчанию — для card/full) */
  upscale?: boolean;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const { upscaled } = useUpscale(src, size === "full" ? "full" : "card", upscale && (size === "card" || size === "full"));
  const wanted = imgSrc(src, size, upscaled);
  // Показанный адрес меняем только когда новая версия уже загружена — без вспышки размытой копии
  const [shown, setShown] = useState(wanted);
  useEffect(() => {
    if (wanted === shown) return;
    if (!loaded) { setShown(wanted); return; }
    const pre = new Image();
    pre.onload = () => setShown(wanted);
    pre.src = wanted;
    return () => { pre.onload = null; };
  }, [wanted, shown, loaded]);
  // Картинка из кэша браузера может загрузиться до гидратации — onLoad тогда не придёт
  useEffect(() => {
    setLoaded(Boolean(ref.current?.complete && ref.current.naturalWidth));
  }, [src, size]);
  const blur = isCacheable(src) && size !== "tiny";
  return (
    <>
      {blur && !loaded && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imgSrc(src, "tiny")} alt="" aria-hidden className={cx(className, "scale-110 blur-lg")} />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={ref} src={shown} alt={alt} loading={lazy ? "lazy" : undefined} onLoad={() => setLoaded(true)}
        className={cx(className, blur && "transition-opacity duration-500", blur && !loaded && "opacity-0")} />
    </>
  );
}

/** Пометка «ИИ» на улучшенной картинке и переключатель «оригинал / улучшенная». */
export function UpscaleBadge({ src, className }: { src: string | null | undefined; className?: string }) {
  const { state, original, toggle } = useUpscale(src, "full");
  if (state !== "done") return null;
  return (
    <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggle(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); } }}
      title={original ? "Показан оригинал — вернуть улучшенную ИИ" : "Картинка улучшена ИИ-апскейлом (Real-ESRGAN). Нажмите, чтобы показать оригинал"}
      className={cx("inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/85", className)}>
      <SparklesIcon className={cx("h-3.5 w-3.5", original ? "text-gray-400" : "text-amber-300")} />
      {original ? "Оригинал · вернуть ИИ" : "ИИ · показать оригинал"}
    </span>
  );
}
