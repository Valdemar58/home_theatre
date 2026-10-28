"use client";
import { ArrowDownTrayIcon, BoltIcon, MagnifyingGlassIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, useEpisodeStatus, useMe } from "@/lib/client";
import { waitText, watchTarget, type EpisodeStatus } from "@/lib/playback";
import { Badge, Button, cx, Spinner } from "./ui";

// Одна кнопка «Смотреть»: следующая серия после просмотренных — в каком она состоянии и что сделать.
// Есть в библиотеке или в «Стриме» — смотреть; «Стрим» не подготовлен — смотреть сразу или подготовить буфер;
// качается — прогресс; вышла, но нет — выбрать раздачу с озвучкой.

/** Где смотреть серию (до плеера в календаре — страница серии в Jellyfin). */
export function useWatchHref() {
  const { data: me } = useMe();
  const jf = me?.services.find((s) => s.id === "jellyfin")?.url;
  return (s: EpisodeStatus) => (s.itemId && jf ? `${jf}/web/#/details?id=${s.itemId}` : null);
}

/** Подготовить серию «Стрима» (буфер TorrServer, уведомление — когда можно смотреть без остановок). */
export function usePrepare(anilistId: number) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const prepare = async (s: EpisodeStatus) => {
    if (!s.hash || !s.index) return;
    setBusy(true);
    try {
      await api("/api/downloads/prebuffer", { method: "POST", json: { hash: s.hash, index: s.index } });
      await qc.invalidateQueries({ queryKey: ["episode-status", anilistId] });
    } finally {
      setBusy(false);
    }
  };
  return { prepare, busy };
}

export function WatchButton({ anilistId, watched, onFind }: { anilistId: number; watched: number; onFind: () => void }) {
  const { data } = useEpisodeStatus(anilistId);
  const href = useWatchHref();
  const { prepare, busy } = usePrepare(anilistId);
  const t = data ? watchTarget(data.episodes, watched) : null;
  if (!t) return null;
  const n = `${t.ep} серию`;
  const url = href(t);

  if (t.state === "library" || (t.state === "stream" && t.ready)) {
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        <Button variant="primary"><PlayIcon className="h-4 w-4" /> Смотреть {n}</Button>
      </a>
    ) : null;
  }
  if (t.state === "stream") {
    return (
      <span className="inline-flex items-center gap-2">
        {url && (
          <a href={url} target="_blank" rel="noreferrer" title="Раздача качается под просмотр — в начале возможны остановки">
            <Button variant="primary"><PlayIcon className="h-4 w-4" /> Смотреть {n}</Button>
          </a>
        )}
        {t.preparing ? (
          <span className="text-sm text-gray-300">
            <Spinner className="mr-1 inline h-4 w-4" />
            Буферизация{t.pct !== undefined ? ` ${Math.round(t.pct * 100)}%` : ""}{t.etaSec ? ` · без остановок через ~${waitText(t.etaSec)}` : ""}
          </span>
        ) : (
          <Button onClick={() => prepare(t)} disabled={busy} title="Скачать начало заранее, уведомление — когда можно смотреть без остановок">
            <BoltIcon className="h-4 w-4" /> Подготовить
          </Button>
        )}
      </span>
    );
  }
  if (t.state === "downloading") {
    return (
      <Button disabled title="Серия качается в библиотеку">
        <ArrowDownTrayIcon className="h-4 w-4" /> {t.ep} серия качается · {Math.round((t.pct ?? 0) * 100)}%{t.etaSec ? ` · ~${waitText(t.etaSec)}` : ""}
      </Button>
    );
  }
  if (t.state === "aired") {
    return <Button variant="primary" onClick={onFind}><MagnifyingGlassIcon className="h-4 w-4" /> Найти {n}</Button>;
  }
  return null;
}

/** Значок готовности серии в списке серий. */
export function EpisodeReadiness({ s, anilistId }: { s: EpisodeStatus | undefined; anilistId: number }) {
  const href = useWatchHref();
  const { prepare, busy } = usePrepare(anilistId);
  if (!s || s.state === "upcoming" || s.state === "aired") return null;
  const url = href(s);
  const play = (label: string, tone: "positive" | "accent", title: string) => {
    const badge = <Badge tone={tone} className={cx(url && "transition hover:brightness-125")}><PlayIcon className="h-3 w-3" />{label}</Badge>;
    return url ? <a href={url} target="_blank" rel="noreferrer" title={title}>{badge}</a> : <span title={title}>{badge}</span>;
  };
  if (s.state === "library") return play("Смотреть", "positive", "Серия в библиотеке");
  if (s.state === "downloading") {
    return <Badge tone="info" className="tabular-nums"><ArrowDownTrayIcon className="h-3 w-3" />{Math.round((s.pct ?? 0) * 100)}%</Badge>;
  }
  // «Стрим»
  if (s.ready) return play("Смотреть", "positive", "Серия в кэше TorrServer — без остановок");
  return (
    <span className="inline-flex items-center gap-1">
      {play("Стрим", "accent", "Раздача качается под просмотр — в начале возможны остановки")}
      {s.preparing ? (
        <span className="text-xs text-gray-400" title="Готовлю буфер">
          <Spinner className="mr-0.5 inline h-3 w-3" />{s.etaSec ? `~${waitText(s.etaSec)}` : `${Math.round((s.pct ?? 0) * 100)}%`}
        </span>
      ) : (
        <button onClick={() => prepare(s)} disabled={busy} className="rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title="Подготовить: скачать начало заранее, уведомление — когда можно смотреть без остановок">
          <BoltIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}
