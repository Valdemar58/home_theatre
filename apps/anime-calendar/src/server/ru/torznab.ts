import "server-only";
import { cached } from "../cache";
import { mappingsForTvdb } from "../idmap";
import { searchRu, seriesByTvdb, type ProwlarrRelease, type SonarrSeries } from "./arr";
import { baseName, getIndex, identify, mapEpisodes } from "./identify";
import { normalizeName, parseRelease } from "./parse";
import { sonarrTitle } from "./title";
import { cachedTopic, prefetchTopics, topicInfo } from "./topic";
import type { TopicInfo } from "./topic-parse";

// Torznab-индексатор для Sonarr: ищет на RU-трекерах через Prowlarr и отдаёт раздачи
// с названиями, которые Sonarr умеет разбирать.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function capsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="RU трекеры (anime-calendar)" />
  <limits max="100" default="100" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep,tvdbid" />
    <movie-search available="no" supportedParams="q" />
  </searching>
  <categories>
    <category id="5000" name="TV">
      <subcat id="5070" name="TV/Anime" />
    </category>
  </categories>
</caps>`;
}

/** Сколько времени поиск может потратить на загрузку тем (озвучки, полные названия) */
const ENRICH_BUDGET_MS = 20_000;

export type TorznabItem = { title: string; release: ProwlarrRelease; tvdbId: number; anime: boolean };

function itemXml({ title, release: r, tvdbId, anime }: TorznabItem): string {
  const link = r.downloadUrl ?? r.magnetUrl ?? "";
  const category = anime ? 5070 : 5000;
  return `    <item>
      <title>${esc(title)}</title>
      <guid isPermaLink="false">${esc(r.guid)}</guid>
      <link>${esc(link)}</link>
      <comments>${esc(r.infoUrl ?? r.guid)}</comments>
      <pubDate>${new Date(r.publishDate).toUTCString()}</pubDate>
      <size>${r.size}</size>
      <description>${esc(r.title)}</description>
      <enclosure url="${esc(link)}" length="${r.size}" type="application/x-bittorrent" />
      <torznab:attr name="category" value="${category}" />
      <torznab:attr name="seeders" value="${r.seeders ?? 0}" />
      <torznab:attr name="peers" value="${(r.seeders ?? 0) + (r.leechers ?? 0)}" />
      <torznab:attr name="grabs" value="${r.grabs ?? 0}" />
      <torznab:attr name="tvdbid" value="${tvdbId}" />
      <torznab:attr name="downloadvolumefactor" value="1" />
      <torznab:attr name="uploadvolumefactor" value="1" />
    </item>`;
}

export function rssXml(items: TorznabItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>RU трекеры (anime-calendar)</title>
${items.map(itemXml).join("\n")}
  </channel>
</rss>`;
}

/** Серия из текстового запроса Sonarr: «Tensei Shitara Slime Datta Ken 49», «Title S03E01» */
async function seriesFromQuery(q: string): Promise<SonarrSeries | undefined> {
  let name = q.trim();
  for (let i = 0; i < 3; i++) name = name.replace(/\s+(S\d+(E\d+)?|E?\d{1,4}|\(\d{4}\))$/i, "").trim();
  const { exact, base } = await getIndex();
  return (exact.get(normalizeName(name)) ?? base.get(normalizeName(baseName(name))))?.[0]?.series;
}

/** Запросы к трекеру для сериала: название нужного сезона на romaji и короткое общее название. */
async function queriesFor(series: SonarrSeries, season?: number): Promise<string[]> {
  const queries: string[] = [];
  const { seasonNames } = await getIndex();
  const names = seasonNames.get(series.id);
  if (names) {
    const mappings = (await mappingsForTvdb(series.tvdbId))
      .filter((m) => m.season !== 0 && (season === undefined || m.season === season));
    // romaji нужного сезона (первое название AniList): «Tensei shitara Slime Datta Ken 3rd Season»
    for (const m of mappings) {
      const romaji = names.get(m.anilistId)?.[0];
      if (romaji) queries.push(normalizeName(romaji));
    }
    // и общее название без пометок сезона — находит раздачи, где сезон указан иначе
    const first = names.values().next().value?.[0];
    if (first) queries.push(normalizeName(baseName(first)));
  }
  queries.push(normalizeName(baseName(series.title)));
  // Без кириллицы и дублей; RuTracker ищет по словам, короткий запрос находит больше
  return [...new Set(queries.filter((q) => q && !/[а-яё]/i.test(q)))].slice(0, 3);
}

export type SearchParams = { t: string; q?: string; tvdbid?: number; season?: number; ep?: number };

export async function search(params: SearchParams): Promise<TorznabItem[]> {
  let target: SonarrSeries | undefined;
  if (params.tvdbid) target = await seriesByTvdb(params.tvdbid);
  else if (params.q) target = await seriesFromQuery(params.q);
  // Неизвестный Sonarr сериал по tvdbid — искать нечего
  if (params.tvdbid && !target) return [];

  const queries = target ? await queriesFor(target, params.season) : [params.q?.trim() ?? ""];
  const releases = new Map<string, ProwlarrRelease>();
  for (const q of queries) {
    for (const r of await searchRu(q)) releases.set(r.guid, r);
  }

  const items: TorznabItem[] = [];
  const unmatched: TorznabItem[] = [];
  // Темы RuTracker догружаем синхронно в пределах бюджета, остальное — в фоне.
  // Популярные раздачи первыми: их Sonarr скорее всего и выберет
  const deadline = Date.now() + ENRICH_BUDGET_MS;
  const background: string[] = [];
  const sorted = [...releases.values()].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  for (const r of sorted) {
    const topicUrl = r.infoUrl ?? r.guid;
    // Без конкретного сериала (RSS) темы читаем только у раздач, которые уже опознаны
    const wantTopic = Boolean(target) && /rutracker\.org\/forum\/viewtopic/.test(topicUrl);
    let topic: TopicInfo | undefined = wantTopic ? cachedTopic(topicUrl) : undefined;
    if (wantTopic && !topic) {
      if (Date.now() < deadline) topic = await topicInfo(topicUrl).catch(() => undefined);
      else background.push(topicUrl);
    }
    // Полное название со страницы темы точнее: Prowlarr иногда обрезает его
    const parsed = parseRelease(topic?.title ?? r.title) ?? parseRelease(r.title);
    if (!parsed) continue;
    const id = await identify(parsed, target?.tvdbId);
    if (!id) {
      if (unmatched.length < 20) unmatched.push({ title: r.title, release: r, tvdbId: 0, anime: r.categories.some((c) => c.id === 5070) });
      continue;
    }
    const ref = await mapEpisodes(id, parsed);
    if (!ref) continue;
    if (params.season !== undefined && ref.kind === "season" && ref.season !== params.season) continue;
    if (topic?.kinds.length) parsed.audio.kinds = [...new Set([...parsed.audio.kinds, ...topic.kinds])];
    items.push({
      title: sonarrTitle(id.series.title, ref, parsed, topic?.voices ?? []),
      release: r,
      tvdbId: id.series.tvdbId,
      anime: id.series.seriesType === "anime",
    });
  }
  prefetchTopics(background);
  // RSS без совпадений с библиотекой: отдаём свежие раздачи как есть. Sonarr их проигнорирует,
  // но проверка индексатора при сохранении требует непустой ответ
  const rss = !params.q && !params.tvdbid;
  return rss && !items.length ? unmatched : items;
}

/** Поиск с кэшем: Sonarr часто повторяет одинаковые запросы (по сезону и по каждой серии). */
export function cachedSearch(params: SearchParams): Promise<TorznabItem[]> {
  const key = `ru:torznab:${params.t}:${params.tvdbid ?? ""}:${params.season ?? ""}:${(params.q ?? "").toLowerCase()}`;
  // Пустой ответ кэшируем ненадолго: трекер мог быть недоступен
  return cached(key, (items: TorznabItem[]) => (items.length ? 10 * 60 : 60), () => search(params));
}
