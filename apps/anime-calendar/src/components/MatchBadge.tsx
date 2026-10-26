"use client";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import Link from "next/link";
import { useState } from "react";
import { useList, useMatch } from "@/lib/client";
import { TagList } from "./TagList";
import { TONE_CLASS, cx, matchTone } from "./ui";


const Links = ({ items }: { items: { id: number; title: string }[] }) => (
  <>{items.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/anime/${s.id}`} className="text-indigo-300 hover:text-indigo-200">{s.title}</Link></span>)}</>
);

/** «Насколько мне понравится»: перцентиль среди популярного и объяснение по клику. Для просмотренного не показываем. */
export function MatchBadge({ id }: { id: number }) {
  const { byId } = useList();
  const entry = byId.get(id);
  const seen = entry && ["completed", "dropped", "rewatching"].includes(entry.status);
  const { data: m } = useMatch(id, !seen);
  const [open, setOpen] = useState(false);
  if (seen || !m) return null;
  const tone = cx(TONE_CLASS[matchTone(m.percent)], "soft");

  return (
    <div className="w-full">
      <button onClick={() => setOpen(!open)}
        className={cx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition", tone)}>
        <b className="tabular-nums">{m.percent}%</b> · {m.verdict}
        <ChevronDownIcon className={cx("h-4 w-4 opacity-70 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2 max-w-xl space-y-1 rounded-lg bg-gray-900/70 p-3 text-sm text-gray-300 ring-1 ring-gray-700">
          <p className="text-gray-400">Подходит вам лучше, чем {m.percent}% популярных аниме — по вашему списку, оценкам и «рекомендую».</p>
          {m.similarTo.length > 0 && <p>Похоже на ваши любимые: <Links items={m.similarTo} /></p>}
          {m.likedTags.length > 0 && <p>Темы, которые вам нравятся: <TagList names={m.likedTags} /></p>}
          {m.likedTraits?.length ? <p>По ощущению в вашем вкусе: {m.likedTraits.join(", ")}</p> : null}
          {m.dislikedSimilar.length > 0 && <p className="text-warning-200">Похоже на то, что не зашло: <Links items={m.dislikedSimilar} /></p>}
          {m.dislikedTags.length > 0 && <p className="text-warning-200">Темы, которые вам не нравятся: <TagList names={m.dislikedTags} /></p>}
          {m.dislikedTraits?.length ? <p className="text-warning-200">По ощущению не ваше: {m.dislikedTraits.join(", ")}</p> : null}
          {m.lowConfidence && <p className="text-xs text-gray-500">Оценок пока мало — прогноз приблизительный.</p>}
        </div>
      )}
    </div>
  );
}
