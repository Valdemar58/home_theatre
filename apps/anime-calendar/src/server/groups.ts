import "server-only";
import {
  groupProgress, pollWinner, sessionDue, sessionEps, SESSION_MAX_EPS, type GroupPlan, type GroupPoll, type GroupSession, type Rsvp,
} from "@/lib/groups";
import type { RoomPreset } from "@/lib/room";
import { displayTitle } from "@/lib/schedule";
import { db, now } from "./db";
import { getMedia } from "./lists";
import { notify } from "./notifications";
import { episodeItems } from "./playback";
import { createRoom, roomEnded } from "./rooms";
import { ApiError } from "./route";
import { setVoicePref, voicePref } from "./stream-voices";
import { startTask } from "./tasks";
import { itemsOf, listRow, membersOf, requireMember } from "./together";

// Группа просмотра (TASKS 9.4в) — общий список, который смотрят вместе: пресет управления комнатой и пульт, очередь
// с прогрессом группы и её озвучкой, сеансы по расписанию (за час — подготовка серий и озвучки, за 15 минут —
// напоминание, в начале — комната группы), голосование, что смотреть. Раз в минуту — groupTick (jobs.ts).

type SessionRow = {
  id: number; list_id: number; anilist_id: number; ep: number; count: number; starts_at: number; created_by: number;
  status: GroupSession["status"]; room_id: string | null; prepared: number; reminded: number;
};
type PollRow = { id: number; list_id: number; created_by: number; created_at: number; closes_at: number; closed_at: number | null; winner: number | null };

const userName = (id: number) => db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? "?";
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const titleOf = (anilistId: number) => { const m = getMedia(anilistId); return m ? displayTitle(m.title) : `#${anilistId}`; };
const activeMembers = (listId: number) => membersOf(listId).filter((m) => m.status === "member").map((m) => m.user_id);

function groupRow(listId: number) {
  const l = listRow(listId);
  if (!l) throw new ApiError(404, "Группа не найдена");
  const preset = (db.prepare<[number], { preset: RoomPreset }>("SELECT preset FROM shared_lists WHERE id = ?").get(listId)?.preset ?? "equal");
  const control = db.prepare<[number], { user_id: number }>("SELECT user_id FROM shared_list_members WHERE list_id = ? AND control = 1").all(listId).map((r) => r.user_id);
  return { ...l, preset, control };
}

/** Назначать сеансы и голосования: все равны — любой участник, пресет «организатор» — он и те, кому дал пульт. */
function canPlan(g: ReturnType<typeof groupRow>, userId: number) {
  return g.preset === "equal" || g.owner_id === userId || g.control.includes(userId);
}

/** Сказать участникам группы (кроме автора). */
function tell(listId: number, except: number | null, n: { title: string; body?: string; anilistId?: number; actorId?: number }) {
  for (const u of activeMembers(listId)) if (u !== except) notify(u, { kind: "group", href: `/lists/shared/${listId}`, subject: listRow(listId)?.name ?? null, ...n });
}

const sessionView = (s: SessionRow): GroupSession => ({
  id: s.id, anilistId: s.anilist_id, ep: s.ep, count: s.count, startsAt: s.starts_at, createdBy: s.created_by, status: s.status, roomId: s.room_id,
  rsvp: db.prepare<[number], { user_id: number; answer: Rsvp }>("SELECT user_id, answer FROM group_rsvp WHERE session_id = ?").all(s.id)
    .map((r) => ({ userId: r.user_id, answer: r.answer })),
});

function pollView(p: PollRow): GroupPoll {
  const votes = db.prepare<[number], { user_id: number; anilist_id: number }>("SELECT user_id, anilist_id FROM group_poll_votes WHERE poll_id = ?").all(p.id);
  return {
    id: p.id, createdBy: p.created_by, createdAt: p.created_at, closesAt: p.closes_at, closedAt: p.closed_at, winner: p.winner,
    options: db.prepare<[number], { anilist_id: number }>("SELECT anilist_id FROM group_poll_options WHERE poll_id = ? ORDER BY ord").all(p.id)
      .map((o) => ({ anilistId: o.anilist_id, votes: votes.filter((v) => v.anilist_id === o.anilist_id).map((v) => v.user_id) })),
  };
}

export function groupPlan(userId: number, listId: number): GroupPlan {
  requireMember(listId, userId);
  const g = groupRow(listId);
  const items = itemsOf(listId, membersOf(listId));
  const queued = db.prepare<[number], { anilist_id: number; voice: string | null }>(
    "SELECT anilist_id, voice FROM shared_list_items WHERE list_id = ? AND queue_pos IS NOT NULL ORDER BY queue_pos").all(listId);
  const sessions = db.prepare<[number, number], SessionRow>(
    `SELECT * FROM group_sessions WHERE list_id = ? AND (status IN ('planned', 'live') OR starts_at > ?) ORDER BY starts_at`).all(listId, now() - 7 * 86400);
  // Голосование: открытое, иначе недавно закрытое (показать итог)
  const poll = db.prepare<[number, number], PollRow>(
    "SELECT * FROM group_polls WHERE list_id = ? AND (closed_at IS NULL OR closed_at > ?) ORDER BY id DESC LIMIT 1").get(listId, now() - 3 * 86400);
  return {
    preset: g.preset, control: g.control, canPlan: canPlan(g, userId),
    sessions: sessions.map(sessionView),
    poll: poll ? pollView(poll) : null,
    queue: queued.map((q) => {
      const it = items.find((i) => i.media.id === q.anilist_id);
      return { anilistId: q.anilist_id, voice: q.voice, progress: it ? groupProgress(it.members, it.media.episodes ?? null) : 0 };
    }),
  };
}

export type GroupAction =
  | { action: "preset"; preset: RoomPreset }
  | { action: "grant"; userId: number; control: boolean }
  | { action: "queue-add" | "queue-remove"; anilistId: number }
  | { action: "queue-move"; anilistId: number; dir: -1 | 1 }
  | { action: "voice"; anilistId: number; voice: string | null }
  | { action: "session-create"; anilistId: number; ep: number; count: number; startsAt: number }
  | { action: "session-cancel"; sessionId: number }
  | { action: "rsvp"; sessionId: number; answer: Rsvp }
  | { action: "poll-create"; options: number[]; hours: number }
  | { action: "vote"; pollId: number; anilistId: number }
  | { action: "poll-close"; pollId: number };

const inList = (listId: number, anilistId: number) =>
  Boolean(db.prepare<[number, number], { x: number }>("SELECT 1 x FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").get(listId, anilistId));

function queueAppend(listId: number, anilistId: number) {
  const max = db.prepare<[number], { m: number | null }>("SELECT MAX(queue_pos) m FROM shared_list_items WHERE list_id = ?").get(listId)?.m ?? 0;
  db.prepare("UPDATE shared_list_items SET queue_pos = ? WHERE list_id = ? AND anilist_id = ? AND queue_pos IS NULL").run(max + 1, listId, anilistId);
}

export function groupAction(user: { id: number; name: string }, listId: number, a: GroupAction): GroupPlan {
  requireMember(listId, user.id);
  const g = groupRow(listId);
  const owner = g.owner_id === user.id;
  const planner = canPlan(g, user.id);
  switch (a.action) {
    case "preset":
      if (!owner) throw new ApiError(403, "Пресет меняет организатор группы");
      db.prepare("UPDATE shared_lists SET preset = ? WHERE id = ?").run(a.preset === "host" ? "host" : "equal", listId);
      break;
    case "grant":
      if (!owner) throw new ApiError(403, "Пульт раздаёт организатор группы");
      db.prepare("UPDATE shared_list_members SET control = ? WHERE list_id = ? AND user_id = ?").run(a.control ? 1 : 0, listId, Number(a.userId));
      break;
    case "queue-add":
      if (!inList(listId, a.anilistId)) throw new ApiError(400, "Сначала добавьте тайтл в группу");
      queueAppend(listId, a.anilistId);
      break;
    case "queue-remove":
      db.prepare("UPDATE shared_list_items SET queue_pos = NULL WHERE list_id = ? AND anilist_id = ?").run(listId, a.anilistId);
      break;
    case "queue-move": {
      const q = db.prepare<[number], { anilist_id: number }>("SELECT anilist_id FROM shared_list_items WHERE list_id = ? AND queue_pos IS NOT NULL ORDER BY queue_pos").all(listId).map((r) => r.anilist_id);
      const i = q.indexOf(a.anilistId);
      const j = i + (a.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= q.length) break;
      [q[i], q[j]] = [q[j], q[i]];
      q.forEach((id, k) => db.prepare("UPDATE shared_list_items SET queue_pos = ? WHERE list_id = ? AND anilist_id = ?").run(k + 1, listId, id));
      break;
    }
    case "voice":
      db.prepare("UPDATE shared_list_items SET voice = ? WHERE list_id = ? AND anilist_id = ?").run(a.voice?.trim().slice(0, 80) || null, listId, a.anilistId);
      break;
    case "session-create": {
      if (!planner) throw new ApiError(403, "Сеансы назначает организатор группы");
      if (!inList(listId, a.anilistId)) throw new ApiError(400, "Тайтла нет в группе");
      const ep = Math.max(1, Math.floor(Number(a.ep)) || 1);
      const count = Math.min(SESSION_MAX_EPS, Math.max(1, Math.floor(Number(a.count)) || 1));
      const startsAt = Math.floor(Number(a.startsAt));
      if (!startsAt || startsAt < now() - 300) throw new ApiError(400, "Время сеанса уже прошло");
      const id = Number(db.prepare(`INSERT INTO group_sessions (list_id, anilist_id, ep, count, starts_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(listId, a.anilistId, ep, count, startsAt, user.id, now()).lastInsertRowid);
      db.prepare("INSERT INTO group_rsvp (session_id, user_id, answer) VALUES (?, ?, 'yes')").run(id, user.id);
      queueAppend(listId, a.anilistId);
      tell(listId, user.id, { title: "Назначен сеанс", body: `${titleOf(a.anilistId)}, ${sessionEps({ ep, count })}`, anilistId: a.anilistId, actorId: user.id });
      break;
    }
    case "session-cancel": {
      const s = db.prepare<[number, number], SessionRow>("SELECT * FROM group_sessions WHERE id = ? AND list_id = ?").get(a.sessionId, listId);
      if (!s) throw new ApiError(404, "Сеанс не найден");
      if (s.created_by !== user.id && !owner) throw new ApiError(403, "Отменить может тот, кто назначил, или организатор");
      if (s.status !== "planned") throw new ApiError(400, "Сеанс уже идёт или прошёл");
      db.prepare("UPDATE group_sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
      tell(listId, user.id, { title: "Сеанс отменён", body: `${titleOf(s.anilist_id)}, ${sessionEps(s)}`, anilistId: s.anilist_id, actorId: user.id });
      break;
    }
    case "rsvp": {
      if (!["yes", "maybe", "no"].includes(a.answer)) throw new ApiError(400, "Неверный ответ");
      if (!db.prepare<[number, number], { x: number }>("SELECT 1 x FROM group_sessions WHERE id = ? AND list_id = ?").get(a.sessionId, listId)) throw new ApiError(404, "Сеанс не найден");
      db.prepare(`INSERT INTO group_rsvp (session_id, user_id, answer) VALUES (?, ?, ?)
        ON CONFLICT (session_id, user_id) DO UPDATE SET answer = excluded.answer`).run(a.sessionId, user.id, a.answer);
      break;
    }
    case "poll-create": {
      if (!planner) throw new ApiError(403, "Голосование запускает организатор группы");
      if (db.prepare<[number], { x: number }>("SELECT 1 x FROM group_polls WHERE list_id = ? AND closed_at IS NULL").get(listId)) throw new ApiError(400, "Одно голосование уже идёт");
      const options = [...new Set(a.options.map(Number))].filter((id) => inList(listId, id));
      if (options.length < 2) throw new ApiError(400, "Нужно хотя бы два тайтла");
      const hours = Math.min(24 * 7, Math.max(1, Number(a.hours) || 24));
      const id = Number(db.prepare("INSERT INTO group_polls (list_id, created_by, created_at, closes_at) VALUES (?, ?, ?, ?)").run(listId, user.id, now(), now() + hours * 3600).lastInsertRowid);
      options.forEach((o, k) => db.prepare("INSERT INTO group_poll_options (poll_id, anilist_id, ord) VALUES (?, ?, ?)").run(id, o, k));
      tell(listId, user.id, { title: "Что смотрим дальше? Голосование", body: `Голосование, ${options.length} ${plural(options.length, "тайтл", "тайтла", "тайтлов")}`, actorId: user.id });
      break;
    }
    case "vote": {
      const p = db.prepare<[number, number], PollRow>("SELECT * FROM group_polls WHERE id = ? AND list_id = ?").get(a.pollId, listId);
      if (!p || p.closed_at) throw new ApiError(400, "Голосование закончилось");
      const had = db.prepare("DELETE FROM group_poll_votes WHERE poll_id = ? AND user_id = ? AND anilist_id = ?").run(p.id, user.id, a.anilistId).changes;
      if (!had && db.prepare<[number, number], { x: number }>("SELECT 1 x FROM group_poll_options WHERE poll_id = ? AND anilist_id = ?").get(p.id, a.anilistId))
        db.prepare("INSERT INTO group_poll_votes (poll_id, user_id, anilist_id) VALUES (?, ?, ?)").run(p.id, user.id, a.anilistId);
      // Проголосовали все — итог сразу
      const voters = new Set(db.prepare<[number], { user_id: number }>("SELECT DISTINCT user_id FROM group_poll_votes WHERE poll_id = ?").all(p.id).map((r) => r.user_id));
      if (activeMembers(listId).every((u) => voters.has(u))) closePoll(p.id);
      break;
    }
    case "poll-close": {
      const p = db.prepare<[number, number], PollRow>("SELECT * FROM group_polls WHERE id = ? AND list_id = ?").get(a.pollId, listId);
      if (!p || p.closed_at) break;
      if (p.created_by !== user.id && !owner) throw new ApiError(403, "Закрыть может тот, кто запустил, или организатор");
      closePoll(p.id);
      break;
    }
  }
  return groupPlan(user.id, listId);
}

/** Итог голосования: победитель — в очередь, участникам — уведомление. */
function closePoll(pollId: number) {
  const p = db.prepare<[number], PollRow>("SELECT * FROM group_polls WHERE id = ?").get(pollId);
  if (!p || p.closed_at) return;
  const winner = pollWinner(pollView(p).options);
  db.prepare("UPDATE group_polls SET closed_at = ?, winner = ? WHERE id = ?").run(now(), winner, p.id);
  if (winner) queueAppend(p.list_id, winner);
  tell(p.list_id, null, winner
    ? { title: "Голосование закончилось", body: `Смотрим «${titleOf(winner)}» — уже в очереди`, anilistId: winner }
    : { title: "Голосование закончилось", body: "Никто не проголосовал" });
}

/** Кто идёт на сеанс: все участники, кроме ответивших «не приду». */
const goingTo = (s: SessionRow) => {
  const no = new Set(db.prepare<[number], { user_id: number }>("SELECT user_id FROM group_rsvp WHERE session_id = ? AND answer = 'no'").all(s.id).map((r) => r.user_id));
  return activeMembers(s.list_id).filter((u) => !no.has(u));
};

/** Озвучка группы — тем, кто у тайтла её ещё не выбирал. */
function applyGroupVoice(s: SessionRow, users: number[]) {
  const voice = db.prepare<[number, number], { voice: string | null }>("SELECT voice FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").get(s.list_id, s.anilist_id)?.voice;
  if (voice) for (const u of users) if (!voicePref(u, s.anilist_id)) setVoicePref(u, s.anilist_id, voice);
}

/** За час до сеанса: серии «Стрима» — в подготовку (буфер и озвучка группы); каких нет совсем — сказать назначившему. */
async function prepareSession(s: SessionRow) {
  const users = goingTo(s);
  applyGroupVoice(s, users);
  const items = await episodeItems(s.anilist_id);
  const missing: number[] = [];
  for (let ep = s.ep; ep < s.ep + s.count; ep++) {
    const list = items.get(ep) ?? [];
    if (list.some((i) => i.where === "library")) continue;
    const st = list.find((i) => i.where === "stream" && i.hash && i.index);
    if (!st) { missing.push(ep); continue; }
    for (const u of users) await startTask("prebuffer", `${st.hash}:${st.index}`, { userId: u, origin: "schedule", notify: false });
  }
  if (missing.length) notify(s.created_by, {
    kind: "group", anilistId: s.anilist_id, href: `/anime/${s.anilist_id}`, subject: listRow(s.list_id)?.name ?? null, error: true,
    title: "К сеансу не хватает серий", body: `${missing.join(", ")} — ни в библиотеке, ни в «Стриме»: найдите раздачу в «Озвучках»`,
  });
}

/** Раз в минуту: голосования по сроку, сеансы (подготовка, напоминание, комната, завершение). */
export async function groupTick() {
  const t = now();
  for (const p of db.prepare<[number], { id: number }>("SELECT id FROM group_polls WHERE closed_at IS NULL AND closes_at <= ?").all(t)) closePoll(p.id);
  for (const s of db.prepare<[], SessionRow>("SELECT * FROM group_sessions WHERE status IN ('planned', 'live')").all()) {
    if (s.status === "live") {
      if (!s.room_id || roomEnded(s.room_id)) db.prepare("UPDATE group_sessions SET status = 'done' WHERE id = ?").run(s.id);
      continue;
    }
    for (const step of sessionDue({ startsAt: s.starts_at, status: s.status, prepared: Boolean(s.prepared), reminded: Boolean(s.reminded) }, t)) {
      if (step === "expire") db.prepare("UPDATE group_sessions SET status = 'done' WHERE id = ?").run(s.id);
      if (step === "prepare") {
        db.prepare("UPDATE group_sessions SET prepared = 1 WHERE id = ?").run(s.id);
        await prepareSession(s).catch((e) => console.warn(`[groups] подготовка сеанса ${s.id}: ${String(e)}`));
      }
      if (step === "remind") {
        db.prepare("UPDATE group_sessions SET reminded = 1 WHERE id = ?").run(s.id);
        for (const u of goingTo(s)) notify(u, {
          kind: "group", anilistId: s.anilist_id, href: `/lists/shared/${s.list_id}`, subject: listRow(s.list_id)?.name ?? null,
          title: "Сеанс через 15 минут", body: `${titleOf(s.anilist_id)}, ${sessionEps(s)}`,
        });
      }
      if (step === "start") {
        const g = groupRow(s.list_id);
        const users = goingTo(s);
        applyGroupVoice(s, users);
        const room = createRoom({ id: s.created_by, name: userName(s.created_by) }, s.anilist_id, s.ep, users, 0, false,
          { id: s.list_id, sessionId: s.id, preset: g.preset, control: [...g.control, g.owner_id] });
        db.prepare("UPDATE group_sessions SET status = 'live', room_id = ? WHERE id = ?").run(room.id, s.id);
        // Позвать и назначившего: комната открылась без него
        notify(s.created_by, {
          kind: "room", anilistId: s.anilist_id, href: `/anime/${s.anilist_id}/watch/${s.ep}?room=${room.id}`, title: "Сеанс начался",
          body: `${titleOf(s.anilist_id)}, ${sessionEps(s)}`, actions: [{ type: "link", label: "Войти", href: `/anime/${s.anilist_id}/watch/${s.ep}?room=${room.id}` }],
        });
      }
    }
  }
}

/** Группы, где я участник и есть этот тайтл, — «позвать группу» при создании комнаты. */
export function groupsForTitle(userId: number, anilistId: number) {
  return db.prepare<[number, number], { id: number; name: string; preset: RoomPreset }>(
    `SELECT l.id, l.name, l.preset FROM shared_lists l
     JOIN shared_list_members m ON m.list_id = l.id AND m.user_id = ? AND m.status = 'member'
     JOIN shared_list_items i ON i.list_id = l.id AND i.anilist_id = ?
     ORDER BY l.created_at DESC`).all(userId, anilistId)
    .map((g) => ({ id: g.id, name: g.name, members: activeMembers(g.id).filter((u) => u !== userId).map((u) => ({ id: u, name: userName(u) })) }));
}

/** Комната «позвать группу»: пресет и пульт группы. */
export function roomGroup(userId: number, listId: number) {
  requireMember(listId, userId);
  const g = groupRow(listId);
  return { id: listId, preset: g.preset, control: [...g.control, g.owner_id] };
}
