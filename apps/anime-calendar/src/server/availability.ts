import "server-only";
import { airedNow } from "@/lib/episode-notice";
import { episodeStates, type BufferInfo, type EpisodeStatus, type QueueInfo, type TorrentCache } from "@/lib/playback";
import { getDetails } from "./anilist";
import { now } from "./db";
import { env } from "./env";
import { mappingForAnilist } from "./idmap";
import { episodeItems } from "./playback";
import { prebufferProgress } from "./prebuffer";
import { isPrepared } from "./prep";
import { seriesByTvdb, sonarrGet } from "./ru/arr";
import { torrentCaches, torrentFilesCached } from "./stream";

// Готовность серий тайтла: что можно смотреть сейчас (библиотека, «Стрим» с буфером), что качается (Sonarr),
// что вышло, но взять неоткуда. Для значков у серий, кнопки «Смотреть» и уведомления «можно смотреть».

type QueueRecord = {
  episode?: { seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber?: number };
  size?: number;
  sizeleft?: number;
  timeleft?: string;
};

const queueMemo = new Map<number, { at: number; recs: QueueRecord[] }>();

/** Очередь загрузок Sonarr по сериалу (кэш 30 с). */
async function sonarrQueue(seriesId: number): Promise<QueueRecord[]> {
  const hit = queueMemo.get(seriesId);
  if (hit && Date.now() - hit.at < 30_000) return hit.recs;
  const r = await sonarrGet<{ records: QueueRecord[] }>(`/api/v3/queue?seriesIds=${seriesId}&includeEpisode=true&pageSize=200`);
  queueMemo.set(seriesId, { at: Date.now(), recs: r.records });
  return r.records;
}

/** «01:02:03» / «1.02:03:04» → секунды. */
const parseSpan = (s?: string) => {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(s ?? "");
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) : null;
};

async function queueOf(anilistId: number): Promise<Map<number, QueueInfo>> {
  const out = new Map<number, QueueInfo>();
  const m = env.sonarrApiKey ? await mappingForAnilist(anilistId) : null;
  const s = m ? await seriesByTvdb(m.tvdb).catch(() => undefined) : undefined;
  if (!m || !s) return out;
  for (const r of await sonarrQueue(s.id).catch(() => [])) {
    const e = r.episode;
    if (!e) continue;
    const ep = m.season === "a" ? (e.absoluteEpisodeNumber ?? 0) - m.offset : e.seasonNumber === m.season ? e.episodeNumber - m.offset : 0;
    if (ep < 1) continue;
    out.set(ep, { pct: r.size ? Math.max(0, 1 - (r.sizeleft ?? r.size) / r.size) : 0, etaSec: parseSpan(r.timeleft) });
  }
  return out;
}

/** Готовность всех серий тайтла и кэш его раздач TorrServer. */
export async function episodeStatus(anilistId: number): Promise<{ episodes: EpisodeStatus[]; aired: number | null; caches: TorrentCache[] }> {
  const d = await getDetails(anilistId);
  const [items, queue] = await Promise.all([episodeItems(anilistId).catch(() => new Map()), queueOf(anilistId)]);
  const buffers = new Map<string, BufferInfo>(prebufferProgress().map((p) => [p.key, { ready: p.ready, etaSec: p.etaSec, read: p.read, size: p.size, done: p.done }]));
  const aired = airedNow(d, now());
  // Число серий известно — дальше по сезону TVDB идёт уже следующая часть
  const total = d.episodes ?? Math.max(d.schedule.at(-1)?.episode ?? 0, aired ?? 0, ...items.keys(), ...queue.keys());
  const episodes = episodeStates({ total, aired, items, buffers, queue });
  // «Стрим»: сколько серии в кэше TorrServer — правда о готовности (подготовленное могло вытесниться)
  const hashes = [...new Set(episodes.flatMap((e) => (e.hash ? [e.hash] : [])))];
  const caches: TorrentCache[] = [];
  if (hashes.length) {
    const all = await torrentCaches().catch(() => []);
    for (const h of hashes) {
      // Спящая раздача (не будим): кэш пуст — у серий 0
      const t = all.find((x) => x.hash === h);
      const c = t?.active ? await torrentFilesCached(h).catch(() => null) : null;
      if (!c) {
        for (const e of episodes) if (e.hash === h) { e.cached = 0; if (!e.preparing) e.ready = false; }
        continue;
      }
      caches.push({ hash: h, title: t?.title ?? "", filled: c.filled, capacity: c.capacity, active: t?.active ?? false });
      for (const e of episodes) {
        if (e.hash !== h || !e.index) continue;
        e.cached = c.files.get(e.index) ?? 0;
        // Целиком в кэше — смотреть без остановок; пока готовится — по скорости (prebuffer)
        if (!e.preparing) e.ready = e.cached >= 0.97;
      }
    }
  }
  // Скачанные серии (prep.ts) — готовы целиком, с диска
  for (const e of episodes) {
    if (e.hash && e.index && isPrepared(e.hash, e.index)) Object.assign(e, { cached: 1, ready: true, downloaded: true });
  }
  return { episodes, aired, caches };
}
