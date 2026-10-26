"use client";
import { PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useEffect, useState } from "react";
import { imgSrc } from "@/lib/img";
import type { AnimeVideo } from "@/lib/types";
import { cx } from "./ui";

const KINDS: { kind: AnimeVideo["kind"]; label: string }[] = [
  { kind: "op", label: "Опенинги" },
  { kind: "ed", label: "Эндинги" },
  { kind: "pv", label: "Трейлеры" },
  { kind: "op_ed_clip", label: "Клипы" },
  { kind: "character_trailer", label: "Персонажи" },
  { kind: "episode_preview", label: "Превью серий" },
  { kind: "other", label: "Другое" },
];

// «OP2» после «OP1», «10» после «9»
const byName = (a: AnimeVideo, b: AnimeVideo) => (a.name ?? "").localeCompare(b.name ?? "", "ru", { numeric: true });

/** Опенинги, эндинги и трейлеры: вкладки по видам, плеер — во всплывающем окне. */
export function Videos({ videos }: { videos: AnimeVideo[] }) {
  const tabs = KINDS.map((k) => ({ ...k, items: videos.filter((v) => v.kind === k.kind).sort(byName) })).filter((t) => t.items.length);
  const [tab, setTab] = useState(tabs[0]?.kind);
  const [playing, setPlaying] = useState<AnimeVideo | null>(null);
  if (!tabs.length) return null;
  const current = tabs.find((t) => t.kind === tab) ?? tabs[0];

  return (
    <section>
      <h2 className="mb-3 text-xl font-bold">Видео</h2>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button key={t.kind} onClick={() => setTab(t.kind)}
            className={cx("rounded-full px-3 py-1 text-sm transition",
              t.kind === current.kind ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700")}>
            {t.label} <span className="opacity-60">{t.items.length}</span>
          </button>
        ))}
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {current.items.map((v) => (
          <button key={v.player} onClick={() => setPlaying(v)} className="group w-56 shrink-0 text-left">
            <div className="relative aspect-video overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700 transition group-hover:ring-indigo-400">
              {v.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imgSrc(v.image, "card")} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition group-hover:bg-black/40">
                <PlayIcon className="h-10 w-10 text-white/90 drop-shadow" />
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm text-gray-300">{v.name || current.label}</p>
          </button>
        ))}
      </div>
      {playing && <Player video={playing} onClose={() => setPlaying(null)} />}
    </section>
  );
}

function Player({ video, onClose }: { video: AnimeVideo; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  // youtube.com/embed → www.youtube.com/embed: иначе редирект меняет адрес, и разрешение
  // allow="fullscreen" (по умолчанию — только для исходного адреса) перестаёт действовать
  const player = video.player.replace(/^https:\/\/youtube\.com\//, "https://www.youtube.com/");
  const src = `${player}${player.includes("?") ? "&" : "?"}autoplay=1`;

  return (
    <div className="fixed inset-0 z-60 flex flex-col items-center justify-center bg-black/90 p-4" onClick={onClose}>
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-4 text-sm text-gray-300">
          <span className="truncate">{video.name}</span>
          <div className="flex shrink-0 items-center gap-3">
            <a href={video.url} target="_blank" rel="noreferrer" className="hover:text-white">Открыть на сайте</a>
            <button onClick={onClose} className="rounded p-1.5 hover:bg-white/10" aria-label="Закрыть">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
        </div>
        <iframe src={src} title={video.name ?? "Видео"} allow="autoplay *; encrypted-media *; picture-in-picture *; fullscreen *" allowFullScreen
          className="aspect-video w-full rounded-lg bg-black" />
      </div>
    </div>
  );
}
