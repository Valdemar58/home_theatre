"use client";
import { UserGroupIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useState } from "react";
import { usePlot, useTitleCast } from "@/lib/client";
import { stateAt } from "@/lib/plot-deep";
import type { AnimeDetails } from "@/lib/types";
import { CharacterStrip, EpisodePicker } from "./Characters";
import { Img } from "./Img";
import { NamedText, paragraphEps, useNames } from "./NamedText";
import { Badge, cx } from "./ui";

// Блок «Сюжет» на странице тайтла: выбор серии, начало пересказа сезона на эту серию и входы — персонажи,
// карта персонажей, события. Без разбора серий — лента персонажей AniList, как раньше.

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
};

/** Мини-превью: узлы со связями (карта персонажей) и дорожки (события) — узнаваемая иконка вместо пустой плитки. */
function GraphPreview() {
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-full" aria-hidden>
      <g className="stroke-accent-400/60" strokeWidth="1.5" fill="none">
        <path d="M60 32 L24 16 M60 32 L28 50 M60 32 L96 14 M60 32 L98 48 M96 14 L98 48" />
      </g>
      <circle cx="60" cy="32" r="8" className="fill-accent-400" />
      {[[24, 16], [28, 50], [96, 14], [98, 48]].map(([x, y]) => <circle key={`${x}`} cx={x} cy={y} r="5" className="fill-gray-500" />)}
    </svg>
  );
}

function LanesPreview() {
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-full" aria-hidden>
      <g strokeLinecap="round" strokeWidth="6">
        <path d="M8 14 H52" className="stroke-negative-400/80" /><path d="M60 14 H100" className="stroke-negative-400/40" />
        <path d="M20 32 H70" className="stroke-positive-400/80" /><path d="M76 32 H112" className="stroke-positive-400/40" />
        <path d="M8 50 H38" className="stroke-special-400/80" /><path d="M46 50 H90" className="stroke-special-400/40" />
      </g>
      <path d="M72 6 V58" className="stroke-special-300" strokeWidth="1.5" />
    </svg>
  );
}

function Tile({ href, title, count, text, preview, soon }: { href?: string; title: string; count: string; text: string; preview: React.ReactNode; soon?: boolean }) {
  const body = (
    <>
      <div className="flex h-16 items-center">{preview}</div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-gray-400">{count}</span>
        {soon && <Badge tone="neutral">скоро</Badge>}
      </div>
      <p className="text-sm leading-snug text-gray-400">{text}</p>
    </>
  );
  const cls = "flex flex-col gap-2 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700";
  return href && !soon ? <Link href={href} className={cx(cls, "transition hover:ring-gray-500")}>{body}</Link> : <div className={cx(cls, "opacity-70")}>{body}</div>;
}

export function PlotHub({ media }: { media: AnimeDetails }) {
  const { data: cast } = useTitleCast(media.id);
  const { data: plot } = usePlot(media.id);
  const [full, setFull] = useState(false);
  const state = plot?.season && cast ? stateAt(plot.season.states, cast.cursor.ep).state : null;
  const names = useNames(state ? media.id : 0, state?.upTo ?? null);
  if (!cast) return null;
  if (!cast.built) return <CharacterStrip media={media} />;
  const faces = cast.members.slice(0, 3);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="mr-auto text-xl font-bold">Сюжет</h2>
        <EpisodePicker anilistId={media.id} cursor={cast.cursor} />
      </div>
      {state && (
        <div className="rounded-xl bg-gray-800/40 px-4 py-3 ring-1 ring-gray-700">
          <p className="mb-1 text-[11px] uppercase tracking-wider text-gray-500">Пересказ сезона · серии 1–{state.upTo}</p>
          <p className={cx("whitespace-pre-line text-sm leading-relaxed text-gray-300", !full && "line-clamp-3")}>
            <NamedText text={state.retelling_ru} anilistId={media.id} upTo={state.upTo} names={names} byParagraph={paragraphEps(state.arcs, state.retelling_ru)} />
          </p>
          <button onClick={() => setFull(!full)} className="mt-1 text-sm text-accent-300 hover:text-accent-200">{full ? "Свернуть" : "Читать дальше"}</button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile href={`/anime/${media.id}/characters`} title="Персонажи" count={String(cast.members.length)}
          text="Кто есть кто на вашу серию: облики, группы, связи, в каких тайтлах ещё появляются."
          preview={
            <div className="flex items-center">
              <div className="flex -space-x-3">
                {faces.map((m) => (
                  <span key={m.href} className="relative inline-block h-14 w-10 overflow-hidden rounded-lg bg-gray-700 ring-2 ring-gray-900">
                    {m.image ? <Img src={m.image} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-5 w-5 text-gray-500" />}
                  </span>
                ))}
              </div>
              {cast.members.length > faces.length && <span className="ml-2 text-sm text-gray-400">+{cast.members.length - faces.length}</span>}
              <UserGroupIcon className="ml-auto h-5 w-5 text-gray-600" />
            </div>
          } />
        <Tile href={`/anime/${media.id}/relations`} title="Карта персонажей" count={plural(cast.stats.relations, "связь", "связи", "связей")}
          text="Кто кому союзник, слуга, враг — и как это менялось от серии к серии." preview={<GraphPreview />} />
        <Tile href={`/anime/${media.id}/events`} title="Карта событий" count={`${plural(cast.stats.arcs, "арка", "арки", "арок")} · ${plural(cast.stats.events, "событие", "события", "событий")}`}
          text="Арки и события по сериям: что из чего вытекло, причины и последствия." preview={<LanesPreview />} />
      </div>
      {cast.hidden > 0 && <p className="text-sm text-gray-500">Ещё {plural(cast.hidden, "персонаж появится", "персонажа появятся", "персонажей появятся")} после {cast.cursor.ep} серии.</p>}
    </section>
  );
}
