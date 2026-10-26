"use client";
import { useFriendPicks } from "@/lib/client";
import { TitleCard } from "./TitleCard";

// Полка «Советуют друзья» на странице «Для тебя»: «рекомендую» друзей, ближе по вкусу — выше.

export function FriendPicks() {
  const { data } = useFriendPicks();
  if (!data?.length) return null;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Советуют друзья <span className="text-sm font-normal text-gray-500">ближе по вкусу — левее</span></h2>
      <div className="grid grid-flow-col auto-cols-[9.5rem] gap-4 overflow-x-auto pb-2 sm:auto-cols-[11rem]">
        {data.map((p) => (
          <TitleCard key={p.media.id} media={p.media}
            footer={
              <p className="text-xs text-green-300">
                {p.by.map((b, i) => <span key={b.id}>{i > 0 && ", "}{b.name}{b.taste !== null && <span className="text-gray-500"> {b.taste}%</span>}</span>)}
              </p>
            } />
        ))}
      </div>
    </section>
  );
}
