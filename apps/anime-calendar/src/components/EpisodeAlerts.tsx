"use client";
import { BellAlertIcon, BellSlashIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useList } from "@/lib/client";
import { Button } from "./ui";

// Уведомления о сериях тайтла: «Смотрю» — о каждой новой, «Жду выхода» — когда вышла последняя.
// Кнопка видна только для этих статусов и только пока тайтл выходит.

export function EpisodeAlerts({ id, airing }: { id: number; airing: boolean }) {
  const { byId } = useList();
  const e = byId.get(id);
  const relevant = airing && e && (e.status === "watching" || (e.status === "planned" && e.waiting));
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["mute", id], queryFn: () => api<{ muted: boolean }>(`/api/anime/${id}/mute`), enabled: Boolean(relevant) });
  if (!relevant || !data) return null;
  const toggle = async () => {
    qc.setQueryData(["mute", id], { muted: !data.muted });
    await api(`/api/anime/${id}/mute`, { method: "POST", json: { muted: !data.muted } });
  };
  const what = e.status === "watching" ? "о каждой новой серии" : "когда выйдет последняя серия";
  return (
    <Button onClick={toggle} variant={data.muted ? "ghost" : "default"} title={data.muted ? `Включить уведомления ${what}` : `Уведомляю ${what}. Нажмите, чтобы выключить`}>
      {data.muted ? <BellSlashIcon className="h-4 w-4 text-gray-500" /> : <BellAlertIcon className="h-4 w-4 text-indigo-300" />}
      {data.muted ? "Без уведомлений" : e.status === "watching" ? "О новых сериях" : "О выходе целиком"}
    </Button>
  );
}
