import "server-only";
import { LIST_STATUSES, type ListEntryWithMedia, type ListStatus, type MediaLite } from "@/lib/types";
import { mediaByIds } from "./anilist";
import { db, now, stmt } from "./db";
import { freshFor } from "@/lib/freshness";
import { getCached } from "./cache";
import { shikiInfo } from "./shikimori";
import { sourceDown } from "./sources";
import { applyProgress, type EntryState } from "@/lib/entry-rules";

export type EntryRow = {
  user_id: number;
  anilist_id: number;
  mal_id: number | null;
  status: ListStatus;
  waiting: number;
  episodes: number;
  score: number;
  updated_at: number;
  shiki_rate_id: number | null;
  shiki_updated_at: number | null;
  dirty: number;
  deleted: number;
  note: string | null;
  tags: string;
  voice: string | null;
  recommend: number | null;
  aired_mark: number | null;
  private: number;
};

export const parseTags = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

/** Русские названия и оценки MAL из Shikimori. */
export async function withShikimori<T extends MediaLite>(list: T[]): Promise<T[]> {
  // Русское название и оценку вышедшего давно тайтла проверяем раз в 90 дней, онгоинга — раз в сутки
  const ttl = new Map(list.filter((m) => m.idMal).map((m) => [m.idMal!, freshFor(m)]));
  const info = await shikiInfo([...ttl.keys()], (id) => ttl.get(id) ?? 3 * 86400);
  for (const m of list) {
    const i = m.idMal ? info.get(m.idMal) : undefined;
    m.title.ru = i?.russian ?? m.title.ru;
    m.malScore = i?.score ?? m.malScore ?? null;
  }
  return list;
}

const putMedia = stmt(
  "INSERT INTO media (anilist_id, json, updated_at) VALUES (?, ?, ?) " +
  "ON CONFLICT(anilist_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at");

export function saveMedia(list: MediaLite[]): void {
  const ts = now();
  db.transaction(() => list.forEach((m) => putMedia().run(m.id, JSON.stringify(m), ts)))();
}

export function getMedia(anilistId: number): MediaLite | null {
  const row = db.prepare<[number], { json: string }>("SELECT json FROM media WHERE anilist_id = ?").get(anilistId);
  return row ? (JSON.parse(row.json) as MediaLite) : null;
}

/** Карточка из сохранённой страницы тайтла: без описания, тегов, расписания и связей. */
function pickLite(d: MediaLite): MediaLite {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { coverXL, description, synonyms, trailer, tags, schedule, relations, ...m } = d as MediaLite & Record<string, unknown>;
  return m;
}

/** Снимок тайтла из базы или AniList (нужен MAL ID для Shikimori и данные для страницы списков). */
export async function ensureMedia(anilistId: number): Promise<MediaLite> {
  const existing = getMedia(anilistId);
  if (existing) return existing;
  // AniList лежит — снимок из сохранённой страницы тайтла (без даты финала, дополнится при обновлении)
  if (sourceDown("anilist")) {
    const d = getCached<MediaLite>(`media:v2:${anilistId}`, true);
    if (d) { const m = pickLite(d); saveMedia([m]); return m; }
  }
  const [m] = await withShikimori(await mediaByIds([anilistId]));
  if (!m) throw new Error(`Тайтл ${anilistId} не найден в AniList`);
  saveMedia([m]);
  return m;
}

export function getRows(userId: number, includeDeleted = false): EntryRow[] {
  return db
    .prepare<[number], EntryRow>(
      `SELECT * FROM list_entries WHERE user_id = ? ${includeDeleted ? "" : "AND deleted = 0"}`)
    .all(userId);
}

export function getRow(userId: number, anilistId: number): EntryRow | undefined {
  return db.prepare<[number, number], EntryRow>(
    "SELECT * FROM list_entries WHERE user_id = ? AND anilist_id = ?").get(userId, anilistId);
}

export function listWithMedia(userId: number): ListEntryWithMedia[] {
  const rows = db
    .prepare<[number], EntryRow & { json: string | null }>(
      `SELECT e.*, m.json FROM list_entries e LEFT JOIN media m ON m.anilist_id = e.anilist_id
       WHERE e.user_id = ? AND e.deleted = 0 ORDER BY e.updated_at DESC`)
    .all(userId);
  return rows.map((r) => ({
    anilistId: r.anilist_id,
    malId: r.mal_id,
    status: r.status,
    waiting: Boolean(r.waiting),
    episodes: r.episodes,
    score: r.score,
    updatedAt: r.updated_at,
    note: r.note,
    tags: parseTags(r.tags),
    voice: r.voice,
    recommend: r.recommend === null ? null : Boolean(r.recommend),
    airedMark: r.aired_mark,
    private: Boolean(r.private),
    media: r.json ? (JSON.parse(r.json) as MediaLite) : null,
  }));
}

export type EntryPatch = Partial<{
  status: ListStatus; waiting: boolean; episodes: number; score: number;
  note: string | null; tags: string[]; voice: string | null; recommend: boolean | null; private: boolean;
}>;

export function validatePatch(body: unknown): EntryPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: EntryPatch = {};
  if (b.status !== undefined) {
    if (!LIST_STATUSES.includes(b.status as ListStatus)) throw new Error("Неизвестный статус");
    patch.status = b.status as ListStatus;
  }
  if (b.waiting !== undefined) patch.waiting = Boolean(b.waiting);
  if (b.episodes !== undefined) patch.episodes = Math.max(0, Math.floor(Number(b.episodes) || 0));
  if (b.score !== undefined) patch.score = Math.min(10, Math.max(0, Math.floor(Number(b.score) || 0)));
  if (b.note !== undefined) patch.note = b.note ? String(b.note).slice(0, 2000) : null;
  if (b.voice !== undefined) patch.voice = b.voice ? String(b.voice).slice(0, 60) : null;
  if (b.private !== undefined) patch.private = Boolean(b.private);
  if (b.recommend !== undefined) patch.recommend = b.recommend === null ? null : Boolean(b.recommend);
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) throw new Error("tags должен быть списком");
    patch.tags = [...new Set(b.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  }
  return patch;
}

export function upsertEntry(userId: number, media: MediaLite, patch: EntryPatch): void {
  const row = getRow(userId, media.id);
  const prev: EntryState | null = row && !row.deleted
    ? { status: row.status, waiting: Boolean(row.waiting), episodes: row.episodes, airedMark: row.aired_mark }
    : null;
  // Статус по отметке серий и честные «новые серии» — lib/entry-rules.ts
  const { status, waiting, episodes, airedMark } = applyProgress(prev, patch, media);
  const score = patch.score ?? (row && !row.deleted ? row.score : 0);
  const live = row && !row.deleted;
  const note = patch.note !== undefined ? patch.note : live ? row.note : null;
  const tags = patch.tags ?? (live ? parseTags(row.tags) : []);
  const voice = patch.voice !== undefined ? patch.voice : live ? row.voice : null;
  const recommend = patch.recommend !== undefined ? patch.recommend : live && row.recommend !== null ? Boolean(row.recommend) : null;
  const hidden = patch.private ?? (live ? Boolean(row.private) : false);
  // Впечатления — локальные: их изменение не требует синхронизации с Shikimori
  const onlyLocal = Object.keys(patch).every((k) => ["note", "tags", "voice", "recommend", "private"].includes(k));

  db.prepare(
    `INSERT INTO list_entries (user_id, anilist_id, mal_id, status, waiting, episodes, score, updated_at, dirty, deleted, note, tags, voice, recommend, aired_mark, private)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, anilist_id) DO UPDATE SET mal_id = excluded.mal_id, status = excluded.status,
       waiting = excluded.waiting, episodes = excluded.episodes, score = excluded.score,
       updated_at = CASE WHEN ? THEN list_entries.updated_at ELSE excluded.updated_at END,
       dirty = CASE WHEN ? THEN list_entries.dirty ELSE 1 END, deleted = 0,
       note = excluded.note, tags = excluded.tags, voice = excluded.voice, recommend = excluded.recommend,
       aired_mark = excluded.aired_mark, private = excluded.private`,
  ).run(userId, media.id, media.idMal, status, waiting ? 1 : 0, episodes, score, now(), onlyLocal && live ? 0 : 1,
    note, JSON.stringify(tags), voice, recommend === null ? null : recommend ? 1 : 0, airedMark, hidden ? 1 : 0, onlyLocal && live ? 1 : 0, onlyLocal && live ? 1 : 0);
  if (!(onlyLocal && live)) pushSoon(userId, media.id);
}

/** На Shikimori — через несколько секунд после правки (sync.ts; импорт отложенный: sync.ts сам зависит от lists.ts). */
export const pushSoon = (userId: number, anilistId: number) =>
  void import("./sync").then((m) => m.schedulePush(userId, anilistId)).catch(() => undefined);

/** Журнал просмотра: прогресс вырос с from до to серий (для кривой активности в профиле). */
export function logWatch(userId: number, media: MediaLite, from: number, to: number): void {
  const episodes = to - from;
  if (episodes <= 0) return;
  db.prepare("INSERT INTO watch_log (user_id, anilist_id, episodes, minutes, at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, media.id, episodes, episodes * (media.duration ?? 24), now());
}

export function deleteEntry(userId: number, anilistId: number): void {
  const row = getRow(userId, anilistId);
  if (!row) return;
  if (row.shiki_rate_id) {
    // Удалим в Shikimori через несколько секунд (не вышло — при синхронизации)
    db.prepare("UPDATE list_entries SET deleted = 1, dirty = 1, updated_at = ? WHERE user_id = ? AND anilist_id = ?")
      .run(now(), userId, anilistId);
    pushSoon(userId, anilistId);
  } else {
    db.prepare("DELETE FROM list_entries WHERE user_id = ? AND anilist_id = ?").run(userId, anilistId);
  }
}

/** Обновить снимки тайтлов из списков (счётчик серий, следующая серия...). */
export async function refreshListMedia(): Promise<void> {
  if (sourceDown("anilist")) return;
  // Срок снимка — по живости тайтла: онгоинг — 6 ч (серии), вышедший давно — 90 дней
  const t = now();
  const stale = db
    .prepare<[], { anilist_id: number; json: string | null; updated_at: number | null }>(
      `SELECT DISTINCT e.anilist_id, m.json, m.updated_at FROM list_entries e LEFT JOIN media m ON m.anilist_id = e.anilist_id
       WHERE e.deleted = 0`)
    .all()
    .filter((r) => {
      if (!r.json || r.updated_at === null || !r.json.includes('"finaleAt"') || !r.json.includes('"malScore"')) return true;
      return r.updated_at + freshFor(JSON.parse(r.json) as MediaLite, "airing", t) < t;
    })
    .map((r) => r.anilist_id);
  if (!stale.length) return;
  saveMedia(await withShikimori(await mediaByIds(stale)));
}
