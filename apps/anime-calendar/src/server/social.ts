import "server-only";
import { canSee, friendState, VISIBILITIES, watchMinutes, type FriendState, type Visibility } from "@/lib/social-rules";
import type { FriendPick, FriendOpinion, ListEntryWithMedia, ListStatus, Person, ProfileStats, TasteMatch } from "@/lib/types";
import { db, now } from "./db";
import { getMedia, getRows, listWithMedia } from "./lists";
import { notify, resolveActions } from "./notifications";
import { tasteMatch } from "./reco/card";
import { ApiError } from "./route";

// Друзья: заявки, видимость профилей и списков, статистика профиля.
// Видимость проверяется только здесь (visibleTo) — маршруты не решают это сами.

type UserRow = { id: number; name: string; visibility: Visibility; jellyfin_id: string };
type FriendRow = { from_id: number; to_id: number; status: string; created_at: number };

const userRow = (id: number) =>
  db.prepare<[number], UserRow>("SELECT id, name, visibility, jellyfin_id FROM users WHERE id = ?").get(id);

const pairRows = (a: number, b: number) =>
  db.prepare<[number, number, number, number], FriendRow>(
    "SELECT * FROM friendships WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").all(a, b, b, a);

export const stateBetween = (me: number, other: number): FriendState => friendState(me, pairRows(me, other));

export function areFriends(a: number, b: number) {
  return stateBetween(a, b) === "friends";
}

/** Владелец (если зрителю его видно), иначе null. */
export function visibleTo(viewerId: number, ownerId: number): UserRow | null {
  const owner = userRow(ownerId);
  if (!owner) return null;
  return canSee(viewerId, owner, stateBetween(viewerId, ownerId)) ? owner : null;
}

export function friendIds(userId: number): number[] {
  return db.prepare<[number, number, number], { id: number }>(
    `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END id FROM friendships
     WHERE status = 'accepted' AND (from_id = ? OR to_id = ?)`).all(userId, userId, userId).map((r) => r.id);
}

/** Действие с дружбой от имени me по отношению к other. */
export function friendAction(me: { id: number; name: string }, otherId: number, action: "request" | "accept" | "decline" | "cancel" | "remove") {
  if (me.id === otherId) throw new ApiError(400, "Нельзя дружить с собой");
  const other = userRow(otherId);
  if (!other) throw new ApiError(404, "Пользователь не найден");
  const state = stateBetween(me.id, otherId);
  const drop = () => db.prepare("DELETE FROM friendships WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)")
    .run(me.id, otherId, otherId, me.id);

  if (action === "request") {
    if (state === "friends" || state === "outgoing") return;
    // Встречная заявка уже есть — это согласие
    if (state === "incoming") return friendAction(me, otherId, "accept");
    db.prepare("INSERT INTO friendships (from_id, to_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(me.id, otherId, now());
    notify(otherId, { kind: "friend", actorId: me.id, title: "хочет добавить вас в друзья", href: `/users/${me.id}`, actions: [{ type: "friend", userId: me.id }] });
  } else if (action === "accept") {
    if (state !== "incoming") return;
    db.prepare("UPDATE friendships SET status = 'accepted', created_at = ? WHERE from_id = ? AND to_id = ?").run(now(), otherId, me.id);
    notify(otherId, { kind: "friend", actorId: me.id, title: "принял заявку — теперь вы друзья", href: `/users/${me.id}` });
    resolveActions(me.id, (a) => a.type === "friend" && a.userId === otherId);
  } else if (action === "decline") {
    if (state === "incoming") drop();
    resolveActions(me.id, (a) => a.type === "friend" && a.userId === otherId);
  } else if (action === "cancel") {
    if (state === "outgoing") drop();
  } else if (action === "remove") {
    if (state === "friends") drop();
  }
}

export function setVisibility(userId: number, v: string) {
  if (!VISIBILITIES.includes(v as Visibility)) throw new ApiError(400, "Неизвестная видимость");
  db.prepare("UPDATE users SET visibility = ? WHERE id = ?").run(v, userId);
}

/** Тайтлы, скрытые пользователем от друзей. */
export function privateIds(userId: number): Set<number> {
  return new Set(db.prepare<[number], { anilist_id: number }>(
    "SELECT anilist_id FROM list_entries WHERE user_id = ? AND private = 1 AND deleted = 0").all(userId).map((r) => r.anilist_id));
}

/** Совпадение вкусов (только с теми, чей профиль виден); сбой модели — просто без процента. */
export async function tasteWith(meId: number, otherId: number): Promise<TasteMatch | null> {
  return tasteMatch(meId, otherId, privateIds).catch((e) => {
    console.warn(`[social] вкус ${meId}↔${otherId}: ${e}`);
    return null;
  });
}

/** Все пользователи сервера глазами me: состояние дружбы, видно ли профиль, совпадение вкусов. */
export async function people(meId: number): Promise<Person[]> {
  const users = db.prepare<[number], UserRow>("SELECT id, name, visibility, jellyfin_id FROM users WHERE id != ? ORDER BY name").all(meId);
  const rows = db.prepare<[number, number], FriendRow>("SELECT * FROM friendships WHERE from_id = ? OR to_id = ?").all(meId, meId);
  const out: Person[] = [];
  for (const u of users) {
    const state = friendState(meId, rows.filter((r) => r.from_id === u.id || r.to_id === u.id));
    const visible = canSee(meId, u, state);
    out.push({ id: u.id, name: u.name, state, visible, taste: visible ? ((await tasteWith(meId, u.id))?.percent ?? null) : null });
  }
  return out;
}

/** Список владельца для чужих глаз: без скрытых тайтлов и личных заметок. */
export function publicList(ownerId: number, viewerId: number): ListEntryWithMedia[] {
  const all = listWithMedia(ownerId);
  if (ownerId === viewerId) return all;
  return all.filter((e) => !e.private).map((e) => ({ ...e, note: null }));
}

export function profileStats(entries: ListEntryWithMedia[]): ProfileStats {
  const byStatus: Partial<Record<ListStatus, number>> = {};
  let minutes = 0;
  let episodes = 0;
  const scored = entries.filter((e) => e.score > 0);
  const genres = new Map<string, number>();
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    minutes += watchMinutes(e, e.media);
    episodes += e.episodes;
    // Любимые жанры — по досмотренному и смотримому, с весом оценки
    if (!e.media || !["completed", "watching", "rewatching"].includes(e.status)) continue;
    const w = e.score ? e.score / 7 : 1;
    for (const g of e.media.genres) genres.set(g, (genres.get(g) ?? 0) + w);
  }
  return {
    total: entries.length,
    byStatus,
    meanScore: scored.length ? Math.round((scored.reduce((s, e) => s + e.score, 0) / scored.length) * 10) / 10 : null,
    hours: Math.round(minutes / 60),
    episodes,
    topGenres: [...genres].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g),
  };
}

export function jellyfinIdOf(userId: number): string | null {
  const id = userRow(userId)?.jellyfin_id;
  return id && !id.startsWith("local:") ? id : null;
}

/** Что о тайтле думают те, чьи списки мне видны (кроме скрытых записей). */
export async function opinionsOn(meId: number, anilistId: number): Promise<FriendOpinion[]> {
  const rows = db.prepare<[number, number], { user_id: number; status: ListStatus; episodes: number; score: number; recommend: number | null; updated_at: number }>(
    `SELECT user_id, status, episodes, score, recommend, updated_at FROM list_entries
     WHERE anilist_id = ? AND user_id != ? AND deleted = 0 AND private = 0`).all(anilistId, meId);
  const out: FriendOpinion[] = [];
  for (const r of rows) {
    const owner = visibleTo(meId, r.user_id);
    if (!owner) continue;
    out.push({
      user: { id: owner.id, name: owner.name },
      status: r.status, episodes: r.episodes, score: r.score,
      recommend: r.recommend === null ? null : Boolean(r.recommend),
      updatedAt: r.updated_at,
      taste: (await tasteWith(meId, r.user_id))?.percent ?? null,
    });
  }
  return out.sort((a, b) => (b.taste ?? -1) - (a.taste ?? -1));
}

/** «Советуют друзья»: что рекомендуют те, чьи списки мне видны, — чем ближе вкус, тем выше; моё (кроме «в планах») не показываем. */
export async function friendPicks(meId: number, limit = 12): Promise<FriendPick[]> {
  const mine = new Map(getRows(meId).map((r) => [r.anilist_id, r.status]));
  const rows = db.prepare<[number], { user_id: number; anilist_id: number }>(
    "SELECT user_id, anilist_id FROM list_entries WHERE recommend = 1 AND deleted = 0 AND private = 0 AND user_id != ?").all(meId);
  const tastes = new Map<number, { name: string; taste: number | null } | null>();
  const picks = new Map<number, FriendPick>();
  for (const r of rows) {
    const st = mine.get(r.anilist_id);
    if (st && st !== "planned") continue;
    if (!tastes.has(r.user_id)) {
      const owner = visibleTo(meId, r.user_id);
      tastes.set(r.user_id, owner ? { name: owner.name, taste: (await tasteWith(meId, r.user_id))?.percent ?? null } : null);
    }
    const who = tastes.get(r.user_id);
    if (!who) continue;
    const media = getMedia(r.anilist_id);
    if (!media || media.isAdult) continue;
    const pick = picks.get(r.anilist_id) ?? { media, by: [], weight: 0 };
    pick.by.push({ id: r.user_id, name: who.name, taste: who.taste });
    // Совет человека с похожим вкусом весит больше; без данных о вкусе — как средний
    pick.weight += (who.taste ?? 50) / 100;
    picks.set(r.anilist_id, pick);
  }
  return [...picks.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}
