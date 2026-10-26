import "server-only";
import { gql } from "../anilist";
import { cached } from "../cache";
import { mappingsForTvdb, type TvdbMapping } from "../idmap";
import { shikiInfo } from "../shikimori";
import { sonarrEpisodes, sonarrSeries, type SonarrSeries } from "./arr";
import { normalizeName, seasonFromName, type ParsedRelease } from "./parse";
import type { EpisodeRefLike } from "./title";

// Определение раздачи: какой это сериал в Sonarr и какие серии в нумерации TVDB.

type Candidate = { series: SonarrSeries; mapping?: TvdbMapping };

type AnilistNames = { anilistId: number; names: string[] };

const NAMES_QUERY = `
query ($ids: [Int], $page: Int) {
  Page(page: $page, perPage: 50) {
    media(id_in: $ids, type: ANIME) { id idMal title { romaji english } synonyms }
  }
}`;

/** Названия всех сезонов/частей сериала с AniList + русские из Shikimori (кэш на неделю). */
export function anilistNames(tvdb: number, ids: number[]): Promise<AnilistNames[]> {
  return cached(`ru:names:${tvdb}:${ids.length}`, 7 * 86400, async () => {
    const out: AnilistNames[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await gql<{
        Page: { media: { id: number; idMal: number | null; title: { romaji: string | null; english: string | null }; synonyms: string[] }[] };
      }>(NAMES_QUERY, { ids: ids.slice(i, i + 50), page: 1 });
      const ru = await shikiInfo(data.Page.media.map((m) => m.idMal).filter((x): x is number => Boolean(x)));
      for (const m of data.Page.media) {
        const names = [m.title.romaji, m.title.english, ...(m.synonyms ?? []), m.idMal ? ru.get(m.idMal)?.russian : null];
        out.push({ anilistId: m.id, names: names.filter((n): n is string => Boolean(n)) });
      }
    }
    return out;
  });
}

/** Убрать из названия пометки сезона и части: «Slime 3rd Season Part 2» → «Slime» */
export function baseName(name: string): string {
  return name
    .replace(/\b\d+(?:st|nd|rd|th)\s+Season\b/gi, "")
    .replace(/\bSeason\s+\d+\b/gi, "")
    .replace(/\b(first|second|third|fourth|fifth|sixth)\s+season\b/gi, "")
    .replace(/\b(Part|Cour)\s+\d+\b/gi, "")
    .replace(/\bDai\s+\d+\s+Bu\b/gi, "")
    .replace(/\b(Final Season|The Final)\b/gi, "")
    .replace(/\s(II|III|IV|V|VI|VII)(?=:|\s|$)/g, "")
    .replace(/\s\d$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Index = {
  exact: Map<string, Candidate[]>;
  base: Map<string, Candidate[]>;
  /** Названия сезонов по сериалам: seriesId → anilistId → названия (romaji первым) */
  seasonNames: Map<number, Map<number, string[]>>;
};

let index: { value: Index; builtAt: number } | null = null;
let building: Promise<Index> | null = null;

function add(map: Map<string, Candidate[]>, name: string, c: Candidate) {
  const key = normalizeName(name);
  if (key.length < 2) return;
  const list = map.get(key);
  if (!list) map.set(key, [c]);
  else if (!list.some((x) => x.series.id === c.series.id && x.mapping?.anilistId === c.mapping?.anilistId)) list.push(c);
}

async function buildIndex(): Promise<Index> {
  const exact = new Map<string, Candidate[]>();
  const base = new Map<string, Candidate[]>();
  const seasonNames = new Map<number, Map<number, string[]>>();
  for (const series of await sonarrSeries()) {
    const titles = [series.title, ...(series.alternateTitles ?? []).map((t) => t.title)];
    for (const t of titles) {
      add(exact, t, { series });
      add(base, baseName(t), { series });
    }
    const mappings = (await mappingsForTvdb(series.tvdbId)).filter((m) => m.season !== 0);
    if (!mappings.length) continue;
    try {
      const names = await anilistNames(series.tvdbId, mappings.map((m) => m.anilistId));
      seasonNames.set(series.id, new Map(names.map((n) => [n.anilistId, n.names])));
      for (const n of names) {
        const mapping = mappings.find((m) => m.anilistId === n.anilistId);
        for (const name of n.names) {
          add(exact, name, { series, mapping });
          add(base, baseName(name), { series });
        }
      }
    } catch (err) {
      console.warn(`[ru] названия AniList для ${series.title}: ${String(err)}`);
    }
  }
  return { exact, base, seasonNames };
}

/** Сбросить индекс (например, после добавления сериала в Sonarr). */
export function resetIndex() {
  index = null;
}

export async function getIndex(): Promise<Index> {
  if (index && Date.now() - index.builtAt < 10 * 60_000) return index.value;
  building ??= buildIndex()
    .then((value) => {
      index = { value, builtAt: Date.now() };
      return value;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

export type Identified = {
  series: SonarrSeries;
  /** Сезон TVDB или "a" — сквозная нумерация */
  season: number | "a";
  offset: number;
  anilistId: number | null;
};

/** Выбрать запись AniList по номеру сезона и части из названия раздачи. */
async function pickMapping(series: SonarrSeries, parsed: ParsedRelease): Promise<Omit<Identified, "series">> {
  const all = (await mappingsForTvdb(series.tvdbId)).filter((m) => m.season !== 0 && m.type !== "MOVIE");
  const wanted = parsed.season ?? 1;
  const inSeason = all.filter((m) => m.season === wanted).sort((a, b) => a.offset - b.offset);
  const chosen = inSeason[(parsed.part ?? 1) - 1] ?? inSeason[0];
  if (chosen) return { season: chosen.season, offset: chosen.offset, anilistId: chosen.anilistId };
  // Длинные сериалы со сквозной нумерацией (One Piece)
  const absolute = all.find((m) => m.season === "a");
  if (absolute && parsed.season === null) return { season: "a", offset: absolute.offset, anilistId: absolute.anilistId };
  return { season: wanted, offset: 0, anilistId: null };
}

export async function identify(parsed: ParsedRelease, onlyTvdb?: number): Promise<Identified | null> {
  const { exact, base } = await getIndex();
  const accept = (c: Candidate) => onlyTvdb === undefined || c.series.tvdbId === onlyTvdb;

  // 1. Точное совпадение с названием конкретного сезона на AniList — самое надёжное
  for (const name of parsed.names) {
    const hits = (exact.get(normalizeName(name)) ?? []).filter(accept);
    const specific = hits.find((h) => h.mapping);
    if (specific?.mapping) {
      const m = specific.mapping;
      // Название может совпасть с первым сезоном, а в раздаче явно указан другой
      if (parsed.season && typeof m.season === "number" && m.season !== parsed.season) {
        return { series: specific.series, ...(await pickMapping(specific.series, parsed)) };
      }
      return { series: specific.series, season: m.season, offset: m.offset, anilistId: m.anilistId };
    }
    if (hits[0]) return { series: hits[0].series, ...(await pickMapping(hits[0].series, parsed)) };
  }
  // 2. Совпадение по названию без пометок сезона + номер сезона из раздачи
  for (const name of parsed.names) {
    const hits = (base.get(normalizeName(baseName(name))) ?? []).filter(accept);
    if (hits[0]) {
      const fromName = seasonFromName(name);
      const p = { ...parsed, season: parsed.season ?? fromName.season, part: parsed.part ?? fromName.part };
      return { series: hits[0].series, ...(await pickMapping(hits[0].series, p)) };
    }
  }
  return null;
}

export type EpisodeRef = EpisodeRefLike;

/** Перевести серии раздачи в нумерацию Sonarr (TVDB). */
export async function mapEpisodes(id: Identified, parsed: ParsedRelease): Promise<EpisodeRef | null> {
  if (parsed.kind === "Movie") return null;
  const eps = await sonarrEpisodes(id.series.id).catch(() => []);
  const from = (parsed.episodes?.from ?? 1) + id.offset;
  const to = (parsed.episodes?.to ?? parsed.total ?? 0) + id.offset;

  if (id.season === "a") return parsed.episodes ? { kind: "absolute", from, to } : null;

  const inSeason = eps.filter((e) => e.seasonNumber === id.season);
  const seasonCount = inSeason.length;
  // Номера больше, чем серий в сезоне: раздача в сквозной нумерации (Bleach 367–380)
  if (seasonCount && parsed.episodes && to > seasonCount && eps.some((e) => e.absoluteEpisodeNumber)) {
    return { kind: "absolute", from: parsed.episodes.from, to: parsed.episodes.to };
  }
  if (!parsed.episodes) {
    // Серии не указаны, но это сезонная раздача: считаем весь сезон
    return parsed.kind === "TV" && seasonCount ? { kind: "season", season: id.season, from: 1, to: seasonCount, full: true } : null;
  }
  const full = from <= 1 && seasonCount > 0 && to >= seasonCount;
  return { kind: "season", season: id.season, from, to, full };
}
