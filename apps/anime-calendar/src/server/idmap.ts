import "server-only";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

// Соответствия ID между базами:
//  - github.com/Fribb/anime-lists: AniList → TMDB / TVDB / AniDB (+ сезон TVDB)
//  - github.com/Anime-Lists/anime-lists: AniDB → сезон TVDB и сдвиг серий
//    (например, «2nd Season Part 2» = S02, сдвиг 12 → серии 1–12 это S02E13–24)
// Оба файла обновляются раз в неделю.
const FRIBB = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
const ANIME_LISTS = "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml";
const FILE = () => path.join(env.dataDir, "idmap-v2.json");
const MAX_AGE_MS = 7 * 86400 * 1000;

export type ExternalIds = { tmdbTv: number | null; tmdbMovie: number | null; tvdb: number | null; tmdbSeason: number | null };

/** Где тайтл AniList лежит в нумерации TVDB. season = "a" — сквозная (абсолютная) нумерация. */
export type TvdbMapping = { anilistId: number; anidb: number | null; tvdb: number; season: number | "a"; offset: number; type: string | null };

// [tmdbTv, tmdbMovie, tvdb, tmdbSeason, anidb, tvdbSeason | "a", episodeOffset, type]
type Row = [number | null, number | null, number | null, number | null, number | null, number | "a" | null, number, string | null];
type Compact = Record<number, Row>;

type FribbEntry = {
  anilist_id?: number;
  anidb_id?: number;
  type?: string;
  themoviedb_id?: { tv?: number; movie?: number } | null;
  tvdb_id?: number;
  season?: { tmdb?: number; tvdb?: number };
};

let map: Compact | null = null;
let byTvdb: Map<number, TvdbMapping[]> | null = null;
let loading: Promise<void> | null = null;

/** anime-list-master.xml → AniDB id → { сезон TVDB, сдвиг серий } */
function parseAnimeLists(xml: string): Map<number, { season: number | "a"; offset: number }> {
  const out = new Map<number, { season: number | "a"; offset: number }>();
  for (const m of xml.matchAll(/<anime\s+([^>]*)>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const anidb = Number(attrs.anidbid);
    const season = attrs.defaulttvdbseason;
    if (!anidb || !season) continue;
    out.set(anidb, { season: season === "a" ? "a" : Number(season), offset: Number(attrs.episodeoffset) || 0 });
  }
  return out;
}

async function download(): Promise<void> {
  const [fribbRes, listsRes] = await Promise.all([
    fetch(FRIBB, { signal: AbortSignal.timeout(120_000) }),
    fetch(ANIME_LISTS, { signal: AbortSignal.timeout(120_000) }),
  ]);
  if (!fribbRes.ok) throw new Error(`Fribb anime-lists: HTTP ${fribbRes.status}`);
  const list = (await fribbRes.json()) as FribbEntry[];
  const offsets = listsRes.ok ? parseAnimeLists(await listsRes.text()) : new Map();
  const compact: Compact = {};
  for (const e of list) {
    if (!e.anilist_id) continue;
    const tv = e.themoviedb_id?.tv ?? null;
    const movie = e.themoviedb_id?.movie ?? null;
    if (!tv && !movie && !e.tvdb_id) continue;
    const o = e.anidb_id ? offsets.get(e.anidb_id) : undefined;
    compact[e.anilist_id] = [
      tv, movie, e.tvdb_id ?? null, e.season?.tmdb ?? null, e.anidb_id ?? null,
      o?.season ?? e.season?.tvdb ?? null, o?.offset ?? 0, e.type ?? null,
    ];
  }
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(compact));
  setMap(compact);
  console.log(`[idmap] загружено ${Object.keys(compact).length} соответствий, сдвигов серий: ${offsets.size}`);
}

function setMap(compact: Compact) {
  map = compact;
  byTvdb = new Map();
  for (const [id, r] of Object.entries(compact)) {
    if (!r[2] || r[5] === null) continue;
    const entry: TvdbMapping = { anilistId: Number(id), anidb: r[4], tvdb: r[2], season: r[5], offset: r[6], type: r[7] };
    const list = byTvdb.get(r[2]);
    if (list) list.push(entry);
    else byTvdb.set(r[2], [entry]);
  }
}

/** Загрузить с диска; скачать, если файла нет или он старше недели. */
export function ensureIdMap(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const stat = fs.statSync(FILE(), { throwIfNoEntry: false });
      if (stat) {
        if (!map) setMap(JSON.parse(fs.readFileSync(FILE(), "utf-8")) as Compact);
        if (Date.now() - stat.mtimeMs > MAX_AGE_MS) download().catch((e) => console.warn(`[idmap] ${e}`));
      } else {
        await download();
      }
    } catch (e) {
      console.warn(`[idmap] ${e}`);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function externalIds(anilistId: number): Promise<ExternalIds> {
  if (!map) await ensureIdMap();
  const e = map?.[anilistId];
  return e
    ? { tmdbTv: e[0], tmdbMovie: e[1], tvdb: e[2], tmdbSeason: e[3] }
    : { tmdbTv: null, tmdbMovie: null, tvdb: null, tmdbSeason: null };
}

/** Где тайтл AniList лежит в TVDB (сериал, сезон, сдвиг серий). */
export async function mappingForAnilist(anilistId: number): Promise<TvdbMapping | null> {
  if (!map) await ensureIdMap();
  const r = map?.[anilistId];
  if (!r || !r[2] || r[5] === null) return null;
  return { anilistId, anidb: r[4], tvdb: r[2], season: r[5], offset: r[6], type: r[7] };
}

/** Все тайтлы AniList, которые TVDB считает частями этого сериала (сезоны, части, спешлы). */
export async function mappingsForTvdb(tvdb: number): Promise<TvdbMapping[]> {
  if (!byTvdb) await ensureIdMap();
  return byTvdb?.get(tvdb) ?? [];
}

/** Тайтл AniList по сериалу TVDB, сезону и (если известна) серии в нумерации TVDB. */
export async function anilistForTvdb(tvdb: number, season: number, episode?: number): Promise<number | null> {
  const all = (await mappingsForTvdb(tvdb)).filter((m) => m.type !== "MOVIE");
  const inSeason = all.filter((m) => m.season === season).sort((a, b) => a.offset - b.offset);
  if (!inSeason.length) return all.find((m) => m.season === "a")?.anilistId ?? all[0]?.anilistId ?? null;
  // Части сезона: берём ту, чей сдвиг серий ещё не превышает номер серии
  const pick = episode ? [...inSeason].reverse().find((m) => m.offset < episode) : undefined;
  return (pick ?? inSeason[0]).anilistId;
}

/** Серия TVDB (сезон, номер) → тайтл AniList и номер серии в нём (с учётом сдвига частей сезона). */
export async function anilistEpisodeFromTvdb(tvdb: number, season: number, episode: number): Promise<{ anilistId: number; episode: number } | null> {
  const all = (await mappingsForTvdb(tvdb)).filter((m) => m.type !== "MOVIE");
  const inSeason = all.filter((m) => m.season === season).sort((a, b) => a.offset - b.offset);
  const pick = [...inSeason].reverse().find((m) => m.offset < episode) ?? inSeason[0];
  if (pick) return { anilistId: pick.anilistId, episode: episode - pick.offset };
  // Абсолютная нумерация («a») — серия как есть
  const abs = all.find((m) => m.season === "a");
  return abs ? { anilistId: abs.anilistId, episode } : null;
}
