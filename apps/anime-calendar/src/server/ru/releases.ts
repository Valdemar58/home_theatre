import "server-only";
import { getDetails } from "../anilist";
import { mappingForAnilist, mappingsForTvdb, type TvdbMapping } from "../idmap";
import { db, now } from "../db";
import { releaseSubsTorrent, streamRelease, streamSeriesUrl } from "../stream";
import { releaseTag, syncStreamSubs } from "../stream-subs";
import { shikiInfo } from "../shikimori";
import { searchOrig, searchRu, sonarrEpisodes, sonarrGet, sonarrPost, sonarrPut, sonarrSeries, type ProwlarrRelease, type SonarrSeries } from "./arr";
import { anilistNames, baseName, resetIndex } from "./identify";
import { INDEXER_NAME } from "./importer";
import { normalizeName, parseRelease, type ParsedRelease } from "./parse";
import { parseScene, type SceneRelease } from "./parse-scene";
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
  /** ru — русские трекеры; orig — оригинал и другие языки (Nyaa, 1337x; IDEAS #88) */
  origin: "ru" | "orig";
  /** Группа релиза и языки субтитров (у оригинальных) */
  group: string | null;
  subs: string[];
};

export type RuReleasesResponse = {
  tvdbId: number | null;
  season: number | "a" | null;
  inSonarr: boolean;
  releases: RuRelease[];
  /** Оригинал и другие языки (в старых сохранённых результатах поля нет) */
  orig?: RuRelease[];
  /** Часть тем ещё догружается в фоне: при повторном открытии появятся студии */
  pending: number;
};

const ENRICH_BUDGET_MS = 15_000;

type Match = { parsed: ParsedRelease | SceneRelease; topic: TopicInfo | undefined; release: ProwlarrRelease; origin: "ru" | "orig" };

// Оригинальных раздач бывают сотни (каждая серия каждой группы) — показываем самые раздаваемые
const ORIG_LIMIT = 60;

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

  /** Раздача про этот тайтл: название совпало (и сезон не другой) или общее название сериала с нужным сезоном и частью */
  const accepts = (parsed: ParsedRelease): boolean => {
    // Сквозная нумерация без сезона («Slime - 96» — это 4-й сезон): серия дальше конца тайтла — не он
    if (parsed.episodes && details.episodes && mapping?.season !== "a" && parsed.episodes.to > details.episodes) return false;
    if (parsed.names.some((n) => own.has(normalizeName(n)))) {
      // Название совпало, но в раздаче явно указан другой сезон (0 — спецвыпуски — тоже другой)
      return !(parsed.season !== null && mapping && typeof mapping.season === "number" && parsed.season !== mapping.season);
    }
    if (parsed.names.some((n) => seriesBase.has(normalizeName(baseName(n)))) && mapping) {
      // Общее название сериала: выбираем запись AniList по сезону и части из раздачи
      const wanted = parsed.season ?? 1;
      const inSeason = siblings.filter((m) => m.season === wanted).sort((a, b) => a.offset - b.offset);
      const pick = inSeason[(parsed.part ?? 1) - 1] ?? inSeason[0];
      return pick?.anilistId === anilistId || (!siblings.length && wanted === (mapping.season === "a" ? 1 : mapping.season));
    }
    return false;
  };

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
    if (accepts(parsed)) matches.push({ parsed, topic, release: r, origin: "ru" });
  }
  prefetchTopics(background);

  // Оригинал и другие языки (Nyaa, 1337x): названия «как на Nyaa», тем нет; что уже нашлось среди русских — не дублируем
  const seen = new Set(matches.map((m) => m.release.guid));
  const orig = new Map<string, ProwlarrRelease>();
  // Nyaa отдаёт 75 самых свежих: у старого сезона франшизы, которая выходит сейчас, их все займут новые серии —
  // поэтому ещё пачки и BD (по ним старые сезоны и раздают) и номер сезона
  const base = normalizeName(baseName(latin[0] ?? ""));
  const sn = mapping && typeof mapping.season === "number" ? mapping.season : null;
  const origQueries = [...new Set([...queries, ...(base ? [`${base} batch`, `${base} bd`, ...(sn ? [`${base} s${String(sn).padStart(2, "0")}`, `${base} season ${sn}`] : [])] : [])])];
  for (const q of origQueries) {
    opts.signal?.throwIfAborted();
    for (const r of await searchOrig(q, details.format === "MOVIE").catch(() => [])) if (!seen.has(r.guid)) orig.set(r.guid, r);
  }
  const origMatches: Match[] = [];
  for (const r of orig.values()) {
    const parsed = parseScene(r.title);
    if (!parsed || (details.format === "MOVIE" ? parsed.kind !== "Movie" && (parsed.episodes?.to ?? 1) > 1 : parsed.kind === "Movie")) continue;
    // OVA и спецвыпуски — у сериала свои записи AniList
    if ((details.format === "TV" || details.format === "TV_SHORT") && (parsed.kind === "OVA" || parsed.kind === "Special")) continue;
    if (accepts(parsed)) origMatches.push({ parsed, topic: undefined, release: r, origin: "orig" });
  }
  matches.push(...origMatches.sort((a, b) => (b.release.seeders ?? 0) - (a.release.seeders ?? 0)).slice(0, ORIG_LIMIT));
  return { matches, pending: background.length, mapping };
}

export async function ruReleases(anilistId: number, opts: FindOpts = {}): Promise<RuReleasesResponse> {
  const { matches, pending, mapping } = await findReleases(anilistId, opts);
  const series = mapping ? (await sonarrSeries()).find((s) => s.tvdbId === mapping.tvdb) : undefined;
  const rules = loadProfiles().anime;
  const all = matches.map(({ parsed, topic, release: r, origin }): RuRelease => {
    const voices = [...new Set([...parsed.voices, ...(topic?.voices ?? [])])];
    const kinds = [...new Set([...parsed.audio.kinds, ...(topic?.kinds ?? [])])];
    // Оцениваем так же, как Sonarr увидит название от RU-индексатора (оригинальные — без баллов: правила про русские)
    const forScore = sonarrTitle("X", { kind: "season", season: 1, from: 1, to: 1, full: true }, { ...parsed, audio: { ...parsed.audio, kinds } }, voices);
    const { score, matched } = origin === "ru" ? scoreTitle(forScore, rules) : { score: 0, matched: [] };
    return {
      origin,
      group: "group" in parsed ? parsed.group : null,
      subs: "subs" in parsed ? parsed.subs : [],
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
  const releases = all.filter((r) => r.origin === "ru").sort((a, b) => b.score - a.score || b.seeders - a.seeders);
  // Оригинальные: сначала пачки серий (сезон целиком удобнее), потом качество и раздающие
  const span = (r: RuRelease) => (r.episodes ? r.episodes.to - r.episodes.from + 1 : 99);
  const res = (r: RuRelease) => Number(r.quality.match(/(\d{3,4})p/)?.[1] ?? 0);
  const orig = all.filter((r) => r.origin === "orig")
    .sort((a, b) => Number(span(b) > 1) - Number(span(a) > 1) || res(b) - res(a) || b.seeders - a.seeders);
  return { tvdbId: mapping?.tvdb ?? null, season: mapping?.season ?? null, inSonarr: Boolean(series), releases, orig, pending };
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
/**
 * Субтитры из раздачи без просмотра её видео: TorrServer → только субтитры и шрифты (stream-subs.ts), сопоставление
 * «серия тайтла → файл раздачи» — в release_subs; плеер покажет их у любой серии (библиотека или «Стрим»).
 */
export async function subsRuRelease(anilistId: number, guid: string): Promise<{ ok: boolean; message: string }> {
  const { match, mapping } = await pick(anilistId, guid);
  const series = (await sonarrSeries()).find((s) => s.tvdbId === mapping.tvdb);
  const r = await releaseSubsTorrent({ anilistId, release: match.release, ref: await refFor(match, mapping, series?.id), title: match.release.title });
  const m = await syncStreamSubs(r.hash);
  const eps = Object.entries(r.episodes).filter(([, video]) => m?.subs.some((s) => s.video === video)).length;
  if (!eps) return { ok: false, message: "В раздаче не нашлось субтитров к сериям этого тайтла" };
  db.prepare(`INSERT INTO release_subs (anilist_id, hash, title, episodes, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (anilist_id, hash) DO UPDATE SET episodes = excluded.episodes, created_at = excluded.created_at`)
    .run(anilistId, r.hash, match.release.title, JSON.stringify(r.episodes), now());
  const groups = [...new Set(m!.subs.map((s) => s.group ?? releaseTag(match.release.title) ?? "без подписи"))];
  return { ok: true, message: `Субтитры (${groups.join(", ")}) — у ${pluralRu(eps, "серии", "серий", "серий")}; выберите их в плеере во вкладке «Субтитры»` };
}

export async function streamRuRelease(anilistId: number, guid: string): Promise<{ ok: boolean; message: string; hash?: string }> {
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
    hash: result.hash,
    message: `Источник выбран: ${pluralRu(result.episodes, "серия", "серии", "серий")} для плеера` +
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
  // Русская раздача — названием, как его строит RU-индексатор; оригинальная — как есть (такие Sonarr разбирает сам)
  const title = match.origin === "ru" ? sonarrTitle(series.title, ref, { ...parsed, audio: { ...parsed.audio, kinds } }, topic?.voices ?? []) : r.title;
  const decisions = await sonarrPost<{ rejected?: boolean; rejections?: string[] }[] | { rejected?: boolean; rejections?: string[] }>(
    "/api/v3/release/push",
    { title, downloadUrl: r.downloadUrl ?? r.magnetUrl, protocol: "torrent", publishDate: r.publishDate, size: r.size, indexer: match.origin === "ru" ? INDEXER_NAME : r.indexer },
  );
  const d = Array.isArray(decisions) ? decisions[0] : decisions;
  if (d?.rejected) return { ok: false, message: `Sonarr отказался: ${(d.rejections ?? []).join("; ")}` };
  return { ok: true, message: "Раздача отправлена в загрузку" };
}
