import "server-only";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  canControl, HOLD_MAX_MS, positionAt, type RoomAction, type RoomActionKind, type RoomMember, type RoomPreset, type RoomPresence,
  type RoomState, type RoomView,
} from "@/lib/room";
import { displayTitle } from "@/lib/schedule";
import { db, now } from "./db";
import { getMedia } from "./lists";
import { notify } from "./notifications";
import { ApiError } from "./route";
import { areFriends, friendIds } from "./social";

// Комнаты совместного просмотра (TASKS 9.4а). Состояние комнаты (серия, пауза, позиция на момент at) — в базе,
// связь участников (в сети, грузится, скорость, задержка) и последние действия — в памяти: это живое, после
// перезапуска восстановится само. Изменения рассылаются через roomEvents — SSE /api/rooms/<id>/events.

/** Комната без действий дольше — закончилась. */
const ROOM_IDLE = 6 * 3600;
const ACTIONS_KEPT = 30;

export const roomEvents = new EventEmitter();
roomEvents.setMaxListeners(0);

type RoomRow = { id: string; owner_id: number; anilist_id: number; preset: RoomPreset; state: string; last_activity: number; ended_at: number | null };
type MemberRow = { user_id: number; status: RoomMember["status"]; control: number };

type Live = {
  presence: Map<number, RoomPresence & { conns: number }>;
  actions: RoomAction[];
  holdTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Не дождались (дольше HOLD_MAX_MS) — не ждём снова, пока не загрузится */
  skipped: Set<number>;
};
const live = new Map<string, Live>();
const liveOf = (id: string) => {
  let l = live.get(id);
  if (!l) live.set(id, (l = { presence: new Map(), actions: [], holdTimers: new Map(), skipped: new Set() }));
  return l;
};

const userName = (id: number) => db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? "?";
const roomRow = (id: string) => db.prepare<[string], RoomRow>("SELECT * FROM watch_rooms WHERE id = ?").get(id);
const memberRows = (id: string) => db.prepare<[string], MemberRow>("SELECT user_id, status, control FROM watch_room_members WHERE room_id = ? ORDER BY joined_at").all(id);
const isActive = (r: RoomRow) => r.ended_at === null && r.last_activity > now() - ROOM_IDLE;

function view(r: RoomRow, me: number): RoomView {
  const l = liveOf(r.id);
  return {
    id: r.id, anilistId: r.anilist_id, ownerId: r.owner_id, preset: r.preset, state: JSON.parse(r.state) as RoomState,
    members: memberRows(r.id).map((m) => {
      const p = l.presence.get(m.user_id);
      return {
        id: m.user_id, name: userName(m.user_id), status: m.status, host: m.user_id === r.owner_id, control: Boolean(m.control),
        presence: p ? { online: p.online, buffering: p.buffering, bw: p.bw, rtt: p.rtt, drift: p.drift, seenAt: p.seenAt } : null,
      };
    }),
    actions: l.actions.slice(-ACTIONS_KEPT), ended: !isActive(r), me,
  };
}

/** Что-то поменялось — открытые страницы участников перечитают снимок. */
const changed = (id: string) => roomEvents.emit(id);

function log(id: string, userId: number, kind: RoomActionKind, pos: number | null, ep?: number) {
  const l = liveOf(id);
  l.actions.push({ userId, kind, pos: pos === null ? null : Math.round(pos), ep, at: Date.now() });
  if (l.actions.length > ACTIONS_KEPT * 2) l.actions.splice(0, l.actions.length - ACTIONS_KEPT);
}

function saveState(id: string, s: RoomState) {
  db.prepare("UPDATE watch_rooms SET state = ?, last_activity = ? WHERE id = ?").run(JSON.stringify(s), now(), id);
}

/** Комната, где пользователь участник; не участник или комната закончилась — ошибка. */
function mine(userId: number, id: string, statuses: RoomMember["status"][] = ["joined"]) {
  const r = roomRow(id);
  if (!r || !isActive(r)) throw new ApiError(404, "Комната закончилась");
  const m = memberRows(id).find((x) => x.user_id === userId);
  if (!m || !statuses.includes(m.status)) throw new ApiError(403, "Вы не в этой комнате");
  return { r, m };
}

export function roomView(userId: number, id: string): RoomView {
  const { r } = mine(userId, id, ["joined", "invited", "left"]);
  return view(r, userId);
}

/** Комната тайтла, где пользователь вошёл или приглашён (вошёл — важнее). */
export function roomForTitle(userId: number, anilistId: number): RoomView | null {
  const rows = db.prepare<[number, number, number], RoomRow & { status: string }>(
    `SELECT r.*, m.status FROM watch_rooms r JOIN watch_room_members m ON m.room_id = r.id
     WHERE m.user_id = ? AND r.anilist_id = ? AND r.ended_at IS NULL AND r.last_activity > ? AND m.status IN ('joined', 'invited')
     ORDER BY m.status = 'joined' DESC, r.last_activity DESC`).all(userId, anilistId, now() - ROOM_IDLE);
  return rows[0] ? view(rows[0], userId) : null;
}

/** Друзья — кого можно позвать. */
export const inviteable = (userId: number) => friendIds(userId).map((id) => ({ id, name: userName(id) }));

function invite(by: { id: number; name: string }, r: RoomRow, ids: number[]) {
  const have = new Map(memberRows(r.id).map((m) => [m.user_id, m.status]));
  const state = JSON.parse(r.state) as RoomState;
  const m = getMedia(r.anilist_id);
  const href = `/anime/${r.anilist_id}/watch/${state.ep}?room=${r.id}`;
  for (const uid of new Set(ids)) {
    if (uid === by.id || have.get(uid) === "joined" || !areFriends(by.id, uid)) continue;
    db.prepare(`INSERT INTO watch_room_members (room_id, user_id, status, invited_by, joined_at) VALUES (?, ?, 'invited', ?, ?)
      ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'invited', invited_by = excluded.invited_by`).run(r.id, uid, by.id, Date.now());
    notify(uid, {
      kind: "room", anilistId: r.anilist_id, actorId: by.id, title: `${by.name} зовёт смотреть вместе`,
      body: `${m ? `${displayTitle(m.title)}, ` : ""}${state.ep} серия`, href,
      actions: [{ type: "link", label: "Присоединиться", href }],
    });
  }
}

/** Создать комнату (прежние комнаты создателя по этому тайтлу заканчиваются) и позвать друзей. */
export function createRoom(owner: { id: number; name: string }, anilistId: number, ep: number, ids: number[], pos = 0, playing = false): RoomView {
  db.prepare("UPDATE watch_rooms SET ended_at = ? WHERE owner_id = ? AND anilist_id = ? AND ended_at IS NULL").run(now(), owner.id, anilistId);
  const id = randomBytes(6).toString("base64url");
  const state: RoomState = { ep, playing, pos: Math.max(0, pos), at: Date.now(), hold: [] };
  db.prepare("INSERT INTO watch_rooms (id, owner_id, anilist_id, preset, state, created_at, last_activity) VALUES (?, ?, ?, 'equal', ?, ?, ?)")
    .run(id, owner.id, anilistId, JSON.stringify(state), now(), now());
  db.prepare("INSERT INTO watch_room_members (room_id, user_id, status, control, joined_at) VALUES (?, ?, 'joined', 1, ?)").run(id, owner.id, Date.now());
  log(id, owner.id, "join", null);
  invite(owner, roomRow(id)!, ids);
  return view(roomRow(id)!, owner.id);
}

export type RoomCommand =
  | { action: "join" | "leave" | "decline" | "end" }
  | { action: "invite"; users: number[] }
  | { action: "preset"; preset: RoomPreset }
  | { action: "grant"; user: number; control: boolean }
  | { action: "play" | "pause" | "seek"; pos: number }
  | { action: "ep"; ep: number };

export function roomCommand(user: { id: number; name: string }, id: string, c: RoomCommand): RoomView {
  if (c.action === "join" || c.action === "decline") {
    const { r } = mine(user.id, id, ["invited", "left", "joined"]);
    if (c.action === "join") {
      // Одна комната за раз: из других — выйти
      for (const o of db.prepare<[number, string], { room_id: string }>(
        "SELECT room_id FROM watch_room_members WHERE user_id = ? AND status = 'joined' AND room_id != ?").all(user.id, id)) leave(user.id, o.room_id);
      db.prepare("UPDATE watch_room_members SET status = 'joined' WHERE room_id = ? AND user_id = ?").run(id, user.id);
      log(id, user.id, "join", null);
    } else {
      db.prepare("DELETE FROM watch_room_members WHERE room_id = ? AND user_id = ? AND status = 'invited'").run(id, user.id);
    }
    changed(id);
    return view(roomRow(r.id)!, user.id);
  }
  const { r, m } = mine(user.id, id);
  const state = JSON.parse(r.state) as RoomState;
  const isOwner = r.owner_id === user.id;
  switch (c.action) {
    case "leave":
      leave(user.id, id);
      break;
    case "end":
      if (!isOwner) throw new ApiError(403, "Закончить комнату может только организатор");
      db.prepare("UPDATE watch_rooms SET ended_at = ? WHERE id = ?").run(now(), id);
      break;
    case "invite":
      if (r.preset === "host" && !canControl(r.preset, { host: isOwner, control: Boolean(m.control), status: m.status })) throw new ApiError(403, "Звать может организатор");
      invite(user, r, c.users.map(Number));
      break;
    case "preset":
      if (!isOwner) throw new ApiError(403, "Пресет меняет организатор");
      db.prepare("UPDATE watch_rooms SET preset = ? WHERE id = ?").run(c.preset === "host" ? "host" : "equal", id);
      break;
    case "grant":
      if (!isOwner) throw new ApiError(403, "Права раздаёт организатор");
      db.prepare("UPDATE watch_room_members SET control = ? WHERE room_id = ? AND user_id = ?").run(c.control ? 1 : 0, id, Number(c.user));
      break;
    case "play": case "pause": case "seek": case "ep": {
      if (!canControl(r.preset, { host: isOwner, control: Boolean(m.control), status: m.status })) throw new ApiError(403, "Управляет организатор комнаты");
      const t = Date.now();
      let next: RoomState;
      if (c.action === "ep") {
        if (!Number.isInteger(c.ep) || c.ep < 1) throw new ApiError(400, "Неверная серия");
        next = { ep: c.ep, playing: false, pos: 0, at: t, hold: [] };
        log(id, user.id, "ep", null, c.ep);
      } else {
        const pos = Math.max(0, Number(c.pos) || 0);
        log(id, user.id, c.action, pos);
        if (c.action === "seek") next = { ...state, pos, at: t };
        else {
          // Пауза снимает ожидание; «смотреть» — ждём тех, кто ещё грузится (скажем, только открыл серию), а во время
          // ожидания — смотреть без них
          clearHolds(id);
          if (c.action === "play") for (const u of state.hold) liveOf(id).skipped.add(u);
          const loading = c.action === "play" && !state.hold.length ? loadingMembers(id) : [];
          next = { ...state, playing: c.action === "play" && !loading.length, pos, at: t, hold: loading };
          for (const u of loading) holdTimer(id, u);
        }
      }
      saveState(id, next);
    }
  }
  changed(id);
  return view(roomRow(id)!, user.id);
}

function leave(userId: number, id: string) {
  db.prepare("UPDATE watch_room_members SET status = 'left' WHERE room_id = ? AND user_id = ?").run(id, userId);
  log(id, userId, "leave", null);
  release(id, userId);
  const r = roomRow(id);
  // Вышли все — комната закончилась
  if (r && !memberRows(id).some((m) => m.status === "joined")) db.prepare("UPDATE watch_rooms SET ended_at = ? WHERE id = ?").run(now(), id);
  changed(id);
}

/** Кто из вошедших и подключённых сейчас грузится (и кого ещё ждём). */
function loadingMembers(id: string) {
  const l = liveOf(id);
  const joined = new Set(memberRows(id).filter((m) => m.status === "joined").map((m) => m.user_id));
  return [...l.presence].filter(([u, p]) => joined.has(u) && p.online && p.buffering && !l.skipped.has(u)).map(([u]) => u);
}

const holdTimer = (id: string, userId: number) => liveOf(id).holdTimers.set(userId, setTimeout(() => release(id, userId, "skip"), HOLD_MAX_MS));

function clearHolds(id: string) {
  const l = liveOf(id);
  for (const t of l.holdTimers.values()) clearTimeout(t);
  l.holdTimers.clear();
}

/** Участник больше не грузится (или ждать его хватит) — убрать из ожидания; ждать больше некого — смотреть дальше. */
function release(id: string, userId: number, kind: "resume" | "skip" = "resume") {
  const r = roomRow(id);
  if (!r) return;
  const s = JSON.parse(r.state) as RoomState;
  const l = liveOf(id);
  clearTimeout(l.holdTimers.get(userId));
  l.holdTimers.delete(userId);
  if (kind === "skip") l.skipped.add(userId);
  if (!s.hold.includes(userId)) return;
  const hold = s.hold.filter((u) => u !== userId);
  saveState(id, hold.length ? { ...s, hold } : { ...s, hold, playing: true, at: Date.now() });
  log(id, userId, kind, s.pos);
  changed(id);
}

/** Плеер участника сообщает о себе (раз в несколько секунд и когда начал/перестал грузиться). Ответ — часы сервера. */
export function roomReport(userId: number, id: string, p: { buffering?: boolean; bw?: number | null; rtt?: number | null; drift?: number | null }) {
  const { r } = mine(userId, id);
  const l = liveOf(id);
  const cur = l.presence.get(userId) ?? { online: true, buffering: false, bw: null, rtt: null, drift: null, seenAt: 0, conns: 0 };
  const buffering = Boolean(p.buffering);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  l.presence.set(userId, { ...cur, buffering, bw: num(p.bw), rtt: num(p.rtt), drift: num(p.drift), seenAt: Date.now() });
  const s = JSON.parse(r.state) as RoomState;
  if (buffering && s.playing && !l.skipped.has(userId)) {
    // Кто-то грузится, пока смотрим, — пауза у всех, ждём его (не дольше HOLD_MAX_MS)
    const t = Date.now();
    saveState(id, { ...s, playing: false, pos: positionAt(s, t), at: t, hold: [...s.hold, userId] });
    log(id, userId, "hold", positionAt(s, t));
    holdTimer(id, userId);
  } else if (buffering && s.hold.length && !s.hold.includes(userId) && !l.skipped.has(userId)) {
    // Уже ждём кого-то — подождём и этого
    saveState(id, { ...s, hold: [...s.hold, userId] });
    holdTimer(id, userId);
  } else if (!buffering) {
    l.skipped.delete(userId);
    release(id, userId);
  }
  changed(id);
  return { now: Date.now() };
}

/** Страница участника открыла/закрыла поток событий — «в сети». */
export function roomPresence(userId: number, id: string, online: boolean) {
  const l = liveOf(id);
  const cur = l.presence.get(userId) ?? { online: false, buffering: false, bw: null, rtt: null, drift: null, seenAt: 0, conns: 0 };
  const conns = Math.max(0, cur.conns + (online ? 1 : -1));
  l.presence.set(userId, { ...cur, conns, online: conns > 0, buffering: conns > 0 && cur.buffering, seenAt: Date.now() });
  if (!conns) release(id, userId, "skip");
  changed(id);
}

/** Можно ли слушать комнату (вошёл или приглашён). */
export function roomListener(userId: number, id: string) {
  return mine(userId, id, ["joined", "invited", "left"]).m;
}
