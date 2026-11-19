import "server-only";
import { groupAccess, requireGroupCapability } from "./group-policy";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  canControl, positionAt, type RoomAction, type RoomActionKind, type RoomMember, type RoomPreset, type RoomPresence,
  type RoomState, type RoomView,
} from "@/lib/room";
import { displayTitle } from "@/lib/schedule";
import { db, now } from "./db";
import { getMedia } from "./lists";
import { notify } from "./notifications";
import { ApiError } from "./route";
import { areFriends, friendIds } from "./social";
import { advanceSession, finishSessionEpisode, nextSessionItem } from "@/lib/session-playback";
import { episodeAvailability, legacyBlocks, type SessionDraft } from "@/lib/session-plan";

// Комнаты совместного просмотра (TASKS 9.4а). Состояние комнаты (серия, пауза, позиция на момент at) — в базе,
// связь участников (в сети, грузится, скорость, задержка) и последние действия — в памяти: это живое, после
// перезапуска восстановится само. Изменения рассылаются через roomEvents — SSE /api/rooms/<id>/events.

/** Комната без действий дольше — закончилась. */
const ROOM_IDLE = 6 * 3600;
const ACTIONS_KEPT = 30;

// Next may bundle instrumentation/jobs and API routes separately in the same process.
// Both must see the same presence barrier and event bus.
const runtimeGlobal = globalThis as unknown as { __watchRoomRuntime?: { events: EventEmitter; live: Map<string, Live> } };
const runtime = runtimeGlobal.__watchRoomRuntime ??= { events: new EventEmitter(), live: new Map() };
export const roomEvents = runtime.events;
roomEvents.setMaxListeners(0);

type RoomRow = {
  id: string; owner_id: number; anilist_id: number; preset: RoomPreset; state: string; last_activity: number; ended_at: number | null;
  group_id: number | null; session_id: number | null;
};
type MemberRow = { user_id: number; status: RoomMember["status"]; control: number };

type Live = {
  presence: Map<number, RoomPresence & { conns: number }>;
  actions: RoomAction[];
  holdTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Управляющий продолжил без зрителя — не ждём снова до его возвращения */
  skipped: Set<number>;
};
const live = runtime.live;
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
  const access = r.group_id ? groupAccess(r.group_id, me) : null;
  return {
    id: r.id, anilistId: r.anilist_id, ownerId: r.owner_id, preset: access ? "host" : r.preset, state: JSON.parse(r.state) as RoomState,
    members: memberRows(r.id).map((m) => {
      const p = l.presence.get(m.user_id);
      return {
        id: m.user_id, name: userName(m.user_id), status: m.status, host: access ? false : m.user_id === r.owner_id, control: access ? m.user_id === me && access.can("play") : Boolean(m.control),
        presence: p ? { online: p.online, buffering: p.buffering, bw: p.bw, rtt: p.rtt, drift: p.drift, seenAt: p.seenAt } : null,
      };
    }),
    groupId: r.group_id, canInvite: access ? access.can("invite") : undefined,
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
  if (s.playing && s.session) db.prepare("UPDATE group_sessions SET actual_started_at=COALESCE(actual_started_at,?) WHERE id=?").run(now(),s.session.sessionId);
  if (s.session) s = { ...s, session: { ...s.session, heartbeatAt: Date.now() } };
  db.prepare("UPDATE watch_rooms SET state = ?, last_activity = ? WHERE id = ?").run(JSON.stringify(s), now(), id);
}

function moveSession(r: RoomRow, state: RoomState) {
  const p = state.session!;
  const target = nextSessionItem(p);
  if (!target) return;
  const media = getMedia(target.anilistId);
  if (!media || !episodeAvailability(media, target.ep, now()).selectable) {
    saveState(r.id, { ...state, playing: false, session: { ...p, autoplay: false, blocked: "Следующая серия ещё не вышла или дата выхода неизвестна", revision: p.revision + 1 } });
    return;
  }
  const session = advanceSession(p);
  moveEpisode(r,state,target.anilistId,target.ep,session);
}

function moveEpisode(r:RoomRow,state:RoomState,title:number,ep:number,session=state.session) {
  const media=getMedia(title);
  if(!media || !episodeAvailability(media,ep,now()).selectable) throw new ApiError(400,"Серия ещё не вышла или дата выхода неизвестна");
  clearHolds(r.id);
  const l = liveOf(r.id);
  // Only viewers actually connected to this playback are part of the load barrier.
  const currentMembers = r.group_id ? groupMembers(r.group_id) : null;
  const hold = memberRows(r.id).filter(m => m.status === "joined" && (!currentMembers || currentMembers.has(m.user_id)) && l.presence.get(m.user_id)?.online && !l.skipped.has(m.user_id)).map(m => m.user_id);
  db.prepare("UPDATE watch_rooms SET anilist_id = ? WHERE id = ?").run(title, r.id);
  saveState(r.id, { ...state, ep: ep, playing: !hold.length, pos: 0, at: Date.now(), hold, session, generation:(state.generation??0)+1 });
}

/** Server clock owns the countdown. Called by the job loop, not by the viewers. */
export function roomSessionTick() {
  const rows = db.prepare<[], { id: string }>("SELECT r.id FROM watch_rooms r JOIN group_sessions s ON s.id = r.session_id WHERE s.status = 'live' AND r.ended_at IS NULL").all();
  for (const { id } of rows) {
    let updated = false;
    db.transaction(() => {
      db.prepare("UPDATE watch_rooms SET state = state WHERE id = ?").run(id);
      const r = roomRow(id);
      if (!r || !isActive(r)) return;
      const s = JSON.parse(r.state) as RoomState;
      const p = s.session;
      if (!p || p.phase === "complete") return;
      const t = Date.now();
      if (p.heartbeatAt && t - p.heartbeatAt > 15000) {
        saveState(id, { ...s, playing: false, pos: positionAt(s, p.heartbeatAt), at: t, hold: [], session: { ...p, autoplay: false, heartbeatAt: t, revision: p.revision + 1 } });
        updated = true;
        return;
      }
      // Persist the last coordinated position boundary, without extending room idle lifetime.
      if (!p.heartbeatAt || t - p.heartbeatAt >= 5000) {
        p.heartbeatAt = t;
        db.prepare("UPDATE watch_rooms SET state = ? WHERE id = ?").run(JSON.stringify(s), id);
      }
      if (p.phase === "watching" || !p.autoplay || p.deadline === null || p.deadline > t) return;
      moveSession(r, s);
      updated = true;
    })();
    if (updated) changed(id);
  }
}

/** Комната, где пользователь участник; не участник или комната закончилась — ошибка. */
function mine(userId: number, id: string, statuses: RoomMember["status"][] = ["joined"]) {
  const r = roomRow(id);
  if (!r || !isActive(r)) throw new ApiError(404, "Комната закончилась");
  if (r.group_id) groupAccess(r.group_id, userId);
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

/** Участники группы комнаты (их можно звать и без дружбы с тем, кто зовёт). */
const groupMembers = (groupId: number | null) => new Set(groupId === null ? [] : db.prepare<[number], { user_id: number }>(
  "SELECT user_id FROM shared_list_members WHERE list_id = ? AND status = 'member'").all(groupId).map((r) => r.user_id));

function invite(by: { id: number; name: string }, r: RoomRow, ids: number[]) {
  const group = groupMembers(r.group_id);
  if (r.group_id && ids.some(uid => !group.has(uid))) throw new ApiError(400, "Сначала пригласите пользователя в группу и дождитесь его вступления");
  const have = new Map(memberRows(r.id).map((m) => [m.user_id, m.status]));
  const state = JSON.parse(r.state) as RoomState;
  const m = getMedia(r.anilist_id);
  const href = `/anime/${r.anilist_id}/watch/${state.ep}?room=${r.id}`;
  for (const uid of new Set(ids)) {
    if (uid === by.id || have.get(uid) === "joined" || !(r.group_id ? group.has(uid) : areFriends(by.id, uid))) continue;
    db.prepare(`INSERT INTO watch_room_members (room_id, user_id, status, invited_by, joined_at) VALUES (?, ?, 'invited', ?, ?)
      ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'invited', invited_by = excluded.invited_by`).run(r.id, uid, by.id, Date.now());
    notify(uid, {
      kind: "room", anilistId: r.anilist_id, actorId: by.id, title: `${by.name} зовёт смотреть вместе`,
      body: `${m ? `${displayTitle(m.title)}, ` : ""}${state.ep} серия`, href,
      actions: [{ type: "link", label: "Присоединиться", href }],
    });
  }
}

/** Комната группы: пресет и пульт — от группы, звать — всех участников. */
export type RoomGroup = { id: number; sessionId?: number; preset: RoomPreset; control: number[] };

/** Создать комнату (прежние комнаты создателя по этому тайтлу заканчиваются) и позвать друзей (или группу). */
export function createRoom(owner: { id: number; name: string }, anilistId: number, ep: number, ids: number[], pos = 0, playing = false, group?: RoomGroup): RoomView {
  if (group) {
    groupAccess(group.id, owner.id);
    const members = groupMembers(group.id);
    if (ids.some(uid => !members.has(uid))) throw new ApiError(400, "Сначала пригласите пользователя в группу и дождитесь его вступления");
  }
  db.prepare("UPDATE watch_rooms SET ended_at = ? WHERE owner_id = ? AND anilist_id = ? AND ended_at IS NULL").run(now(), owner.id, anilistId);
  const id = randomBytes(6).toString("base64url");
  const state: RoomState = { ep, playing, pos: Math.max(0, pos), at: Date.now(), hold: [] };
  if (group?.sessionId) {
    const plan = db.prepare<[number, number], { plan_json: string | null; anilist_id: number; ep: number; count: number }>("SELECT plan_json, anilist_id, ep, count FROM group_sessions WHERE id = ? AND list_id = ?").get(group.sessionId, group.id);
    if (!plan) throw new ApiError(400, "План сеанса не найден");
    const blocks = plan.plan_json ? (JSON.parse(plan.plan_json) as SessionDraft).blocks : legacyBlocks({ anilistId: plan.anilist_id, ep: plan.ep, count: plan.count });
    state.session = { sessionId: group.sessionId, blocks, block: 0, episode: 0, revision: 1, phase: "watching", deadline: null, autoplay: true, heartbeatAt: Date.now() };
  }
  db.prepare(`INSERT INTO watch_rooms (id, owner_id, anilist_id, preset, state, created_at, last_activity, group_id, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner.id, anilistId, group?.preset ?? "equal", JSON.stringify(state), now(), now(), group?.id ?? null, group?.sessionId ?? null);
  db.prepare("INSERT INTO watch_room_members (room_id, user_id, status, control, joined_at) VALUES (?, ?, 'joined', 1, ?)").run(id, owner.id, Date.now());
  log(id, owner.id, "join", null);
  // Группа без списка — зовём всех её участников (у сеанса — кроме ответивших «не приду»)
  invite(owner, roomRow(id)!, group && !ids.length ? [...groupMembers(group.id)] : ids);
  // Пульт — у тех, кому его дал организатор группы
  if (group) for (const u of group.control) db.prepare("UPDATE watch_room_members SET control = 1 WHERE room_id = ? AND user_id = ?").run(id, u);
  return view(roomRow(id)!, owner.id);
}

export type RoomCommand = { expectedGeneration?:number; expectedTitle?:number; expectedEp?:number } & (
  | { action: "session-ended"; revision: number; anilistId: number; ep: number; duration: number }
  | { action: "session-next"; revision: number }
  | { action: "session-autoplay"; revision: number; enabled: boolean }
  | { action: "join" | "leave" | "decline" | "end" }
  | { action: "invite"; users: number[] }
  | { action: "preset"; preset: RoomPreset }
  | { action: "grant"; user: number; control: boolean }
  | { action: "play" | "pause" | "seek"; pos: number }
  | { action: "ep"; ep: number });

export function roomCommand(user: { id: number; name: string }, id: string, c: RoomCommand): RoomView {
  const result = db.transaction(() => {
    db.prepare("UPDATE watch_rooms SET state = state WHERE id = ?").run(id);
    return commandLocked(user, id, c);
  })();
  changed(id);
  return result;
}

function commandLocked(user: { id: number; name: string }, id: string, c: RoomCommand): RoomView {
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
  if ((c.expectedGeneration!==undefined && c.expectedGeneration!==(state.generation??0)) || (c.expectedTitle!==undefined && c.expectedTitle!==r.anilist_id) || (c.expectedEp!==undefined && c.expectedEp!==state.ep)) return view(r,user.id);
  if (c.action === "session-ended" || c.action === "session-next" || c.action === "session-autoplay") {
    const p = state.session;
    if (!p) throw new ApiError(400, "В комнате нет плана сеанса");
    if (c.revision !== p.revision) return view(r, user.id); // Idempotent stale notification.
    if (c.action !== "session-ended" && (r.group_id ? !groupAccess(r.group_id, user.id).can("play") : !canControl(r.preset, { host: isOwner, control: Boolean(m.control), status: m.status }))) throw new ApiError(403, "Управляет организатор комнаты");
    if (c.action === "session-ended") {
      if (p.phase !== "watching" || c.anilistId !== r.anilist_id || c.ep !== state.ep) return view(r, user.id);
      // A real ended event from a joined viewer; reject old/early timeline reports.
      if (!Number.isFinite(c.duration) || c.duration <= 0 || c.duration > 86400 || positionAt(state, Date.now()) < c.duration - 5) throw new ApiError(409, "Комната ещё не дошла до конца серии");
      const next = finishSessionEpisode(p, Date.now());
      clearHolds(id);
      saveState(id, { ...state, playing: false, pos: c.duration, at: Date.now(), hold: [], session: next });
      if (next.phase === "complete") db.prepare("UPDATE group_sessions SET status = 'done' WHERE id = ? AND room_id = ?").run(p.sessionId, id);
    } else if (c.action === "session-autoplay") {
      if (typeof c.enabled !== "boolean" || p.phase === "complete") throw new ApiError(400, "Неверное состояние автовоспроизведения");
      saveState(id, { ...state, session: { ...p, autoplay: c.enabled, revision: p.revision + 1 } });
    } else if (p.phase !== "complete") {
      // Manual next uses the same planned successor, never ep + 1.
      const target=nextSessionItem(p);
      if(p.phase==="watching" && target && target.block!==p.block && p.blocks[p.block].breakMinutes>0) {
        clearHolds(id);
        saveState(id,{...state,playing:false,pos:positionAt(state,Date.now()),at:Date.now(),hold:[],session:finishSessionEpisode(p,Date.now())});
      } else moveSession(r, state);
    }
    return view(roomRow(id)!, user.id);
  }
  switch (c.action) {
    case "leave":
      leave(user.id, id);
      break;
    case "end":
      if (!isOwner) throw new ApiError(403, "Закончить комнату может только организатор");
      db.prepare("UPDATE watch_rooms SET ended_at = ? WHERE id = ?").run(now(), id);
      break;
    case "invite":
      if (r.group_id) requireGroupCapability(r.group_id, user.id, "invite");
      if (!r.group_id && r.preset === "host" && !canControl(r.preset, { host: isOwner, control: Boolean(m.control), status: m.status })) throw new ApiError(403, "Звать может организатор");
      invite(user, r, c.users.map(Number));
      break;
    case "preset":
      if (r.group_id) throw new ApiError(400, "Права меняются в настройках комнаты группы");
      if (!isOwner) throw new ApiError(403, "Пресет меняет организатор");
      db.prepare("UPDATE watch_rooms SET preset = ? WHERE id = ?").run(c.preset === "host" ? "host" : "equal", id);
      break;
    case "grant":
      if (r.group_id) throw new ApiError(400, "Права меняются в настройках комнаты группы");
      if (!isOwner) throw new ApiError(403, "Права раздаёт организатор");
      db.prepare("UPDATE watch_room_members SET control = ? WHERE room_id = ? AND user_id = ?").run(c.control ? 1 : 0, id, Number(c.user));
      break;
    case "play": case "pause": case "seek": case "ep": {
      if (r.group_id ? !groupAccess(r.group_id, user.id).can("play") : !canControl(r.preset, { host: isOwner, control: Boolean(m.control), status: m.status })) throw new ApiError(403, "Управляет организатор комнаты");
      const t = Date.now();
      let next: RoomState;
      if (c.action === "ep") {
        if (!Number.isInteger(c.ep) || c.ep < 1) throw new ApiError(400, "Неверная серия");
        if(c.ep===state.ep)return view(r,user.id);
        let session=state.session;
        if(session){
          // Keep the saved plan intact; explicit picks adjust only this live execution snapshot.
          const blocks=session.blocks.map(b=>({...b,episodes:[...b.episodes]}));
          const block=session.block;
          let episode=blocks[block].episodes.indexOf(c.ep);
          if(episode<0){episode=session.episode+1;blocks[block].episodes.splice(episode,0,c.ep);}
          session={...session,blocks,episode,phase:"watching",deadline:null,blocked:undefined,revision:session.revision+1};
        }
        moveEpisode(r,state,r.anilist_id,c.ep,session);
        log(id,user.id,"ep",null,c.ep);
        return view(roomRow(id)!,user.id);
      } else {
        if (state.session && state.session.phase !== "watching") throw new ApiError(409, "Сейчас переход по плану сеанса; используйте управление отсчётом");
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

const holdTimer = (_id: string, _userId: number) => {
  // A viewer is excluded only by an explicit controller action, never by a timer.
};

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
  saveState(id, hold.length ? { ...s, hold } : { ...s, hold, playing: !s.session || s.session.phase === "watching", at: Date.now() });
  log(id, userId, kind, s.pos);
  changed(id);
}

/** Плеер участника сообщает о себе (раз в несколько секунд и когда начал/перестал грузиться). Ответ — часы сервера. */
export function roomReport(userId: number, id: string, p: { position?: number; buffered?: unknown; buffering?: boolean; bw?: number | null; rtt?: number | null; drift?: number | null; revision?: number; anilistId?: number; ep?: number }) {
  return db.transaction(() => {
    db.prepare("UPDATE watch_rooms SET state = state WHERE id = ?").run(id);
    return reportLocked(userId, id, p);
  })();
}
function reportLocked(userId: number, id: string, p: { position?: number; buffered?: unknown; buffering?: boolean; bw?: number | null; rtt?: number | null; drift?: number | null; revision?: number; anilistId?: number; ep?: number }) {
  const { r } = mine(userId, id);
  const s = JSON.parse(r.state) as RoomState;
  if ((s.generation??0)>0 && (p.anilistId!==r.anilist_id || p.ep!==s.ep || p.revision!==(s.session?.revision??s.generation))) return {now:Date.now()};
  if (s.session && (s.session.phase !== "watching" || p.revision !== s.session.revision || p.anilistId !== r.anilist_id || p.ep !== s.ep)) return { now: Date.now() };
  const l = liveOf(id);
  const cur = l.presence.get(userId) ?? { online: true, buffering: false, bw: null, rtt: null, drift: null, seenAt: 0, conns: 0 };
  const buffering = Boolean(p.buffering);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const buffered: [number, number][] = Array.isArray(p.buffered) ? p.buffered.slice(0,16).filter((v): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86400) && v[1] >= v[0]) : [];
  l.presence.set(userId, { ...cur, position: typeof p.position === "number" && Number.isFinite(p.position) ? Math.max(0, Math.min(86400, p.position)) : null, buffered, buffering, bw: num(p.bw), rtt: num(p.rtt), drift: num(p.drift), seenAt: Date.now() });
  if (buffering && s.playing && !l.skipped.has(userId)) {
    // Кто-то грузится, пока смотрим, — пауза у всех, ждём восстановления или команды управляющего
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
  if (!conns && cur.conns > 0 && memberRows(id).some(m => m.user_id === userId && m.status === "joined")) {
    const r = roomRow(id);
    const s = r ? JSON.parse(r.state) as RoomState : null;
    if (s && (r?.group_id || s.session)) {
      if ((s.playing || s.hold.length > 0) && (!s.session || s.session.phase === "watching") && !l.skipped.has(userId) && !s.hold.includes(userId)) {
        saveState(id, { ...s, playing: false, pos: positionAt(s, Date.now()), at: Date.now(), hold: [...s.hold, userId] });
      }
    } else release(id, userId, "skip");
  }
  changed(id);
}

/** Можно ли слушать комнату (вошёл или приглашён). */
export function roomListener(userId: number, id: string) {
  return mine(userId, id, ["joined", "invited", "left"]).m;
}

/** Комната закончилась (или её нет) — сеанс группы завершён. */
export function roomEnded(id: string) {
  const r = roomRow(id);
  return !r || !isActive(r);
}
