"use client";
import { CloudIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client";
import { staleReportedAt, staleSnapshot, subscribeStale } from "@/lib/stale-data";

// Плашка «источник недоступен — показываю сохранённое»: по заголовкам ответов (что из показанного устарело)
// и по состоянию источников (какие сейчас не отвечают). Закрывается до следующего изменения.

type Health = { sources: { id: string; name: string; down: boolean }[] };

const NAMES: Record<string, string> = {
  anilist: "AniList", shikimori: "Shikimori", tmdb: "TMDB", kitsu: "Kitsu", jellyfin: "Jellyfin", seerr: "Seerr",
  fandom: "Fandom", wikipedia: "Википедия", mal: "MyAnimeList", cache: "внешний сервис",
};
const EMPTY: Record<string, number> = {};
const date = (t: number) => new Date(t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

export function StaleBanner() {
  const stale: Record<string, number> = useSyncExternalStore(subscribeStale, staleSnapshot, () => EMPTY);
  const { data } = useQuery({ queryKey: ["sources-health"], queryFn: () => api<Health>("/api/health/sources"), refetchInterval: 120_000, staleTime: 60_000 });
  const down = (data?.sources ?? []).filter((s) => s.down && s.id !== "jellyfin");
  // Устаревшие ответы — только недавние: источник вернулся, свежие ответы идут — плашка уходит сама
  const recent = Date.now() - staleReportedAt() < 10 * 60_000 ? Object.keys(stale) : [];
  const ids = [...new Set([...recent, ...down.map((s) => s.id)])];
  const sig = ids.sort().join(",");
  const [closed, setClosed] = useState("");
  if (!ids.length || closed === sig) return null;
  const oldest = Math.min(...Object.values(stale));
  const names = ids.map((id) => NAMES[id] ?? id).join(", ");
  return (
    <div role="status" className="tone-warning soft mb-4 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-inset">
      <CloudIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {names} {ids.length > 1 ? "недоступны" : "недоступен"} — показываю сохранённое{Number.isFinite(oldest) ? ` (от ${date(oldest)})` : ""}.
        <span className="text-warning-200/70"> Новое подтянется, когда {ids.length > 1 ? "они ответят" : "он ответит"}.</span>
      </p>
      <button aria-label="Скрыть" onClick={() => setClosed(sig)} className="shrink-0 rounded p-0.5 hover:bg-warning-500/20"><XMarkIcon className="h-4 w-4" /></button>
    </div>
  );
}
