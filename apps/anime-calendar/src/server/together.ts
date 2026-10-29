import "server-only";
import { defaultUpTo, episodesRange, togetherChange, type MemberState } from "@/lib/together-rules";
import type {
  CoWatcher, SharedItem, SharedListDetail, SharedListSummary, SharedMember, WatchSessionInfo,
} from "@/lib/types";
import { db, now } from "./db";
import { ensureMedia, getMedia, getRow, logWatch, pushSoon, upsertEntry, type EntryRow } from "./lists";
import { notify, resolveActions } from "./notifications";
import { ApiError } from "./route";
import { areFriends, friendIds } from "./social";

// Совместный просмотр: общие списки, «посмотрели вместе» (с отменой) и режим «Смотрим вместе с…».
// Статусы участников в общем списке не хранятся отдельно — это их личные записи (живые данные);
// тайтл, скрытый участником от друзей, показывается как «скрыто».

type ListRow = { id: number; name: string; owner_id: number; created_at: number };
type MemberRow = { list_id: number; user_id: number; status: "invited" | "member"; name: string };

const userName = (id: number) => db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? "?";

// ---------------------------------------------------------------- общие списки

export const listRow = (id: number) => db.prepare<[number], ListRow>("SELECT * FROM shared_lists WHERE id = ?").get(id);
export const membersOf = (listId: number) => db.prepare<[number], MemberRow>(
  `SELECT m.list_id, m.user_id, m.status, u.name FROM shared_list_members m JOIN users u ON u.id = m.user_id
   WHERE m.list_id = ? ORDER BY m.joined_at`).all(listId);

export function roleIn(listId: number, userId: number): "owner" | "member" | "invited" | null {
  const l = listRow(listId);
  if (!l) return null;
  if (l.owner_id === userId) return "owner";
  return db.prepare<[number, number], { status: "invited" | "member" }>(
    "SELECT status FROM shared_list_members WHERE list_id = ? AND user_id = ?").get(listId, userId)?.status ?? null;
}

export function requireMember(listId: number, userId: number) {
  const role = roleIn(listId, userId);
  if (role !== "owner" && role !== "member") throw new ApiError(403, "Вы не участник этого списка");
  return role;
}

export function createList(owner: { id: number; name: string }, name: string, invite: number[]): number {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new ApiError(400, "Нужно название");
  const id = Number(db.prepare("INSERT INTO shared_lists (name, owner_id, created_at) VALUES (?, ?, ?)").run(clean, owner.id, now()).lastInsertRowid);
  db.prepare("INSERT INTO shared_list_members (list_id, user_id, status, invited_by, joined_at) VALUES (?, ?, 'member', NULL, ?)").run(id, owner.id, now());
  for (const u of invite) inviteToList(owner, id, u);
  return id;
}

export function inviteToList(by: { id: number; name: string }, listId: number, userId: number) {
  requireMember(listId, by.id);
  if (!areFriends(by.id, userId)) throw new ApiError(400, "Пригласить можно только друга");
  if (roleIn(listId, userId)) return;
  db.prepare("INSERT INTO shared_list_members (list_id, user_id, status, invited_by, joined_at) VALUES (?, ?, 'invited', ?, ?)").run(listId, userId, by.id, now());
  notify(userId, { kind: "shared-list", actorId: by.id, title: `зовёт в группу «${listRow(listId)!.name}»`, href: `/groups/${listId}`, actions: [{ type: "shared-invite", listId }] });
}

export function memberAction(user: { id: number; name: string }, listId: number, action: "accept" | "decline" | "leave" | "remove", target?: number) {
  const role = roleIn(listId, user.id);
  const list = listRow(listId);
  if (!list || !role) throw new ApiError(404, "Список не найден");
  const del = (u: number) => db.prepare("DELETE FROM shared_list_members WHERE list_id = ? AND user_id = ?").run(listId, u);
  if (action === "accept" && role === "invited") {
    db.prepare("UPDATE shared_list_members SET status = 'member', joined_at = ? WHERE list_id = ? AND user_id = ?").run(now(), listId, user.id);
    for (const m of membersOf(listId)) if (m.user_id !== user.id && m.status === "member")
      notify(m.user_id, { kind: "shared-list", actorId: user.id, title: `присоединился к «${list.name}»`, href: `/groups/${listId}` });
  } else if (action === "decline" && role === "invited") del(user.id);
  if (action === "accept" || action === "decline") resolveActions(user.id, (a) => a.type === "shared-invite" && a.listId === listId);
  else if (action === "leave" && role === "member") del(user.id);
  else if (action === "remove" && role === "owner" && target && target !== user.id) del(target);
}

export function renameList(userId: number, listId: number, name: string) {
  if (roleIn(listId, userId) !== "owner") throw new ApiError(403, "Переименовать может только создатель");
  const clean = name.trim().slice(0, 80);
  if (clean) db.prepare("UPDATE shared_lists SET name = ? WHERE id = ?").run(clean, listId);
}

export function deleteList(userId: number, listId: number) {
  if (roleIn(listId, userId) !== "owner") throw new ApiError(403, "Удалить может только создатель");
  db.prepare("DELETE FROM shared_lists WHERE id = ?").run(listId);
}

export async function addItem(user: { id: number; name: string }, listId: number, anilistId: number) {
  requireMember(listId, user.id);
  const media = await ensureMedia(anilistId);
  const res = db.prepare("INSERT OR IGNORE INTO shared_list_items (list_id, anilist_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(listId, anilistId, user.id, now());
  if (!res.changes) return;
  const list = listRow(listId)!;
  for (const m of membersOf(listId)) if (m.user_id !== user.id && m.status === "member")
    notify(m.user_id, { kind: "shared-list", anilistId, actorId: user.id, title: `${user.name} добавил в «${list.name}»`, href: `/groups/${listId}` });
}

export function removeItem(userId: number, listId: number, anilistId: number) {
  requireMember(listId, userId);
  db.prepare("DELETE FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").run(listId, anilistId);
}

type EntryLite = Pick<EntryRow, "user_id" | "status" | "episodes" | "score" | "updated_at" | "private" | "recommend">;

/** Личные записи участников по тайтлам (одним запросом). */
function entriesOf(userIds: number[], anilistIds: number[]): Map<string, EntryLite> {
  if (!userIds.length || !anilistIds.length) return new Map();
  const rows = db.prepare<number[], EntryLite & { anilist_id: number }>(
    `SELECT user_id, anilist_id, status, episodes, score, updated_at, private, recommend FROM list_entries
     WHERE deleted = 0 AND user_id IN (${userIds.map(() => "?").join(",")}) AND anilist_id IN (${anilistIds.map(() => "?").join(",")})`,
  ).all(...userIds, ...anilistIds);
  return new Map(rows.map((r) => [`${r.user_id}:${r.anilist_id}`, r]));
}

/** Общее состояние тайтла: никто не начал / смотрим / все досмотрели. */
function itemState(states: SharedItem["members"]): SharedItem["state"] {
  const known = states.filter((s) => !s.hidden);
  if (known.length && known.every((s) => s.status === "completed")) return "done";
  if (known.some((s) => s.status && (s.episodes > 0 || ["watching", "rewatching", "completed"].includes(s.status)))) return "watching";
  return "planned";
}

export function myLists(userId: number): SharedListSummary[] {
  const lists = db.prepare<[number], ListRow & { role: string }>(
    `SELECT l.*, m.status role FROM shared_lists l JOIN shared_list_members m ON m.list_id = l.id
     WHERE m.user_id = ? ORDER BY l.created_at DESC`).all(userId);
  return lists.map((l) => {
    const members = membersOf(l.id);
    const items = db.prepare<[number], { anilist_id: number }>("SELECT anilist_id FROM shared_list_items WHERE list_id = ?").all(l.id).map((r) => r.anilist_id);
    const detail = itemsOf(l.id, members, items);
    return {
      id: l.id, name: l.name, ownerId: l.owner_id,
      role: l.owner_id === userId ? "owner" : (l.role as "member" | "invited"),
      members: members.map((m): SharedMember => ({ id: m.user_id, name: m.name, status: m.status })),
      counts: { total: items.length, watching: detail.filter((i) => i.state === "watching").length, done: detail.filter((i) => i.state === "done").length },
      covers: detail.slice(0, 4).map((i) => i.media.coverImage.large).filter((c): c is string => Boolean(c)),
    };
  });
}

export function itemsOf(listId: number, members: MemberRow[], ids?: number[]): SharedItem[] {
  const rows = db.prepare<[number], { anilist_id: number; added_by: number | null; added_at: number }>(
    "SELECT anilist_id, added_by, added_at FROM shared_list_items WHERE list_id = ? ORDER BY added_at DESC").all(listId)
    .filter((r) => !ids || ids.includes(r.anilist_id));
  const active = members.filter((m) => m.status === "member");
  const entries = entriesOf(active.map((m) => m.user_id), rows.map((r) => r.anilist_id));
  const out: SharedItem[] = [];
  for (const r of rows) {
    const media = getMedia(r.anilist_id);
    if (!media) continue;
    const states = active.map((m) => {
      const e = entries.get(`${m.user_id}:${r.anilist_id}`);
      if (e?.private) return { userId: m.user_id, status: null, episodes: 0, score: 0, updatedAt: null, hidden: true };
      return { userId: m.user_id, status: e?.status ?? null, episodes: e?.episodes ?? 0, score: e?.score ?? 0, updatedAt: e?.updated_at ?? null, hidden: false };
    });
    out.push({ media, addedBy: r.added_by, addedAt: r.added_at, members: states, state: itemState(states) });
  }
  return out;
}

export function listDetail(userId: number, listId: number): SharedListDetail {
  const role = roleIn(listId, userId);
  const l = listRow(listId);
  if (!l || !role) throw new ApiError(404, "Список не найден");
  const members = membersOf(listId);
  return {
    id: l.id, name: l.name, ownerId: l.owner_id, role,
    members: members.map((m) => ({ id: m.user_id, name: m.name, status: m.status })),
    items: role === "invited" ? [] : itemsOf(listId, members),
  };
}

/** Общие списки, где я участник, — для меню «В общий список…» (есть ли там тайтл). */
export function listsForTitle(userId: number, anilistId: number): { id: number; name: string; has: boolean }[] {
  return db.prepare<[number, number], { id: number; name: string; has: number }>(
    `SELECT l.id, l.name, EXISTS (SELECT 1 FROM shared_list_items i WHERE i.list_id = l.id AND i.anilist_id = ?) has
     FROM shared_lists l JOIN shared_list_members m ON m.list_id = l.id AND m.user_id = ? AND m.status = 'member'
     ORDER BY l.created_at DESC`).all(anilistId, userId).map((r) => ({ id: r.id, name: r.name, has: Boolean(r.has) }));
}

/** Участники моих общих списков, где есть этот тайтл (кроме меня). */
function coMembers(userId: number, anilistId: number): number[] {
  return db.prepare<[number, number, number], { user_id: number }>(
    `SELECT DISTINCT m2.user_id FROM shared_list_items i
     JOIN shared_list_members m1 ON m1.list_id = i.list_id AND m1.user_id = ? AND m1.status = 'member'
     JOIN shared_list_members m2 ON m2.list_id = i.list_id AND m2.status = 'member' AND m2.user_id != ?
     WHERE i.anilist_id = ?`).all(userId, userId, anilistId).map((r) => r.user_id);
}

// ---------------------------------------------------------------- «посмотрели вместе»

function memberState(userId: number, anilistId: number): MemberState {
  const r = getRow(userId, anilistId);
  return r && !r.deleted ? { userId, status: r.status, episodes: r.episodes } : { userId, status: null, episodes: 0 };
}

/** Кого можно отметить: я, участники общих списков с этим тайтлом (отмечены по умолчанию), остальные друзья. */
export function coWatchers(userId: number, anilistId: number): { people: CoWatcher[]; upTo: number } {
  const media = getMedia(anilistId);
  const co = new Set(coMembers(userId, anilistId));
  const ids = [userId, ...co, ...friendIds(userId).filter((f) => !co.has(f))];
  const people = ids.map((id): CoWatcher => {
    const s = memberState(id, anilistId);
    const e = getRow(id, anilistId);
    // Скрытое от друзей не показываем — будто тайтла нет в списке
    const hidden = id !== userId && Boolean(e?.private);
    return { id, name: userName(id), me: id === userId, inSharedList: co.has(id), status: hidden ? null : s.status, episodes: hidden ? 0 : s.episodes };
  });
  const checked = people.filter((p) => p.me || p.inSharedList).map((p) => ({ userId: p.id, status: p.status, episodes: p.episodes }));
  return { people, upTo: defaultUpTo(checked, media?.episodes ?? null) };
}

type Change = { userId: number; from: number; to: number; before: EntryRow | null; afterAt: number; undone?: boolean };

/**
 * Отметить серии до upTo у выбранных (себя и друзей). Прогресс только растёт, досмотревших не трогаем.
 * Остальным участникам — уведомление с «Отменить».
 */
export async function markTogether(actor: { id: number; name: string }, anilistId: number, marks: { userId: number; upTo: number }[], via = "вместе с вами") {
  const media = await ensureMedia(anilistId);
  const changes: Change[] = [];
  for (const { userId, upTo } of marks) {
    if (userId !== actor.id && !areFriends(actor.id, userId)) throw new ApiError(400, "Отметить можно только себя и друзей");
    const before = getRow(userId, anilistId);
    const live = before && !before.deleted ? before : null;
    const ch = togetherChange(memberState(userId, anilistId), Math.floor(upTo), media.episodes);
    if (!ch) continue;
    upsertEntry(userId, media, { episodes: ch.to });
    logWatch(userId, media, ch.from, ch.to);
    changes.push({ userId, ...ch, before: live, afterAt: getRow(userId, anilistId)!.updated_at });
  }
  if (!changes.length) return { eventId: null, changes: [] };
  const eventId = Number(db.prepare("INSERT INTO watch_events (actor_id, anilist_id, changes, created_at) VALUES (?, ?, ?, ?)")
    .run(actor.id, anilistId, JSON.stringify(changes), now()).lastInsertRowid);
  const others = changes.filter((c) => c.userId !== actor.id);
  const names = (except: number) => changes.filter((c) => c.userId !== except).map((c) => (c.userId === actor.id ? actor.name : userName(c.userId)));
  for (const c of others) {
    const with_ = names(c.userId).filter((n) => n !== actor.name);
    notify(c.userId, {
      kind: "together", anilistId, actorId: actor.id,
      title: `${actor.name} отметил вам ${episodesRange(c.from, c.to)}`,
      body: `${via}${with_.length ? ` и ${with_.join(", ")}` : ""}`,
      href: `/anime/${anilistId}?undo=${eventId}`,
      actions: [{ type: "undo", eventId }],
    });
  }
  return { eventId, changes: changes.map(({ userId, from, to }) => ({ userId, name: userName(userId), from, to })) };
}

/** Отмена: актор отменяет всё, участник — только своё; запись, изменённая с тех пор, не трогается. */
export function undoTogether(userId: number, eventId: number): { undone: number; skipped: number } {
  const ev = db.prepare<[number], { actor_id: number; anilist_id: number; changes: string; undone_at: number | null }>(
    "SELECT actor_id, anilist_id, changes, undone_at FROM watch_events WHERE id = ?").get(eventId);
  if (!ev) throw new ApiError(404, "Отметка не найдена");
  const changes = JSON.parse(ev.changes) as Change[];
  const mine = changes.filter((c) => !c.undone && (ev.actor_id === userId || c.userId === userId));
  if (!mine.length && !changes.some((c) => c.userId === userId) && ev.actor_id !== userId) throw new ApiError(403, "Это не ваша отметка");
  let undone = 0;
  let skipped = 0;
  for (const c of mine) {
    const cur = getRow(c.userId, ev.anilist_id);
    if (!cur || cur.updated_at !== c.afterAt) { skipped++; continue; }
    if (!c.before) {
      db.prepare("DELETE FROM list_entries WHERE user_id = ? AND anilist_id = ?").run(c.userId, ev.anilist_id);
    } else {
      db.prepare("UPDATE list_entries SET status = ?, episodes = ?, waiting = ?, aired_mark = ?, updated_at = ?, dirty = 1 WHERE user_id = ? AND anilist_id = ?")
        .run(c.before.status, c.before.episodes, c.before.waiting, c.before.aired_mark, now(), c.userId, ev.anilist_id);
      pushSoon(c.userId, ev.anilist_id);
    }
    c.undone = true;
    undone++;
  }
  resolveActions(userId, (a) => a.type === "undo" && a.eventId === eventId);
  db.prepare("UPDATE watch_events SET changes = ?, undone_at = CASE WHEN ? THEN ? ELSE undone_at END WHERE id = ?")
    .run(JSON.stringify(changes), changes.every((c) => c.undone) ? 1 : 0, now(), eventId);
  return { undone, skipped };
}

/** Что отметка изменила у меня (для плашки «Отменить» на странице тайтла). */
export function eventFor(userId: number, eventId: number) {
  const ev = db.prepare<[number], { actor_id: number; anilist_id: number; changes: string; created_at: number }>(
    "SELECT actor_id, anilist_id, changes, created_at FROM watch_events WHERE id = ?").get(eventId);
  if (!ev) return null;
  const c = (JSON.parse(ev.changes) as Change[]).find((x) => x.userId === userId);
  if (!c) return null;
  return { actor: userName(ev.actor_id), anilistId: ev.anilist_id, from: c.from, to: c.to, undone: Boolean(c.undone), createdAt: ev.created_at };
}

// ---------------------------------------------------------------- «смотрим вместе с…»

const SESSION_IDLE = 6 * 3600;
type SessionRow = { id: number; owner_id: number; anilist_id: number; members: string; started_at: number; last_activity: number };

function ownSession(ownerId: number, anilistId: number): SessionRow | undefined {
  return db.prepare<[number, number, number], SessionRow>(
    `SELECT * FROM watch_sessions WHERE owner_id = ? AND anilist_id = ? AND ended_at IS NULL AND last_activity > ?`)
    .get(ownerId, anilistId, now() - SESSION_IDLE);
}

export function sessionInfo(userId: number, anilistId: number): WatchSessionInfo | null {
  const rows = db.prepare<[number, number], SessionRow>(
    `SELECT * FROM watch_sessions WHERE anilist_id = ? AND ended_at IS NULL AND last_activity > ?`).all(anilistId, now() - SESSION_IDLE);
  const s = rows.find((r) => r.owner_id === userId) ?? rows.find((r) => (JSON.parse(r.members) as number[]).includes(userId));
  if (!s) return null;
  const members = JSON.parse(s.members) as number[];
  return {
    id: s.id, owner: { id: s.owner_id, name: userName(s.owner_id) }, mine: s.owner_id === userId,
    members: members.map((id) => ({ id, name: userName(id) })), startedAt: s.started_at, lastActivity: s.last_activity,
  };
}

export function startSession(owner: { id: number; name: string }, anilistId: number, members: number[]) {
  const ok = [...new Set(members)].filter((m) => m !== owner.id && areFriends(owner.id, m));
  if (!ok.length) throw new ApiError(400, "Выберите хотя бы одного друга");
  db.prepare("UPDATE watch_sessions SET ended_at = ? WHERE owner_id = ? AND anilist_id = ? AND ended_at IS NULL").run(now(), owner.id, anilistId);
  db.prepare("INSERT INTO watch_sessions (owner_id, anilist_id, members, started_at, last_activity) VALUES (?, ?, ?, ?, ?)")
    .run(owner.id, anilistId, JSON.stringify(ok), now(), now());
  for (const m of ok) notify(m, {
    kind: "together", anilistId, actorId: owner.id, title: `${owner.name} смотрит вместе с вами`,
    body: "Серии, отмеченные у него, отметятся и у вас", href: `/anime/${anilistId}`,
  });
}

export function updateSession(ownerId: number, anilistId: number, members: number[]) {
  const s = ownSession(ownerId, anilistId);
  if (!s) throw new ApiError(404, "Совместный просмотр не идёт");
  const ok = [...new Set(members)].filter((m) => m !== ownerId && areFriends(ownerId, m));
  if (!ok.length) return endSession(ownerId, anilistId);
  db.prepare("UPDATE watch_sessions SET members = ? WHERE id = ?").run(JSON.stringify(ok), s.id);
}

export function endSession(userId: number, anilistId: number) {
  const s = ownSession(userId, anilistId);
  if (s) return void db.prepare("UPDATE watch_sessions SET ended_at = ? WHERE id = ?").run(now(), s.id);
  // Участник выходит сам
  const info = sessionInfo(userId, anilistId);
  if (info && !info.mine) updateSession(info.owner.id, anilistId, info.members.map((m) => m.id).filter((m) => m !== userId));
}

/**
 * Прогресс пользователя вырос (вручную или из Jellyfin):
 *  • идёт «Смотрим вместе» — те же серии засчитываются участникам;
 *  • иначе, если тайтл в общем списке и кто-то из участников отстаёт, — подсказка «Отметить и для …?».
 */
export async function onProgress(user: { id: number; name: string }, anilistId: number, before: number, after: number, source: "manual" | "jellyfin" | "player") {
  if (after <= before) return;
  const media = getMedia(anilistId);
  if (!media) return;
  const s = ownSession(user.id, anilistId);
  if (s) {
    db.prepare("UPDATE watch_sessions SET last_activity = ? WHERE id = ?").run(now(), s.id);
    const members = JSON.parse(s.members) as number[];
    await markTogether(user, anilistId, members.map((userId) => ({ userId, upTo: after })), "смотрели вместе");
    return;
  }
  const behind = coMembers(user.id, anilistId)
    .map((id) => ({ id, s: memberState(id, anilistId), e: getRow(id, anilistId) }))
    .filter(({ s: st, e }) => !e?.private && togetherChange(st, after, media.episodes));
  if (!behind.length) return;
  const names = behind.map((b) => userName(b.id)).join(", ");
  const where = source === "jellyfin" ? `Посмотрели до серии ${after} в Jellyfin` : source === "player" ? `Посмотрели до серии ${after}` : `Вы отметили до серии ${after}`;
  notify(user.id, {
    kind: "together-suggest", anilistId, title: `${where}. Отметить и для ${names}?`,
    href: `/anime/${anilistId}?together=${after}`,
    actions: [{ type: "link", label: "Отметить…", href: `/anime/${anilistId}?together=${after}` }],
  }, { replace: `/anime/${anilistId}?together=` });
}

