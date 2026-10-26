"use client";
import { useGenres } from "@/lib/client";
import { DEFAULT_FILTERS, type Filters, type ListFilter } from "@/lib/filters";
import { COUNTRY_LABELS, FORMAT_LABELS, GENRE_LABELS, LIST_LABELS, SEASON_LABELS, SOURCE_LABELS } from "@/lib/labels";
import { Button, Chip, cx } from "./ui";
import { YearRange } from "./YearRange";

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</h4>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const LIST_OPTIONS: { value: ListFilter; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "mine", label: "В моих списках" },
  { value: "watching", label: LIST_LABELS.watching },
  { value: "waiting", label: LIST_LABELS.waiting },
  { value: "planned", label: LIST_LABELS.planned },
  { value: "completed", label: LIST_LABELS.completed },
  { value: "on_hold", label: LIST_LABELS.on_hold },
];

const select =
  "rounded-md border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none";

export function FilterPanel({ filters, onChange, showMode, showList = true, showPeriod }: {
  filters: Filters;
  onChange: (f: Filters) => void;
  showMode?: boolean;
  showList?: boolean;
  /** Годы и сезоны (каталог) */
  showPeriod?: boolean;
}) {
  const { data: genres } = useGenres();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  // Жанр: нейтрально → включить → исключить → нейтрально
  const cycleGenre = (g: string) => {
    if (filters.genresIn.includes(g)) set({ genresIn: toggle(filters.genresIn, g), genresEx: [...filters.genresEx, g] });
    else if (filters.genresEx.includes(g)) set({ genresEx: toggle(filters.genresEx, g) });
    else set({ genresIn: [...filters.genresIn, g] });
  };

  return (
    <div className="space-y-5">
      {showMode && (
        <Section title="Показывать">
          <div className="inline-flex rounded-md ring-1 ring-gray-600">
            {(["finales", "all"] as const).map((m) => (
              <button key={m} onClick={() => set({ mode: m })}
                className={cx("px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md",
                  filters.mode === m ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700")}>
                {m === "finales" ? "Только финалы" : "Все серии"}
              </button>
            ))}
          </div>
        </Section>
      )}

      {showPeriod && (
        <>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Годы</h4>
            <YearRange from={filters.yearFrom} to={filters.yearTo} onChange={(yearFrom, yearTo) => set({ yearFrom, yearTo })} />
          </div>
          <Section title="Сезон">
            {SEASONS.map((s) => (
              <Chip key={s} active={filters.seasons.includes(s)} onClick={() => set({ seasons: toggle(filters.seasons, s) })}>
                {SEASON_LABELS[s]}
              </Chip>
            ))}
          </Section>
        </>
      )}

      {showList && (
        <Section title="Мои списки">
          {LIST_OPTIONS.map((o) => (
            <Chip key={o.value} active={filters.list === o.value} onClick={() => set({ list: o.value })}>{o.label}</Chip>
          ))}
        </Section>
      )}

      {showPeriod && (
        <Section title="Статус">
          {([["RELEASING", "Выходит"], ["FINISHED", "Вышло"], ["NOT_YET_RELEASED", "Анонс"]] as const).map(([v, t]) => (
            <Chip key={v} active={filters.statuses.includes(v)} onClick={() => set({ statuses: toggle(filters.statuses, v) })}>{t}</Chip>
          ))}
        </Section>
      )}

      <Section title="Формат">
        {["TV", "TV_SHORT", "ONA", "OVA", "MOVIE", "SPECIAL"].map((f) => (
          <Chip key={f} active={filters.formats.includes(f)} onClick={() => set({ formats: toggle(filters.formats, f) })}>
            {FORMAT_LABELS[f]}
          </Chip>
        ))}
      </Section>

      <Section title="Страна">
        {Object.entries(COUNTRY_LABELS).map(([code, name]) => (
          <Chip key={code} active={filters.countries.includes(code)} onClick={() => set({ countries: toggle(filters.countries, code) })}>
            {name}
          </Chip>
        ))}
      </Section>

      <Section title="Жанры (клик: включить → исключить)">
        {(genres ?? Object.keys(GENRE_LABELS)).filter((g) => g !== "Hentai").map((g) => (
          <Chip key={g} active={filters.genresIn.includes(g)} negative={filters.genresEx.includes(g)} onClick={() => cycleGenre(g)}>
            {GENRE_LABELS[g] ?? g}
          </Chip>
        ))}
      </Section>

      <Section title="Первоисточник">
        {Object.entries(SOURCE_LABELS).map(([code, name]) => (
          <Chip key={code} active={filters.sources.includes(code)} onClick={() => set({ sources: toggle(filters.sources, code) })}>
            {name}
          </Chip>
        ))}
      </Section>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Оценка от
          <select className={cx(select, "mt-2 block w-full normal-case")} value={filters.minScore}
            onChange={(e) => set({ minScore: Number(e.target.value) })}>
            {[0, 60, 65, 70, 75, 80, 85].map((v) => <option key={v} value={v}>{v ? (v / 10).toFixed(1) : "любой"}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Популярность от
          <select className={cx(select, "mt-2 block w-full normal-case")} value={filters.minPopularity}
            onChange={(e) => set({ minPopularity: Number(e.target.value) })}>
            {[0, 150, 500, 1000, 5000, 20000, 50000, 100000].map((v) => <option key={v} value={v}>{v ? v.toLocaleString("ru-RU") : "любая"}</option>)}
          </select>
        </label>
        {showPeriod && (
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Серий от
            <select className={cx(select, "mt-2 block w-full normal-case")} value={filters.minEpisodes}
              onChange={(e) => set({ minEpisodes: Number(e.target.value) })}>
              {[0, 2, 7, 13, 25, 50].map((v) => <option key={v} value={v}>{v ? `${v}` : "любое число"}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="-mt-2 text-xs text-gray-500">Популярность — сколько человек добавили тайтл в списки на AniList (аналог «оценок» на AniLib).</p>

      <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={!filters.hideAdult}
          onChange={(e) => set({ hideAdult: !e.target.checked })} />
        Показывать 18+
      </label>
      <p className="text-xs text-gray-500">Оценка — по MAL, а если её нет — по AniList.</p>

      <Button size="sm" variant="ghost" onClick={() => onChange({ ...DEFAULT_FILTERS, mode: filters.mode })}>
        Сбросить фильтры
      </Button>
    </div>
  );
}
