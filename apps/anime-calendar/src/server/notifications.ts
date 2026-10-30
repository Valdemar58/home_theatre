import "server-only";
import { kindInfo, type NoticeGroup } from "@/lib/notice-kinds";
import { displayTitle } from "@/lib/schedule";
import type { Notice, NoticeAction, NoticeCounts } from "@/lib/types";
import { db, now } from "./db";
import { ensureMedia, getMedia } from "./lists";

// Уведомления пользователя: новые серии, итоги фоновых задач, друзья, общие списки, ответы.
// К уведомлению привязаны тайтл (обложка) и/или автор (аватар) — текст остаётся коротким: «что произошло».
// Клиент опрашивает список раз в 15 с: новые показывает тостом, все — в колокольчике и на странице.

const KEEP = 300; // храним последние N на пользователя

export type NoticeInput = {
  kind: string;
  title: string;
  body?: string | null;
  href?: string | null;
  anilistId?: number | null;
  actorId?: number | null;
  /** Подпись, если нет ни тайтла, ни автора */
  subject?: string | null;
  actions?: NoticeAction[];
  error?: boolean;
  /** Награда и полученный уровень — значок в уведомлении и праздничный тост */
  achievement?: { id: string; tier: number };
  /** Книга (id AniList у книг и аниме общий, но снимка в media у книги нет) — обложка в уведомлении */
  book?: { id: number; title: string; cover: string | null };
};

/** replace — адрес-префикс: непрочитанное того же вида с таким адресом заменяется (подсказки не копятся). */
export function notify(userId: number, n: NoticeInput, opts?: { replace?: string }) {
  if (opts?.replace) db.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = ? AND read_at IS NULL AND substr(href, 1, ?) = ?")
    .run(userId, n.kind, opts.replace.length, opts.replace);
  const data = { subject: n.subject ?? null, actions: n.actions ?? [], error: Boolean(n.error), achievement: n.achievement ?? null, book: n.book ?? null };
  // Тайтла может не быть в списках (озвучки искали из каталога) — снимок с обложкой нужен карточке уведомления
  if (n.anilistId && !getMedia(n.anilistId)) void ensureMedia(n.anilistId).catch(() => undefined);
  db.prepare(`INSERT INTO notifications (user_id, kind, grp, title, body, href, anilist_id, actor_id, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, n.kind, kindInfo(n.kind, n.error).group, n.title, n.body ?? null, n.href ?? null, n.anilistId ?? null, n.actorId ?? null, JSON.stringify(data), now());
  db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN
    (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP})`).run(userId, userId);
}

type Row = {
  id: number; kind: string; grp: NoticeGroup | null; title: string; body: string | null; href: string | null;
  anilist_id: number | null; actor_id: number | null; data: string | null; created_at: number; read_at: number | null;
};

const userName = (id: number) => db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? null;

/** Тайтл уведомления; у старых без привязки — из адреса. */
const anilistOf = (r: Pick<Row, "anilist_id" | "href">) => r.anilist_id ?? (Number(/^\/anime\/(\d+)/.exec(r.href ?? "")?.[1]) || null);

function toNotice(r: Row): Notice {
  const data = (r.data ? JSON.parse(r.data) : {}) as { subject?: string | null; actions?: NoticeAction[]; error?: boolean; achievement?: { id: string; tier: number } | null;
    book?: { id: number; title: string; cover: string | null } | null };
  const anilistId = anilistOf(r);
  const m = anilistId ? getMedia(anilistId) : null;
  const actorName = r.actor_id ? userName(r.actor_id) : null;
  return {
    id: r.id, kind: r.kind, group: r.grp ?? kindInfo(r.kind, data.error).group, error: Boolean(data.error),
    title: r.title, body: r.body, href: r.href, createdAt: r.created_at, read: r.read_at !== null,
    media: m ? { id: m.id, title: displayTitle(m.title), cover: m.coverImage.large ?? null, color: m.coverImage.color ?? null }
      : data.book ? { ...data.book, color: null } : null,
    actor: r.actor_id && actorName ? { id: r.actor_id, name: actorName } : null,
    subject: data.subject ?? null,
    actions: data.actions ?? [],
    achievement: data.achievement ?? null,
  };
}

export function unreadCounts(userId: number): NoticeCounts {
  const rows = db.prepare<[number], { grp: NoticeGroup; n: number }>(
    "SELECT grp, COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL GROUP BY grp").all(userId);
  const c: NoticeCounts = { all: 0, titles: 0, friends: 0, achievements: 0, important: 0 };
  for (const r of rows) { c[r.grp] = r.n; c.all += r.n; }
  return c;
}

export async function listNotices(userId: number, q: { group?: string; unread?: boolean; before?: number; limit?: number } = {}) {
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const where = ["user_id = ?"];
  const args: (number | string)[] = [userId];
  if (q.group && q.group !== "all") { where.push("grp = ?"); args.push(q.group); }
  if (q.unread) where.push("read_at IS NULL");
  if (q.before) { where.push("id < ?"); args.push(q.before); }
  const rows = db.prepare<(number | string)[], Row>(
    `SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit + 1}`).all(...args);
  // Снимков тайтлов нет (старые уведомления, тайтл не из списков) — догрузить, иначе не будет обложки
  const missing = [...new Set(rows.map(anilistOf).filter((id): id is number => id !== null && !getMedia(id)))];
  for (const id of missing.slice(0, 10)) await ensureMedia(id).catch(() => undefined);
  return { items: rows.slice(0, limit).map(toNotice), hasMore: rows.length > limit, unread: unreadCounts(userId) };
}

/** Действие над уведомлениями: ids — выбранные; без ids — все во вкладке group. */
export function updateNotices(userId: number, action: "read" | "unread" | "delete" | "delete-read", ids?: number[], group?: string) {
  const where = ["user_id = ?"];
  const args: (number | string)[] = [userId];
  if (ids?.length) { where.push(`id IN (${ids.map(() => "?").join(",")})`); args.push(...ids); }
  if (group && group !== "all") { where.push("grp = ?"); args.push(group); }
  const w = where.join(" AND ");
  if (action === "read") db.prepare(`UPDATE notifications SET read_at = ${now()} WHERE ${w} AND read_at IS NULL`).run(...args);
  else if (action === "unread") db.prepare(`UPDATE notifications SET read_at = NULL WHERE ${w}`).run(...args);
  else if (action === "delete") db.prepare(`DELETE FROM notifications WHERE ${w}`).run(...args);
  else db.prepare(`DELETE FROM notifications WHERE ${w} AND read_at IS NOT NULL`).run(...args);
}

/** Действие выполнено (заявка принята, отметка отменена) — кнопки больше не нужны. */
export function resolveActions(userId: number, match: (a: NoticeAction) => boolean) {
  const rows = db.prepare<[number], { id: number; data: string | null }>(
    "SELECT id, data FROM notifications WHERE user_id = ? AND data LIKE '%\"actions\":[{%'").all(userId);
  for (const r of rows) {
    const data = JSON.parse(r.data ?? "{}") as { actions?: NoticeAction[] };
    const left = (data.actions ?? []).filter((a) => !match(a));
    if (left.length !== (data.actions ?? []).length) {
      db.prepare("UPDATE notifications SET data = ?, read_at = COALESCE(read_at, ?) WHERE id = ?").run(JSON.stringify({ ...data, actions: left }), now(), r.id);
    }
  }
}
