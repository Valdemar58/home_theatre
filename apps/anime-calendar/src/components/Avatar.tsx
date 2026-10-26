"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { cx } from "./ui";

// Аватар пользователя из Jellyfin; если не задан — первая буква имени на цветном круге.
// После смены аватарки — новый адрес (?v=), иначе браузер покажет старую из кэша.

const COLORS = ["bg-indigo-600", "bg-purple-600", "bg-sky-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600"];

const versions = new Map<number, number>();
const listeners = new Set<() => void>();
export function bumpAvatar(userId: number) {
  versions.set(userId, Date.now());
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => void listeners.delete(l); };

export function Avatar({ user, className }: { user: { id: number; name: string }; className?: string }) {
  const v = useSyncExternalStore(subscribe, () => versions.get(user.id) ?? 0, () => 0);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [v]);
  return (
    <span className={cx("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold uppercase text-white",
      COLORS[user.id % COLORS.length], className ?? "h-8 w-8 text-sm")} title={user.name}>
      {user.name.slice(0, 1)}
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/users/${user.id}/avatar${v ? `?v=${v}` : ""}`} alt="" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
      )}
    </span>
  );
}
