"use client";
import { HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/solid";
import Link from "next/link";
import { useOpinions } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { ago } from "@/lib/time";
import type { FriendOpinion } from "@/lib/types";
import { Avatar } from "./Avatar";

// «Друзья о тайтле»: статус, оценка и «советую» тех, чьи списки мне видны; сверху — с похожим вкусом.

const SIMILAR = 60; // с какого совпадения вкусов «похож на вас»

function progress(o: FriendOpinion) {
  if (o.status === "watching" || o.status === "rewatching" || o.status === "on_hold" || o.status === "dropped")
    return o.episodes ? `${LIST_LABELS[o.status].toLowerCase()}, ${o.episodes} эп.` : LIST_LABELS[o.status].toLowerCase();
  return LIST_LABELS[o.status].toLowerCase();
}

export function FriendOpinions({ id }: { id: number }) {
  const { data } = useOpinions(id);
  if (!data?.length) return null;
  const similar = data.filter((o) => (o.taste ?? 0) >= SIMILAR && o.recommend !== null);
  const yes = similar.filter((o) => o.recommend).length;
  return (
    <div className="rounded-xl bg-gray-800/60 p-4 ring-1 ring-gray-700">
      <h3 className="mb-1 text-sm font-semibold">Друзья</h3>
      {similar.length > 0 && (
        <p className="mb-2 text-xs text-gray-400">
          Похожие на вас по вкусу: <b className={yes * 2 >= similar.length ? "text-green-300" : "text-red-300"}>{yes} из {similar.length}</b> советуют
        </p>
      )}
      <ul className="space-y-2">
        {data.map((o) => (
          <li key={o.user.id} className="flex items-center gap-2.5">
            <Link href={`/users/${o.user.id}`}><Avatar user={o.user} /></Link>
            <div className="min-w-0 flex-1 text-sm">
              <Link href={`/users/${o.user.id}`} className="font-medium hover:text-indigo-300">{o.user.name}</Link>
              {o.taste !== null && <span className="ml-1.5 text-xs text-gray-500" title="Совпадение вкусов с вами">{o.taste}%</span>}
              <p className="text-xs text-gray-400" title={new Date(o.updatedAt * 1000).toLocaleString("ru-RU")}>
                {progress(o)} · {ago(o.updatedAt)}
              </p>
            </div>
            {o.score > 0 && <span className="text-sm font-semibold text-amber-300">★ {o.score}</span>}
            {o.recommend === true && <HandThumbUpIcon className="h-4 w-4 text-green-400" aria-label="Советует" />}
            {o.recommend === false && <HandThumbDownIcon className="h-4 w-4 text-red-400" aria-label="Не советует" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
