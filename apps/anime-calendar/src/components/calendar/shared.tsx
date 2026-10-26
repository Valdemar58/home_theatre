"use client";
import { FlagIcon } from "@heroicons/react/20/solid";
import { useList } from "@/lib/client";
import { displayTitle, type DayItem } from "@/lib/schedule";
import { formatTime } from "@/lib/time";
import { entryKey, STATUS_COLORS } from "../ListControl";
import { cx } from "../ui";
import { imgSrc } from "@/lib/img";
import { useHoverCard } from "../HoverCard";

export type OpenDay = (key: string, mediaId?: number) => void;

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg bg-gray-800 p-0.5 ring-1 ring-gray-700">
      {options.map(([v, text]) => (
        <button key={v} onClick={() => onChange(v)}
          className={cx("rounded-md px-3 py-1 text-xs font-medium transition sm:text-sm",
            value === v ? "bg-indigo-600 text-white shadow" : "text-gray-300 hover:text-white")}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Точка статуса из моих списков */
export function ListDot({ mediaId }: { mediaId: number }) {
  const { byId } = useList();
  const entry = byId.get(mediaId);
  if (!entry) return null;
  return <span className={cx("h-2 w-2 shrink-0 rounded-full border", STATUS_COLORS[entryKey(entry)])} />;
}

/** Строка тайтла в ячейке месяца: мини-постер, время, название. */
export function CellRow({ item, onClick }: { item: DayItem; onClick: () => void }) {
  const finale = item.kind === "finale";
  const hover = useHoverCard(item.media);
  return (
    <button
      {...hover}
      onClick={(e) => { hover.onClick?.(e); onClick(); }}
      className={cx(
        "group/row flex h-[22px] w-full items-center gap-1.5 overflow-hidden rounded-md pr-1.5 text-left text-[11px] leading-none transition",
        finale
          ? "bg-linear-to-r from-indigo-600 to-purple-600 text-white hover:brightness-110"
          : item.kind === "premiere"
            ? "bg-green-600/15 text-green-100 ring-1 ring-inset ring-green-600/40 hover:bg-green-600/25"
            : "bg-gray-800 text-gray-200 hover:bg-gray-700",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imgSrc(item.media.coverImage.large ?? "", "card")} alt="" loading="lazy"
        className="h-full w-4 shrink-0 object-cover" style={{ backgroundColor: item.media.coverImage.color ?? undefined }} />
      <span className={cx("shrink-0 tabular-nums", finale ? "text-white/80" : "text-gray-500")}>{formatTime(item.airing.airingAt)}</span>
      {finale && <FlagIcon className="h-3 w-3 shrink-0" />}
      <span className="truncate font-medium">{displayTitle(item.media.title)}</span>
      <span className="ml-auto pl-1"><ListDot mediaId={item.media.id} /></span>
    </button>
  );
}

export function dayTitle(key: string, today: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return key === today ? `Сегодня, ${date}` : date;
}

export function dayStats(items: DayItem[]): string {
  const finales = items.filter((i) => i.kind === "finale").length;
  const premieres = items.filter((i) => i.kind === "premiere").length;
  const parts = [`${items.length} ${plural(items.length, "серия", "серии", "серий")}`];
  if (finales) parts.push(`${finales} ${plural(finales, "финал", "финала", "финалов")}`);
  if (premieres) parts.push(`${premieres} ${plural(premieres, "премьера", "премьеры", "премьер")}`);
  return parts.join(" · ");
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
