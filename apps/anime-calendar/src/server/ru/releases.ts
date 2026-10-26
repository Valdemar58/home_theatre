import "server-only";
import { getDetails } from "../anilist";
import { mappingForAnilist, mappingsForTvdb, type TvdbMapping } from "../idmap";
import { streamRelease, streamSeriesUrl } from "../stream";
import { shikiInfo } from "../shikimori";
import { searchRu, sonarrEpisodes, sonarrGet, sonarrPost, sonarrPut, sonarrSeries, type ProwlarrRelease, type SonarrSeries } from "./arr";
import { anilistNames, baseName, resetIndex } from "./identify";
import { INDEXER_NAME } from "./importer";
import { normalizeName, parseRelease, type ParsedRelease } from "./parse";
import { loadProfiles, scoreTitle } from "./profiles";
import { qualityToken, sonarrTitle, type EpisodeRefLike } from "./title";
import { cachedTopic, prefetchTopics, topicInfo } from "./topic";
import type { TopicInfo } from "./topic-parse";

// Русские раздачи конкретного тайтла AniList — для ручного выбора озвучки в календаре.

export type RuRelease = {
  guid: string;
  title: string;
  infoUrl: string | null;
  size: number;
  seeders: number;
  publishDate: string;
  voices: string[];
  kinds: string[];
  rus: ParsedRelease["audio"]["rus"];
  langs: string[];
  quality: string;
  hdr: boolean;
  episodes: { from: number; to: number } | null;
  total: number | null;
  complete: boolean;
  /** Баллы по profiles.toml (как посчитает Sonarr) и сработавшие правила */
  score: number;
  matched: string[];
};

export type RuReleasesResponse = {
  tvdbId: number | null;
  season: number | "a" | null;
  inSonarr: boolean;
  releases: RuRelease[];
  /** Часть тем ещё догружается в фоне: при повторном открытии появятся студии */
  pending: number;
};

const ENRICH_BUDGET_MS = 15_000;

type Match = { parsed: ParsedRelease; topic: TopicInfo | undefined; release: ProwlarrRelease };

type FindOpts = { signal?: AbortSignal; budgetMs?: number };

async function findReleases(anilistId: number, opts: FindOpts = {}): Promise<{ matches: Match[]; pending: number; mapping: Awaited<ReturnType<typeof mappingForAnilist>> }> {
  const details = await getDetails(anilistId);
  const mapping = await mappingForAnilist(anilistId);
  const ru = details.idMal ? (await shikiInfo([details.idMal])).get(details.idMal)?.russian : null;
  const own = new Set(
    [details.title.romaji, details.title.english, ...details.synonyms, ru].filter((n): n is string => Boolean(n)).map(normalizeName));

  // Соседние сезоны того же сериала: чтобы отличить «Slime 3» от «Slime» по номеру сезона
  const siblings = mapping ? (await mappingsForTvdb(mapping.tvdb)).filter((m) => m.season !== 0 && m.type !== "MOVIE") : [];
  const seriesBase = new Set<string>([...own].map((n) => normalizeName(baseName(n))));
  if (mapping && siblings.length) {
    for (const s of await anilistNames(mapping.tvdb, siblings.map((m) => m.anilistId)).catch(() => [])) {
      for (const n of s.names) seriesBase.add(normalizeName(baseName(n)));
    }
  }

  const latin = [details.title.romaji, details.title.english].filter((n): n is string => Boolean(n));
  const queries = [...new Set([...latin.map(normalizeName), ...latin.map((n) => normalizeName(baseName(n)))])].slice(0, 3);
  const releases = new Map<string, ProwlarrRelease>();
  for (const q of queries) {
    opts.signal?.throwIfAborted();
    for (const r of await searchRu(q)) releases.set(r.guid, r);
  }

  // В фоне (задача «Озвучки») можно дочитать темы подольше — студии будут сразу
  const deadline = Date.now() + (opts.budgetMs ?? ENRICH_BUDGET_MS);
  const background: string[] = [];
  const matches: Match[] = [];
  for (const r of [...releases.values()].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))) {
    const url = r.infoUrl ?? r.guid;
    let topic = /rutracker\.org\/forum\/viewtopic/.test(url) ? cachedTopic(url) : undefined;
    const parsedShort = parseRelease(r.title);
    // Темы читаем только у раздач, похожих на наш тайтл (или у обрезанных названий)
    const looksRelevant = !parsedShort || parsedShort.names.some((n) => seriesBase.has(normalizeName(baseName(n))));
    if (!topic && looksRelevant && /rutracker\.org\/forum\/viewtopic/.test(url)) {
      opts.signal?.throwIfAborted();
      if (Date.now() < deadline) topic = await topicInfo(url).catch(() => undefined);
      else background.push(url);
    }
    const parsed = parseRelease(topic?.title ?? r.title) ?? parsedShort;
    if (!parsed) continue;
    if (details.format === "MOVIE" ? parsed.kind !== "Movie" : parsed.kind === "Movie") continue;

    const exact = parsed.names.some((n) => own.has(normalizeName(n)));
    let accepted = false;
    if (exact) {
      // Название совпало, но в раздаче явно указан другой сезон
      accepted = !(parsed.season && mapping && typeof mapping.season === "number" && parsed.season !== mapping.season);
    } else if (parsed.names.some((n) => seriesBase.has(normalizeName(baseName(n)))) && mapping) {
      // Общее название сериала: выбираем запись AniList по сезону и части из раздачи
      const wanted = parsed.season ?? 1;
      const inSeason = siblings.filter((m) => m.season === wanted).sort((a, b) => a.offset - b.offset);
      const pick = inSeason[(parsed.part ?? 1) - 1] ?? inSeason[0];
      accepted = pick?.anilistId === anilistId || (!siblings.length && wanted === (mapping.season === "a" ? 1 : mapping.season));
    }
    if (accepted) matches.push({ parsed, topic, release: r });
  }
  prefetchTopics(background);
  return { matches, pending: background.length, mapping };
}

export async function ruReleases(anilistId: number, opts: FindOpts = {}): Promise<RuReleasesResponse> {
  const { matches, pending, mapping } = await findReleases(anilistId, opts);
  const series = mapping ? (await sonarrSeries()).find((s) => s.tvdbId === mapping.tvdb) : undefined;
  const rules = loadProfiles().anime;
  const releases = matches.map(({ parsed, topic, release: r }): RuRelease => {
    const voices = [...new Set([...parsed.voices, ...(topic?.voices ?? [])])];
    const kinds = [...new Set([...parsed.audio.kinds, ...(topic?.kinds ?? [])])];
    // Оцениваем так же, как Sonarr увидит название от RU-индексатора
    const forScore = sonarrTitle("X", { kind: "season", season: 1, from: 1, to: 1, full: true }, { ...parsed, audio: { ...parsed.audio, kinds } }, voices);
    const { score, matched } = scoreTitle(forScore, rules);
    return {
      guid: r.guid,
      title: topic?.title ?? r.title,
      infoUrl: r.infoUrl ?? null,
      size: r.size,
      seeders: r.seeders ?? 0,
      publishDate: r.publishDate,
      voices,
      kinds,
      rus: parsed.audio.rus,
      langs: parsed.audio.langs,
      quality: qualityToken(parsed),
      hdr: parsed.hdr,
      episodes: parsed.episodes,
      total: parsed.total,
      complete: parsed.complete,
      score,
      matched,
    };
  });
  releases.sort((a, b) => b.score - a.score || b.seeders - a.seeders);
  return { tvdbId: mapping?.tvdb ?? null, season: mapping?.season ?? null, inSonarr: Boolean(series), releases, pending };
}

// ---------------------------------------------------------------- отправка в Sonarr

type SonarrSeriesFull = SonarrSeries & { seasons: { seasonNumber: number; monitored: boolean }[]; [k: string]: unknown };

/** Найти сериал в Sonarr или добавить его (без автопоиска: качаем только выбранную раздачу). */
async function ensureSeries(tvdbId: number): Promise<SonarrSeriesFull> {
  const existing = (await sonarrGet<SonarrSeriesFull[]>("/api/v3/series")).find((s) => s.tvdbId === tvdbId);
  if (existing) return existing;
  const [lookup] = await sonarrGet<SonarrSeriesFull[]>(`/api/v3/series/lookup?term=tvdb:${tvdbId}`);
  if (!lookup) throw new Error(`Sonarr не нашёл сериал tvdb:${tvdbId}`);
  const profiles = await sonarrGet<{ id: number; name: string }[]>("/api/v3/qualityprofile");
  const tags = await sonarrGet<{ id: number; label: string }[]>("/api/v3/tag");
  const profile = profiles.find((p) => p.name === "Anime RU") ?? profiles[0];
  const anime = tags.find((t) => t.label === "anime");
  const added = await sonarrPost<SonarrSeriesFull>("/api/v3/series", {
    ...lookup,
    qualityProfileId: profile.id,
    rootFolderPath: "/data/media/anime",
    seriesType: "anime",
    seasonFolder: true,
    monitored: true,
    tags: anime ? [anime.id] : [],
    addOptions: { monitor: "none", searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false },
  });
  // Новый сериал должен сразу появиться в индексе RU-индексатора
  resetIndex();
  return added;
}

async function monitorEpisodes(seriesId: number, ref: EpisodeRefLike) {
  const episodes = await sonarrGet<{ id: number; seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber?: number }[]>(
    `/api/v3/episode?seriesId=${seriesId}`);
  const ids = episodes
    .filter((e) => ref.kind === "absolute"
      ? (e.absoluteEpisodeNumber ?? 0) >= ref.from && (e.absoluteEpisodeNumber ?? 0) <= ref.to
      : e.seasonNumber === ref.season && (ref.full || (e.episodeNumber >= ref.from && e.episodeNumber <= ref.to)))
    .map((e) => e.id);
  if (ids.length) await sonarrPut("/api/v3/episode/monitor", { episodeIds: ids, monitored: true });
}

/** Серии раздачи в нумерации TVDB (seriesId — чтобы понять, весь ли это сезон). */
async function refFor(match: Match, mapping: TvdbMapping, seriesId?: number): Promise<EpisodeRefLike> {
  const { parsed } = match;
  const from = (parsed.episodes?.from ?? 1) + mapping.offset;
  const to = (parsed.episodes?.to ?? parsed.total ?? 1) + mapping.offset;
  if (mapping.season === "a") return { kind: "absolute", from, to };
  const seasonCount = seriesId
    ? (await sonarrEpisodes(seriesId).catch(() => [])).filter((e) => e.seasonNumber === mapping.season).length
    : 0;
  return { kind: "season", season: mapping.season, from, to, full: from <= 1 && seasonCount > 0 && to >= seasonCount };
}

async function pick(anilistId: number, guid: string) {
  const { matches, mapping } = await findReleases(anilistId);
  const match = matches.find((m) => m.release.guid === guid);
  if (!match) throw new Error("Раздача не найдена, обнови список");
  if (!mapping) throw new Error("Тайтл не сопоставлен с TVDB");
  return { match, mapping };
}

const pluralRu = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
};

/** «Смотреть сейчас»: раздача в TorrServer, серии — в библиотеку Jellyfin «Стрим». */
export async function streamRuRelease(anilistId: number, guid: string): Promise<{ ok: boolean; message: string }> {
  const { match, mapping } = await pick(anilistId, guid);
  const details = await getDetails(anilistId);
  const series = (await sonarrSeries()).find((s) => s.tvdbId === mapping.tvdb);
  const result = await streamRelease({
    anilistId,
    release: match.release,
    ref: await refFor(match, mapping, series?.id),
    seriesTitle: series?.title ?? details.title.english ?? details.title.romaji ?? `tvdb ${mapping.tvdb}`,
    year: series?.year ?? details.startDate.year,
    poster: details.coverImage.large,
  });
  if (!result.episodes) return { ok: false, message: "Не удалось сопоставить файлы раздачи с сериями" };
  return {
    ok: true,
    message: `Готово: ${pluralRu(result.episodes, "серия", "серии", "серий")} в Jellyfin → «Стрим»` +
      (result.skipped ? ` (пропущено файлов: ${result.skipped})` : "") +
      ". Первая минута может грузиться дольше, пока торрент набирает скорость.",
  };
}

export async function streamUrl(anilistId: number): Promise<string | null> {
  const mapping = await mappingForAnilist(anilistId);
  return mapping ? streamSeriesUrl(mapping.tvdb) : null;
}

export async function grabRuRelease(anilistId: number, guid: string): Promise<{ ok: boolean; message: string }> {
  let picked;
  try {
    picked = await pick(anilistId, guid);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const { match, mapping } = picked;
  const series = await ensureSeries(mapping.tvdb);
  const { parsed, topic, release: r } = match;
  const ref = await refFor(match, mapping, series.id);
  await monitorEpisodes(series.id, ref);

  const kinds = [...new Set([...parsed.audio.kinds, ...(topic?.kinds ?? [])])];
  const title = sonarrTitle(series.title, ref, { ...parsed, audio: { ...parsed.audio, kinds } }, topic?.voices ?? []);
  const decisions = await sonarrPost<{ rejected?: boolean; rejections?: string[] }[] | { rejected?: boolean; rejections?: string[] }>(
    "/api/v3/release/push",
    { title, downloadUrl: r.downloadUrl ?? r.magnetUrl, protocol: "torrent", publishDate: r.publishDate, size: r.size, indexer: INDEXER_NAME },
  );
  const d = Array.isArray(decisions) ? decisions[0] : decisions;
  if (d?.rejected) return { ok: false, message: `Sonarr отказался: ${(d.rejections ?? []).join("; ")}` };
  return { ok: true, message: "Раздача отправлена в загрузку" };
}
