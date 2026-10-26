"use client";
import Link from "next/link";
import { FORMAT_LABELS, GENRE_LABELS, label } from "@/lib/labels";
import { displayTitle, secondaryTitle, type AiringKind } from "@/lib/schedule";
import { formatAiring, pluralEpisodes, relative } from "@/lib/time";
import type { MediaLite } from "@/lib/types";
import { ListControl } from "./ListControl";
import { NextEpisode } from "./NextEpisode";
import { Poster } from "./Poster";
import { RequestButton } from "./RequestButton";
import { Scores } from "./Scores";
import { VoicesButton } from "./VoicesButton";
import { Badge } from "./ui";

export function KindBadge({ kind, episode, total }: { kind: AiringKind; episode: number; total: number | null }) {
  if (kind === "finale") return <Badge tone="special">Финал · {episode}/{total}</Badge>;
  if (kind === "premiere") return <Badge tone="positive">Премьера</Badge>;
  return <Badge tone="neutral">Эп. {episode}{total ? `/${total}` : ""}</Badge>;
}

/** Краткая карточка тайтла (поповер календаря, модалки). */
export function AnimeQuick({ media, airing }: {
  media: MediaLite;
  airing?: { episode: number; airingAt: number; kind: AiringKind };
}) {
  const alt = secondaryTitle(media.title);
  return (
    <div className="flex gap-4">
      <Link href={`/anime/${media.id}`} className="w-24 shrink-0 sm:w-28">
        <Poster media={media} className="transition hover:ring-indigo-500" />
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <Link href={`/anime/${media.id}`} className="line-clamp-2 text-base font-semibold leading-snug hover:text-indigo-300">
            {displayTitle(media.title)}
          </Link>
          {alt && <p className="truncate text-xs text-gray-400">{alt}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-300">
          {airing && <KindBadge kind={airing.kind} episode={airing.episode} total={media.episodes} />}
          <span>{label(FORMAT_LABELS, media.format)}</span>
          {media.episodes && <span>· {pluralEpisodes(media.episodes)}</span>}
          <Scores media={media} size="xs" />
        </div>
        {airing ? (
          <p className="text-sm" title={formatAiring(airing.airingAt).tzName}>
            <span className="capitalize text-gray-300">{formatAiring(airing.airingAt).weekday}</span>
            <span className="text-gray-400">, {formatAiring(airing.airingAt).date}, {formatAiring(airing.airingAt).time} </span>
            <span className="text-xs text-gray-500">{formatAiring(airing.airingAt).tz}</span>
            <span className="font-medium text-indigo-300"> · {relative(airing.airingAt)}</span>
          </p>
        ) : (
          <NextEpisode media={media} variant="inline" />
        )}
        {media.studios.length > 0 && <p className="truncate text-xs text-gray-400">{media.studios.join(", ")}</p>}
        {media.genres.length > 0 && (
          <p className="text-xs text-gray-400">{media.genres.slice(0, 4).map((g) => GENRE_LABELS[g] ?? g).join(" · ")}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ListControl media={media} compact />
          <RequestButton media={media} size="sm" />
          <VoicesButton media={media} size="sm" />
        </div>
      </div>
    </div>
  );
}
