import "server-only";
import type { CommentItem } from "@/lib/types";
import { db, now } from "./db";
import type { BookLite } from "@/lib/books";
import { getCached } from "./cache";
import { notify } from "./notifications";
import { ApiError } from "./route";
import { areFriends, visibleTo } from "./social";

// Обсуждение под тайтлом. Комментарий — публикация: его видят друзья автора (и все, если профиль открыт всем),
// даже при профиле «Только я» — иначе писать было бы бессмысленно. Оценка автора рядом с именем —
// только если его список мне виден и тайтл не скрыт.

type Row = {
  id: number; anilist_id: number; user_id: number; parent_id: number | null; body: string; spoiler: number;
  episode: number | null; created_at: number; edited_at: number | null; deleted: number; name: string; visibility: string;
};

const MAX_LEN = 4000;

function canRead(viewerId: number, author: { id: number; visibility: string }) {
  return viewerId === author.id || author.visibility === "all" || areFriends(viewerId, author.id);
}

export function listComments(viewer: { id: number; is_admin: number }, anilistId: number): CommentItem[] {
  const rows = db.prepare<[number], Row>(
    `SELECT c.*, u.name, u.visibility FROM comments c JOIN users u ON u.id = c.user_id WHERE c.anilist_id = ? ORDER BY c.id`).all(anilistId);
  const readable = rows.filter((r) => canRead(viewer.id, { id: r.user_id, visibility: r.visibility }));
  // Удалённые без видимых ответов не показываем вовсе
  const hasReplies = new Set(readable.filter((r) => !r.deleted).map((r) => r.parent_id));
  const scores = new Map<number, number | null>();
  const scoreOf = (userId: number) => {
    if (!scores.has(userId)) {
      const e = visibleTo(viewer.id, userId)
        ? db.prepare<[number, number], { score: number; private: number }>(
          "SELECT score, private FROM list_entries WHERE user_id = ? AND anilist_id = ? AND deleted = 0").get(userId, anilistId)
        : undefined;
      scores.set(userId, e && !e.private && e.score > 0 ? e.score : null);
    }
    return scores.get(userId)!;
  };
  return readable.filter((r) => !r.deleted || hasReplies.has(r.id)).map((r) => ({
    id: r.id, parentId: r.parent_id,
    user: { id: r.user_id, name: r.name },
    body: r.deleted ? "" : r.body,
    spoiler: Boolean(r.spoiler), episode: r.episode,
    createdAt: r.created_at, editedAt: r.edited_at,
    deleted: Boolean(r.deleted),
    mine: r.user_id === viewer.id,
    friend: r.user_id !== viewer.id && areFriends(viewer.id,r.user_id),
    score: r.deleted ? null : scoreOf(r.user_id),
  }));
}

function clean(body: unknown) {
  const text = String(body ?? "").replace(/\r/g, "").trim().slice(0, MAX_LEN);
  if (!text) throw new ApiError(400, "Пустой комментарий");
  return text;
}

export function addComment(user: { id: number; name: string }, anilistId: number, p: { body: unknown; parentId?: number | null; spoiler?: boolean; episode?: number | null }) {
  const body = clean(p.body);
  let parent: { user_id: number; anilist_id: number } | undefined;
  if (p.parentId) {
    parent = db.prepare<[number], { user_id: number; anilist_id: number }>("SELECT user_id, anilist_id FROM comments WHERE id = ?").get(p.parentId);
    if (!parent || parent.anilist_id !== anilistId) throw new ApiError(400, "Нет такого комментария");
  }
  const episode = p.episode && p.episode > 0 ? Math.floor(p.episode) : null;
  const id = Number(db.prepare(
    "INSERT INTO comments (anilist_id, user_id, parent_id, body, spoiler, episode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(anilistId, user.id, p.parentId ?? null, body, p.spoiler ? 1 : 0, episode, now()).lastInsertRowid);
  if (parent && parent.user_id !== user.id) {
    // Обсуждение книги (id AniList общие): книга в уведомлении и ссылка на её страницу
    const book = getCached<BookLite>(`book:lite:${anilistId}`, true);
    notify(parent.user_id, {
      kind: "comment", actorId: user.id, title: `${user.name} ответил на ваш комментарий`,
      body: p.spoiler ? "(спойлер)" : body.slice(0, 140),
      ...(book
        ? { book: { id: book.id, title: book.title.ru || book.title.romaji || book.title.english || String(book.id), cover: book.coverImage.large }, href: `/manga/${anilistId}` }
        : { anilistId, href: `/anime/${anilistId}?comment=${id}#c${id}` }),
    });
  }
  return id;
}

function own(user: { id: number; is_admin: number }, id: number) {
  const c = db.prepare<[number], { user_id: number }>("SELECT user_id FROM comments WHERE id = ? AND deleted = 0").get(id);
  if (!c) throw new ApiError(404, "Комментарий не найден");
  if (c.user_id !== user.id && !user.is_admin) throw new ApiError(403, "Можно менять только свои комментарии");
}

export function editComment(user: { id: number; is_admin: number }, id: number, p: { body?: unknown; spoiler?: boolean }) {
  own(user, id);
  if (p.body !== undefined) db.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").run(clean(p.body), now(), id);
  if (p.spoiler !== undefined) db.prepare("UPDATE comments SET spoiler = ? WHERE id = ?").run(p.spoiler ? 1 : 0, id);
}

export function deleteComment(user: { id: number; is_admin: number }, id: number) {
  own(user, id);
  db.prepare("UPDATE comments SET deleted = 1, body = '' WHERE id = ?").run(id);
}
