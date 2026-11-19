"use client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/client";
import { staleReportedAt, staleSnapshot, subscribeStale } from "@/lib/stale-data";
import { claimServiceNotice } from "@/lib/service-notice";
import { Toast } from "./Toast";

type Health = { sources: { id: string; name: string; down: boolean }[] };
const NAMES: Record<string, string> = { anilist: "AniList", shikimori: "Shikimori", tmdb: "TMDB", kitsu: "Kitsu", jellyfin: "Jellyfin", seerr: "Seerr", fandom: "Fandom", wikipedia: "Википедия", mal: "MyAnimeList", cache: "Внешний сервис" };
const EMPTY: Record<string, number> = {};
const memory = new Set<string>();

/** Health reporting stays global; presentation is outside page stacking contexts. */
export function StaleBanner() {
  const stale = useSyncExternalStore(subscribeStale, staleSnapshot, () => EMPTY);
  const { data } = useQuery({ queryKey: ["sources-health"], queryFn: () => api<Health>("/api/health/sources"), refetchInterval: 120_000, staleTime: 60_000 });
  const recent = Date.now() - staleReportedAt() < 10 * 60_000 ? Object.keys(stale) : [];
  const signature = [...new Set([...recent, ...(data?.sources ?? []).filter(s => s.down).map(s => s.id)])].sort().join(",");
  const [notices, setNotices] = useState<string[]>([]);
  useEffect(() => {
    const fresh = signature.split(",").filter(Boolean).filter(id => {
      if (memory.has(id)) return false;
      try { if (!claimServiceNotice(id, Date.now(), sessionStorage, localStorage)) return false; }
      catch { /* Blocked storage: still suppress repeats for this running application. */ }
      memory.add(id); return true;
    });
    if (fresh.length) setNotices(previous => [...previous, ...fresh]);
  }, [signature]);
  useEffect(() => {
    if (!notices.length) return;
    const timer = setTimeout(() => setNotices([]), 12_000);
    return () => clearTimeout(timer);
  }, [notices]);
  if (!notices.length) return null;
  const names = notices.map(id => data?.sources.find(s => s.id === id)?.name ?? NAMES[id] ?? id).join(", ");
  return createPortal(<div className="pointer-events-none fixed right-4 top-28 z-[100] w-96 max-w-[calc(100vw-2rem)]"><Toast title={`${names} ${notices.length > 1 ? "недоступны" : "недоступен"}`} onDismiss={() => setNotices([])}>
    Часть функций временно недоступна. Сохранённые данные остаются доступны; подключение проверяется автоматически.
  </Toast></div>, document.body);
}
