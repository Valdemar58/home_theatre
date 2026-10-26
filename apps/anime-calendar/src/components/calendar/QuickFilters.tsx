"use client";
import { AdjustmentsHorizontalIcon } from "@heroicons/react/24/outline";
import { activeFilterCount, type Filters } from "@/lib/filters";
import { cx } from "../ui";

// «Без коротких» = все форматы, кроме TV_SHORT (минутки по 3–5 минут забивают календарь)
const NO_SHORTS = ["TV", "ONA", "OVA", "MOVIE", "SPECIAL"];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

type Quick = { label: string; active: (f: Filters) => boolean; toggle: (f: Filters) => Filters };

const QUICK: Quick[] = [
  {
    label: "Только финалы",
    active: (f) => f.mode === "finales",
    toggle: (f) => ({ ...f, mode: f.mode === "finales" ? "all" : "finales" }),
  },
  { label: "Мои списки", active: (f) => f.list === "mine", toggle: (f) => ({ ...f, list: f.list === "mine" ? "any" : "mine" }) },
  { label: "Жду выхода", active: (f) => f.list === "waiting", toggle: (f) => ({ ...f, list: f.list === "waiting" ? "any" : "waiting" }) },
  { label: "Смотрю", active: (f) => f.list === "watching", toggle: (f) => ({ ...f, list: f.list === "watching" ? "any" : "watching" }) },
  {
    label: "Япония",
    active: (f) => same(f.countries, ["JP"]),
    toggle: (f) => ({ ...f, countries: same(f.countries, ["JP"]) ? [] : ["JP"] }),
  },
  {
    label: "Без коротких",
    active: (f) => same(f.formats, NO_SHORTS),
    toggle: (f) => ({ ...f, formats: same(f.formats, NO_SHORTS) ? [] : NO_SHORTS }),
  },
  {
    label: "Оценка 7+",
    active: (f) => f.minScore === 70,
    toggle: (f) => ({ ...f, minScore: f.minScore === 70 ? 0 : 70 }),
  },
];

export function QuickFilters({ filters, onChange, onMore }: { filters: Filters; onChange: (f: Filters) => void; onMore: () => void }) {
  const count = activeFilterCount(filters);
  return (
    <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
      {QUICK.map((q) => {
        const on = q.active(filters);
        return (
          <button key={q.label} onClick={() => onChange(q.toggle(filters))}
            className={cx("shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition",
              on ? "border-indigo-500 bg-indigo-600 text-white" : "border-gray-700 bg-gray-800/60 text-gray-300 hover:border-gray-500 hover:text-white")}>
            {q.label}
          </button>
        );
      })}
      <button onClick={onMore}
        className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-700 px-3 py-1 text-xs font-medium text-gray-300 hover:border-gray-500 hover:text-white">
        <AdjustmentsHorizontalIcon className="h-4 w-4" /> Все фильтры{count ? ` · ${count}` : ""}
      </button>
    </div>
  );
}
