import "server-only";
import type {
  LibAction, LibField, LibPlan, LibPlanItem, LibProgress, LibStatus, LibValues, ListStatus,
} from "@/lib/types";
import { gql, mediaByIds } from "./anilist";
import { db, now } from "./db";
import { env } from "./env";
import { expectOk, fetchWithRetry, HttpError, RateLimiter } from "./http";
import { getMedia, getRows, saveMedia, upsertEntry, withShikimori, type EntryPatch } from "./lists";
import type { User } from "./session";

// Синхронизация с AniLib (animelib.org) по публичным закладкам: папки → статусы, прогресс, оценки.
// Направление одно: AniLib → календарь (дальше календарь сам отправляет изменения в Shikimori).
// Правило: главнее календарь. По снимку прошлой синхронизации (lib_links) видно, кто что изменил:
// только AniLib — применяем, только календарь — не трогаем, оба — конфликт, остаётся как в календаре.

const limiter = new RateLimiter(350);
// Без браузерных Referer/Origin Lib-API отвечает 403; Site-Id 5 — AniLib
const headers = () => ({
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  "Site-Id": "5",
  Referer: `${env.anilibUrl}/`,
  Origin: env.anilibUrl,
  Accept: "application/json",
});

async function libGet<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${env.anilibApi}${path}`, { headers: headers() }, limiter, { timeoutMs: 20_000 });
  return (await (await expectOk(res, "AniLib")).json()) as T;
}

/** Ошибка AniLib → понятная пользователю. */
function explain(err: unknown): string {
  if (err instanceof HttpError && err.status === 403) {
    return "AniLib не пускает сервер (геоблок): нужен доступ мимо VPN";
  }
  if (err instanceof HttpError && err.status === 404) return "Профиль AniLib не найден";
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  if (cause) return `Нет связи с AniLib (${cause}): проверьте сеть и обход VPN`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- профиль и закладки

type LibMedia = {
  id: number; name: string; rus_name: string | null; eng_name: string | null; slug_url: string;
  anilist_id: number | null; cover?: { thumbnail?: string; default?: string };
};
type LibBookmark = {
  media_id: number; status: number; rating: number | null; updated_at: string;
  meta: { item_number?: number | null } | null; media: LibMedia;
};

/** ID профиля из ссылки (…/user/7392528?…) или числа. */
export function parseProfile(input: string): number | null {
  const m = input.trim().match(/(?:\/user\/)?(\d{1,12})(?:[/?#].*)?$/);
  return m ? Number(m[1]) : null;
}

export async function libProfile(libUserId: number): Promise<{ id: number; username: string }> {
  try {
    const d = await libGet<{ data: { id: number; username: string } }>(`/user/${libUserId}`);
    return { id: d.data.id, username: d.data.username };
  } catch (err) {
    throw new Error(explain(err));
  }
}

async function libLibrary(libUserId: number, onPage: (n: number) => void) {
  const folders = new Map(
    (await libGet<{ data: { id: number; name: string }[] }>(`/bookmarks/folder/${libUserId}`)).data.map((f) => [f.id, f.name]),
  );
  const items: LibBookmark[] = [];
  for (let page = 1; ; page++) {
    const d = await libGet<{ data: LibBookmark[]; meta: { next_page_url?: unknown } }>(
      `/bookmarks?user_id=${libUserId}&status=0&page=${page}`);
    items.push(...d.data);
    onPage(items.length);
    if (!d.meta?.next_page_url || !d.data.length) break;
  }
  return { folders, items: items.filter((b) => b.media) };
}

// Папки AniLib → статусы (по названию: id папок у каждого пользователя свои)
const FOLDERS: Record<string, ListStatus> = {
  "смотрю": "watching",
  "запланировано": "planned",
  "в планах": "planned",
  "просмотрено": "completed",
  "брошено": "dropped",
  "отложено": "on_hold",
  "пересматриваю": "rewatching",
};

// ---------------------------------------------------------------- сопоставление с AniList

type Link = {
  lib_media_id: number; anilist_id: number | null; how: string;
  snap_status: ListStatus | null; snap_episodes: number | null; snap_score: number | null; synced_at: number | null;
};

const getLinks = (userId: number) =>
  new Map(db.prepare<[number], Link>("SELECT * FROM lib_links WHERE user_id = ?").all(userId).map((l) => [l.lib_media_id, l]));

function saveLink(userId: number, libMediaId: number, anilistId: number | null, how: string) {
  db.prepare(
    `INSERT INTO lib_links (user_id, lib_media_id, anilist_id, how) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, lib_media_id) DO UPDATE SET anilist_id = excluded.anilist_id, how = excluded.how`,
  ).run(userId, libMediaId, anilistId, how);
}

const SEARCH = `query ($q: String) { Page(perPage: 1) { media(search: $q, type: ANIME) { id } } }`;

async function searchAnilist(...names: (string | null)[]): Promise<number | null> {
  for (const q of names) {
    if (!q) continue;
    const d = await gql<{ Page: { media: { id: number }[] } }>(SEARCH, { q });
    if (d.Page.media[0]) return d.Page.media[0].id;
  }
  return null;
}

/** Ручное сопоставление тайтла AniLib с AniList (ссылка anilist.co/anime/… или id). */
export async function mapManually(user: User, libMediaId: number, anilist: string): Promise<void> {
  const id = Number(anilist.trim().match(/(?:anime\/)?(\d+)/)?.[1]);
  if (!id) throw new Error("Укажите ссылку на тайтл AniList или его id");
  const [media] = await mediaByIds([id]);
  if (!media) throw new Error(`На AniList нет аниме с id ${id}`);
  saveLink(user.id, libMediaId, id, "manual");
}

// ---------------------------------------------------------------- план

const FIELDS: LibField[] = ["status", "episodes", "score"];

/** Что делать с закладкой: сравнение AniLib, календаря и снимка прошлой синхронизации. */
export function decide(lib: LibValues, local: LibValues | null, snap: LibValues | null):
  { action: LibAction; fields: LibField[]; conflicts: LibField[] } {
  if (!local) return { action: snap ? "removed" : "add", fields: [], conflicts: [] };
  const fields: LibField[] = [];
  const conflicts: LibField[] = [];
  for (const f of FIELDS) {
    const L = lib[f];
    const C = local[f];
    if (L === null || L === C) continue;
    // У просмотренного число серий проставляет календарь (все серии)
    if (f === "episodes" && (lib.status === "completed" || local.status === "completed")) continue;
    const S = snap?.[f];
    if (snap && S !== null && S !== undefined) {
      if (L === S) continue; // на AniLib не менялось — значит, менялось только в календаре
      (C === S ? fields : conflicts).push(f);
    } else {
      // Первая встреча: пустое в календаре заполняем, разное — конфликт (главнее календарь)
      const empty = (f === "score" || f === "episodes") && !C;
      (empty ? fields : conflicts).push(f);
    }
  }
  return { action: fields.length ? "update" : conflicts.length ? "conflict" : "same", fields, conflicts };
}

// ---------------------------------------------------------------- запуск

const progress = new Map<number, LibProgress>();

function setUser(userId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k]), userId);
}

async function run(user: User, apply: boolean, p: LibProgress): Promise<void> {
  const libUserId = user.lib_user_id!;
  const { folders, items } = await libLibrary(libUserId, (n) => Object.assign(p, { done: n, total: n }));

  // Сопоставление: id от AniLib → прошлое (ручное/поиск) → поиск по названию (только новые)
  const links = getLinks(user.id);
  const pending = items.filter((b) => !b.media.anilist_id && !links.has(b.media.id));
  Object.assign(p, { stage: "match", done: 0, total: pending.length });
  for (const b of pending) {
    const id = await searchAnilist(b.media.name, b.media.eng_name);
    saveLink(user.id, b.media.id, id, "search");
    p.done++;
  }
  const fresh = getLinks(user.id);

  const local = new Map(getRows(user.id).map((r) => [r.anilist_id, r]));
  const planItems: LibPlanItem[] = items.map((b) => {
    const link = fresh.get(b.media.id);
    const manual = link?.how === "manual" ? link.anilist_id : null;
    const anilistId = manual ?? b.media.anilist_id ?? link?.anilist_id ?? null;
    const how: LibPlanItem["how"] = manual ? "manual" : b.media.anilist_id ? "anilib" : anilistId ? "search" : null;
    const folder = folders.get(b.status) ?? `папка ${b.status}`;
    const status = FOLDERS[folder.trim().toLowerCase()] ?? null;
    const lib: LibValues = {
      status,
      episodes: status === "completed" ? null : (b.meta?.item_number ?? null),
      score: b.rating ? Math.round(b.rating) : null,
    };
    const row = anilistId ? local.get(anilistId) : undefined;
    const mine: LibValues | null = row ? { status: row.status, episodes: row.episodes, score: row.score } : null;
    const snap: LibValues | null = link?.synced_at
      ? { status: link.snap_status, episodes: link.snap_episodes, score: link.snap_score } : null;
    const base = {
      libMediaId: b.media.id, title: b.media.rus_name || b.media.name, original: b.media.name,
      cover: b.media.cover?.thumbnail ?? null, url: `${env.anilibUrl}/ru/anime/${b.media.slug_url}`,
      folder, anilistId, how, lib, local: mine,
    };
    if (!anilistId) return { ...base, action: "unmatched", fields: [], conflicts: [] };
    if (!status) return { ...base, action: "skipped", fields: [], conflicts: [] };
    return { ...base, ...decide(lib, mine, snap) };
  });
  const counts = Object.fromEntries(
    (["add", "update", "conflict", "same", "removed", "unmatched", "skipped"] as LibAction[])
      .map((a) => [a, planItems.filter((i) => i.action === a).length]),
  ) as Record<LibAction, number>;
  p.plan = { items: planItems, counts };
  if (!apply) return;

  // Запись: недостающие тайтлы — пачками по 50 (а не по запросу на тайтл)
  const todo = planItems.filter((i) => i.action === "add" || i.action === "update");
  Object.assign(p, { stage: "apply", done: 0, total: todo.length });
  const missing = todo.map((i) => i.anilistId!).filter((id) => !getMedia(id));
  if (missing.length) saveMedia(await withShikimori(await mediaByIds(missing)));
  for (const item of todo) {
    const media = getMedia(item.anilistId!);
    if (media) {
      const patch: EntryPatch = {};
      const fields = item.action === "add" ? FIELDS.filter((f) => item.lib[f] !== null) : item.fields;
      for (const f of fields) (patch as Record<string, unknown>)[f] = item.lib[f];
      upsertEntry(user.id, media, patch);
    }
    p.done++;
  }
  // Снимок: что AniLib отдал сейчас — от него считаем изменения в следующий раз
  const snapStmt = db.prepare(
    `UPDATE lib_links SET snap_status = ?, snap_episodes = ?, snap_score = ?, synced_at = ? WHERE user_id = ? AND lib_media_id = ?`);
  db.transaction(() => {
    for (const i of planItems) {
      if (!i.anilistId) continue;
      if (i.how === "anilib") saveLink(user.id, i.libMediaId, i.anilistId, "anilib");
      snapStmt.run(i.lib.status, i.lib.episodes, i.lib.score, now(), user.id, i.libMediaId);
    }
  })();
  setUser(user.id, { lib_synced_at: now(), lib_error: null });
}

/** Запустить синхронизацию в фоне (или вернуть уже идущую). apply=false — только предпросмотр. */
export function startSync(user: User, apply: boolean): LibProgress {
  const current = progress.get(user.id);
  if (current && !current.finishedAt) return current;
  if (!user.lib_user_id) throw new Error("Профиль AniLib не подключён");
  const p: LibProgress = { stage: "fetch", done: 0, total: 0, apply, startedAt: now() };
  progress.set(user.id, p);
  void run(user, apply, p)
    .then(() => Object.assign(p, { stage: "done", finishedAt: now() }))
    .catch((err) => {
      const error = explain(err);
      console.warn(`[anilib] ${user.name}: ${error}`);
      Object.assign(p, { stage: "error", error, finishedAt: now() });
      if (apply) setUser(user.id, { lib_error: error });
    });
  return p;
}

export function libStatus(user: User): LibStatus {
  return {
    linked: Boolean(user.lib_user_id),
    userId: user.lib_user_id,
    nickname: user.lib_nickname,
    profileUrl: user.lib_user_id ? `${env.anilibUrl}/ru/user/${user.lib_user_id}` : null,
    syncedAt: user.lib_synced_at,
    error: user.lib_error,
    progress: progress.get(user.id) ?? null,
  };
}

export async function linkProfile(user: User, input: string): Promise<void> {
  const libUserId = parseProfile(input);
  if (!libUserId) throw new Error("Вставьте ссылку на профиль AniLib (…/user/<число>) или его номер");
  const profile = await libProfile(libUserId);
  if (user.lib_user_id !== profile.id) db.prepare("DELETE FROM lib_links WHERE user_id = ?").run(user.id);
  setUser(user.id, { lib_user_id: profile.id, lib_nickname: profile.username, lib_error: null, lib_synced_at: null });
  progress.delete(user.id);
}

export function unlinkProfile(user: User): void {
  db.prepare("DELETE FROM lib_links WHERE user_id = ?").run(user.id);
  setUser(user.id, { lib_user_id: null, lib_nickname: null, lib_synced_at: null, lib_error: null });
  progress.delete(user.id);
}

/** Фоновая синхронизация всех подключённых (из jobs.ts). */
export async function syncAllLib(): Promise<void> {
  const users = db.prepare<[], User>("SELECT * FROM users WHERE lib_user_id IS NOT NULL AND lib_synced_at IS NOT NULL").all();
  for (const user of users) {
    const p = startSync(user, true);
    while (!p.finishedAt) await new Promise((r) => setTimeout(r, 1000));
  }
}
