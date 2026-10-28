"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useAnime, useEpisodeStatus, usePlot } from "@/lib/client";
import { playable, type EpisodeStatus } from "@/lib/playback";
import { displayTitle } from "@/lib/schedule";
import { Breadcrumbs } from "../Breadcrumbs";
import { cx } from "../ui";
import { Player } from "./Player";

// Страница просмотра серии: плеер, соседние серии, полоска серий с готовностью.

const CHIP: Record<EpisodeStatus["state"], string> = {
  library: "tone-positive soft",
  stream: "tone-accent soft",
  downloading: "tone-info soft",
  aired: "bg-gray-800/60 text-gray-500 ring-gray-700",
  upcoming: "bg-gray-900/60 text-gray-600 ring-gray-800",
};

export function WatchView({ id, ep }: { id: number; ep: number }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: a } = useAnime(id);
  const { data: plot } = usePlot(id);
  const { data: st } = useEpisodeStatus(id);
  const eps = st?.episodes ?? [];
  const nextEp = eps.find((s) => s.ep > ep && playable(s));
  const epTitle = plot?.episodes.find((e) => e.number === ep)?.title;
  const name = a ? displayTitle(a.title) : "";
  const go = useCallback((n: number) => router.push(`/anime/${id}/watch/${n}`), [router, id]);
  // Серия досмотрена (отмечена на сервере) — обновить список и кнопку «Смотреть»
  const onReport = useCallback((r: { marked: boolean }) => {
    if (r.marked) void qc.invalidateQueries({ queryKey: ["list"] });
  }, [qc]);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Breadcrumbs items={[{ label: name || "Тайтл", href: `/anime/${id}` }, { label: `Серия ${ep}` }]} />
      <Player key={`${id}:${ep}`} anilistId={id} ep={ep} title={`${name} · ${ep} серия${epTitle ? ` · ${epTitle}` : ""}`}
        next={nextEp ? { label: `${nextEp.ep} серия`, go: () => go(nextEp.ep) } : null}
        onEnded={nextEp ? () => go(nextEp.ep) : undefined} onReport={onReport} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold">{ep} серия{epTitle ? <span className="font-normal text-gray-300"> · {epTitle}</span> : null}</h1>
        <Link href={`/anime/${id}`} className="text-sm text-accent-300 hover:text-accent-200">{name}</Link>
      </div>
      {eps.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {eps.map((s) => {
            const can = playable(s);
            const cls = cx("grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-sm tabular-nums ring-1 ring-inset", CHIP[s.state], s.ep === ep && "outline-2 outline-offset-1 outline-accent-400");
            const tip = { library: "В библиотеке", stream: s.ready ? "«Стрим», в кэше" : "«Стрим»", downloading: "Качается", aired: "Нет раздачи", upcoming: "Ещё не вышла" }[s.state];
            return can
              ? <Link key={s.ep} href={`/anime/${id}/watch/${s.ep}`} title={tip} className={cx(cls, "transition hover:brightness-125")}>{s.ep}</Link>
              : <span key={s.ep} title={tip} className={cls}>{s.ep}</span>;
          })}
        </div>
      )}
    </div>
  );
}
