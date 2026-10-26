// Фильтры календаря и каталога. Хранятся в URL, применяются на клиенте.
import type { AiringKind } from "./schedule";
import type { ListEntry, ListStatus, MediaLite } from "./types";

/** Рейтинг по 10-балльной шкале: MAL, а если его нет — AniList. */
export function rating(m: Pick<MediaLite, "malScore" | "averageScore">): number {
  return m.malScore ?? (m.averageScore ?? 0) / 10;
}

export type ListFilter = "any" | "mine" | "waiting" | ListStatus;

export type Filters = {
  mode: "finales" | "all";
  formats: string[];
  genresIn: string[];
  genresEx: string[];
  countries: string[];
  sources: string[];
  minScore: number;
  minPopularity: number;
  hideAdult: boolean;
  list: ListFilter;
  q: string;
  /** Годы выхода «с — по» (0 — без границы) и сезоны (пусто — все); каталог */
  yearFrom: number;
  yearTo: number;
  seasons: string[];
  /** Статус выхода AniList (RELEASING / FINISHED / NOT_YET_RELEASED; пусто — любой) и минимум серий */
  statuses: string[];
  minEpisodes: number;
};

export const DEFAULT_FILTERS: Filters = {
  mode: "finales",
  formats: [],
  genresIn: [],
  genresEx: [],
  countries: [],
  sources: [],
  minScore: 0,
  minPopularity: 0,
  hideAdult: true,
  list: "any",
  q: "",
  yearFrom: 0,
  yearTo: 0,
  seasons: [],
  statuses: [],
  minEpisodes: 0,
};

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function parseFilters(params: URLSearchParams): Filters {
  return {
    mode: params.get("mode") === "all" ? "all" : "finales",
    formats: csv(params.get("format")),
    genresIn: csv(params.get("genres")),
    genresEx: csv(params.get("exclude")),
    countries: csv(params.get("country")),
    sources: csv(params.get("source")),
    minScore: Number(params.get("score")) || 0,
    minPopularity: Number(params.get("popularity")) || 0,
    hideAdult: params.get("adult") !== "1",
    list: (params.get("list") as ListFilter) || "any",
    q: params.get("q") ?? "",
    yearFrom: Number(params.get("from")) || 0,
    yearTo: Number(params.get("to")) || 0,
    seasons: csv(params.get("seasons")),
    statuses: csv(params.get("airing")),
    minEpisodes: Number(params.get("eps")) || 0,
  };
}

export function filtersToParams(f: Filters, base?: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  set("mode", f.mode === "all" ? "all" : null);
  set("format", f.formats.join(","));
  set("genres", f.genresIn.join(","));
  set("exclude", f.genresEx.join(","));
  set("country", f.countries.join(","));
  set("source", f.sources.join(","));
  set("score", f.minScore ? String(f.minScore) : null);
  set("popularity", f.minPopularity ? String(f.minPopularity) : null);
  set("adult", f.hideAdult ? null : "1");
  set("list", f.list !== "any" ? f.list : null);
  set("q", f.q.trim() || null);
  set("from", f.yearFrom ? String(f.yearFrom) : null);
  set("to", f.yearTo ? String(f.yearTo) : null);
  set("seasons", f.seasons.join(","));
  set("airing", f.statuses.join(","));
  set("eps", f.minEpisodes ? String(f.minEpisodes) : null);
  return p;
}

export function activeFilterCount(f: Filters): number {
  return (
    f.formats.length + f.genresIn.length + f.genresEx.length + f.countries.length + f.sources.length +
    Number(f.minScore > 0) + Number(f.minPopularity > 0) + Number(!f.hideAdult) + Number(f.list !== "any") +
    Number(Boolean(f.q.trim())) + Number(Boolean(f.yearFrom || f.yearTo)) + f.seasons.length +
    f.statuses.length + Number(f.minEpisodes > 0)
  );
}

function matchesList(entry: Pick<ListEntry, "status" | "waiting"> | undefined, list: ListFilter): boolean {
  if (list === "any") return true;
  if (!entry) return false;
  if (list === "mine") return true;
  if (list === "waiting") return entry.waiting;
  return entry.status === list;
}

/** Фильтр по свойствам тайтла (без режима финалов). */
export function matchesMedia(
  m: MediaLite,
  f: Filters,
  entry?: Pick<ListEntry, "status" | "waiting">,
): boolean {
  if (f.hideAdult && m.isAdult) return false;
  if (f.formats.length && !f.formats.includes(m.format ?? "")) return false;
  if (f.countries.length && !f.countries.includes(m.countryOfOrigin ?? "")) return false;
  if (f.sources.length && !f.sources.includes(m.source ?? "")) return false;
  if (f.genresIn.length && !f.genresIn.every((g) => m.genres.includes(g))) return false;
  if (f.genresEx.some((g) => m.genres.includes(g))) return false;
  if (f.minScore && rating(m) * 10 < f.minScore) return false;
  if (f.minPopularity && m.popularity < f.minPopularity) return false;
  if (f.statuses.length && !f.statuses.includes(m.status ?? "")) return false;
  if (f.minEpisodes && (m.episodes ?? 0) < f.minEpisodes) return false;
  if (!matchesList(entry, f.list)) return false;
  // Несколько сезонов AniList одним запросом не фильтрует — дочищаем здесь
  if (f.seasons.length && !f.seasons.includes(m.season ?? "")) return false;
  if (f.q.trim()) {
    const q = f.q.trim().toLowerCase();
    const hay = [m.title.ru, m.title.romaji, m.title.english, m.title.native].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function matchesAiring(
  kind: AiringKind,
  m: MediaLite,
  f: Filters,
  entry?: Pick<ListEntry, "status" | "waiting">,
): boolean {
  if (f.mode === "finales" && kind !== "finale") return false;
  return matchesMedia(m, f, entry);
}
