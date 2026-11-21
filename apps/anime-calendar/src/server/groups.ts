import "server-only";
import { episodeAvailability, legacyBlocks, type SessionDraft } from "@/lib/session-plan";
import { GROUP_CAPABILITIES, type GroupPermissions } from "@/lib/group-policy";
import { groupAccess, requireGroupCapability } from "./group-policy";
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
import { groupEpisodes, meetingResult } from "./meeting-history";
import { groupSyncPolicy, saveGroupSyncPolicy } from "./room-sync-config";

// Группа просмотра (TASKS 9.4в) — общий список, который смотрят вместе: пресет управления комнатой и пульт, очередь
// с прогрессом группы и её озвучкой, сеансы по расписанию (за час — подготовка серий и озвучки, за 15 минут —
// напоминание, в начале — комната группы), голосование, что смотреть. Раз в минуту — groupTick (jobs.ts).

type SessionRow = {
  plan_json: string | null; revision: number;
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

/** Сказать участникам группы (кроме автора). */
function tell(listId: number, except: number | null, n: { title: string; body?: string; anilistId?: number; actorId?: number }) {
  for (const u of activeMembers(listId)) if (u !== except) notify(u, { kind: "group", href: `/groups/${listId}`, subject: listRow(listId)?.name ?? null, ...n });
}

const sessionView = (s: SessionRow): GroupSession => ({
  result: meetingResult(s.id),
  plan: s.plan_json ? JSON.parse(s.plan_json) as SessionDraft : { blocks: legacyBlocks({ anilistId: s.anilist_id, ep: s.ep, count: s.count }), skipCredits: false, timeZone: "UTC" }, revision: s.revision,
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
  const access = groupAccess(listId, userId);
  const items = itemsOf(listId, membersOf(listId));
  const queued = db.prepare<[number], { anilist_id: number; voice: string | null }>(
    "SELECT anilist_id, voice FROM shared_list_items WHERE list_id = ? AND queue_pos IS NOT NULL ORDER BY queue_pos").all(listId);
  const sessions = db.prepare<[number, number], SessionRow>(
    `SELECT * FROM group_sessions WHERE list_id = ? AND (status IN ('planned', 'live') OR starts_at > ?) ORDER BY starts_at`).all(listId, 0);
  // Голосование: открытое, иначе недавно закрытое (показать итог)
  const poll = db.prepare<[number, number], PollRow>(
    "SELECT * FROM group_polls WHERE list_id = ? AND (closed_at IS NULL OR closed_at > ?) ORDER BY id DESC LIMIT 1").get(listId, now() - 3 * 86400);
  return {
    preset: g.preset, control: g.control, canPlan: access.can("schedule"),
    permissions: access.permissions, syncPolicy: groupSyncPolicy(listId),
    capabilities: Object.fromEntries(GROUP_CAPABILITIES.map(k => [k, access.can(k)])) as GroupPlan["capabilities"],
    canPoll: g.owner_id === userId, legacyPermissions: access.legacy,
    sessions: sessions.map(sessionView),
    poll: poll ? pollView(poll) : null,
    queue: queued.map((q) => {
      const it = items.find((i) => i.media.id === q.anilist_id);
      const watchedEpisodes = groupEpisodes(listId,q.anilist_id);
      return { anilistId: q.anilist_id, voice: q.voice, progress: watchedEpisodes.length, watchedEpisodes };
    }),
  };
}

export type GroupAction =
  | { action: "sync-policy"; policy: unknown }
  | { action: "permissions"; permissions: GroupPermissions }
  | { action: "preset"; preset: RoomPreset }
  | { action: "grant"; userId: number; control: boolean }
  | { action: "queue-add" | "queue-remove"; anilistId: number }
  | { action: "queue-move"; anilistId: number; dir: -1 | 1 }
  | { action: "voice"; anilistId: number; voice: string | null }
  | { action: "session-create"; anilistId: number; ep: number; count: number; startsAt: number }
  | { action: "session-save"; sessionId?: number; revision?: number; startsAt: number; plan: SessionDraft }
  | { action: "session-cancel"; sessionId: number }
  | { action: "rsvp"; sessionId: number; answer: Rsvp }
  | { action: "poll-create"; options: number[]; hours: number }
  | { action: "vote"; pollId: number; anilistId: number }
  | { action: "poll-close"; pollId: number };

const inList = (listId: number, anilistId: number) =>
  Boolean(db.prepare<[number, number], { x: number }>("SELECT 1 x FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").get(listId, anilistId));

function queueAppend(listId: number, anilistId: number) {
  const max = db.prepare<[number], { m: number | null }>("SELECT MAX(queue_pos) m FROM shared_list_items WHERE list_id = ?").get(listId)?.m ?? 0;
  db.prepare("UPDATE shared_list_items SET queue_pos = ?, planning_state = 'accepted' WHERE list_id = ? AND anilist_id = ? AND queue_pos IS NULL").run(max + 1, listId, anilistId);
}

export function groupAction(user: { id: number; name: string }, listId: number, a: GroupAction): GroupPlan {
  requireMember(listId, user.id);
  if (!a || typeof a !== "object") throw new ApiError(400, "Неверное действие");
  db.transaction(() => {
  // Serialize changes to the queue and re-read permissions under the same lock.
  db.prepare("UPDATE shared_lists SET name = name WHERE id = ?").run(listId);
  const g = groupRow(listId);
  const owner = g.owner_id === user.id;
  const planner = groupAccess(listId, user.id).can("schedule");
  switch (a.action) {
    case "sync-policy":
      if (!owner) throw new ApiError(403, "Синхронизацию настраивает организатор комнаты");
      saveGroupSyncPolicy(listId, a.policy);
      break;
    case "permissions": {
      if (!owner) throw new ApiError(403, "Права меняет организатор комнаты");
      if (!a.permissions || GROUP_CAPABILITIES.some(k => !["all", "owner"].includes(a.permissions[k]))) throw new ApiError(400, "Неверные настройки прав");
      const clean = Object.fromEntries(GROUP_CAPABILITIES.map(k => [k, a.permissions[k]]));
      db.prepare("UPDATE shared_lists SET permissions = ?, preset = ? WHERE id = ?").run(JSON.stringify(clean), clean.play === "all" ? "equal" : "host", listId);
      break;
    }
    case "preset":
      if (!groupAccess(listId, user.id).legacy) throw new ApiError(400, "Используйте настройки прав комнаты");
      if (!owner) throw new ApiError(403, "Пресет меняет организатор группы");
      db.prepare("UPDATE shared_lists SET preset = ? WHERE id = ?").run(a.preset === "host" ? "host" : "equal", listId);
      break;
    case "grant":
      if (!groupAccess(listId, user.id).legacy) throw new ApiError(400, "Используйте настройки прав комнаты");
      if (!owner) throw new ApiError(403, "Пульт раздаёт организатор группы");
      db.prepare("UPDATE shared_list_members SET control = ? WHERE list_id = ? AND user_id = ?").run(a.control ? 1 : 0, listId, Number(a.userId));
      break;
    case "queue-add":
      requireGroupCapability(listId, user.id, "queue");
      if (!inList(listId, a.anilistId)) throw new ApiError(400, "Сначала добавьте тайтл в группу");
      queueAppend(listId, a.anilistId);
      break;
    case "queue-remove":
      requireGroupCapability(listId, user.id, "queue");
      db.prepare("UPDATE shared_list_items SET queue_pos = NULL WHERE list_id = ? AND anilist_id = ?").run(listId, a.anilistId);
      break;
    case "queue-move": {
      requireGroupCapability(listId, user.id, "reorder");
      const q = db.prepare<[number], { anilist_id: number }>("SELECT anilist_id FROM shared_list_items WHERE list_id = ? AND queue_pos IS NOT NULL ORDER BY queue_pos").all(listId).map((r) => r.anilist_id);
      const i = q.indexOf(a.anilistId);
      const j = i + (a.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= q.length) break;
      [q[i], q[j]] = [q[j], q[i]];
      q.forEach((id, k) => db.prepare("UPDATE shared_list_items SET queue_pos = ? WHERE list_id = ? AND anilist_id = ?").run(k + 1, listId, id));
      break;
    }
    case "voice":
      requireGroupCapability(listId, user.id, "queue");
      db.prepare("UPDATE shared_list_items SET voice = ? WHERE list_id = ? AND anilist_id = ?").run(a.voice?.trim().slice(0, 80) || null, listId, a.anilistId);
      break;
    case "session-create": {
      if (!planner) throw new ApiError(403, "Сеансы назначает организатор группы");
      if (!inList(listId, a.anilistId)) throw new ApiError(400, "Тайтла нет в группе");
      const item = db.prepare<[number, number], { planning_state: string }>("SELECT planning_state FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").get(listId, a.anilistId);
      if (item?.planning_state === "proposed") requireGroupCapability(listId, user.id, "queue");
      const ep = Math.max(1, Math.floor(Number(a.ep)) || 1);
      const count = Math.min(SESSION_MAX_EPS, Math.max(1, Math.floor(Number(a.count)) || 1));
      const total = getMedia(a.anilistId)?.episodes;
      if (total && ep + count - 1 > total) throw new ApiError(400, `В тайтле ${total} серий. Выберите диапазон в пределах сезона.`);
      const startsAt = Math.floor(Number(a.startsAt));
      if (!startsAt || startsAt < now() - 300) throw new ApiError(400, "Время сеанса уже прошло");
      const id = Number(db.prepare(`INSERT INTO group_sessions (list_id, anilist_id, ep, count, starts_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(listId, a.anilistId, ep, count, startsAt, user.id, now()).lastInsertRowid);
      db.prepare("INSERT INTO group_rsvp (session_id, user_id, answer) VALUES (?, ?, 'yes')").run(id, user.id);
      queueAppend(listId, a.anilistId);
      tell(listId, user.id, { title: "Назначен сеанс", body: `${titleOf(a.anilistId)}, ${sessionEps({ ep, count })}`, anilistId: a.anilistId, actorId: user.id });
      break;
    }
    case "session-save": {
      if (!planner) throw new ApiError(403, "Нет права изменять сеансы");
      const old = a.sessionId == null ? undefined : db.prepare<[number, number], SessionRow>("SELECT * FROM group_sessions WHERE id = ? AND list_id = ?").get(a.sessionId, listId);
      if (a.sessionId != null && !old) throw new ApiError(404, "Сеанс не найден");
      if (old && old.status !== "planned") throw new ApiError(409, "Начатый или завершённый сеанс нельзя редактировать");
      if (old && old.revision !== a.revision) throw new ApiError(409, "План уже изменён. Закройте редактор и откройте актуальную версию; ваши изменения пока не сохранены.");
      if (!Number.isSafeInteger(a.startsAt) || a.startsAt < now() || a.startsAt > now() + 5 * 366 * 86400) throw new ApiError(400, "Выберите будущее время сеанса в пределах пяти лет");
      const input = a.plan;
      if (!input || !Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 50 || typeof input.skipCredits !== "boolean" || typeof input.timeZone !== "string") throw new ApiError(400, "Неверный план сеанса");
      try { new Intl.DateTimeFormat("ru", { timeZone: input.timeZone }).format(); } catch { throw new ApiError(400, "Неизвестный часовой пояс"); }
      const ids = new Set<number>();
      const blocks = input.blocks.map(b => {
        if (!b || !Number.isSafeInteger(b.anilistId) || ids.has(b.anilistId) || !inList(listId, b.anilistId)) throw new ApiError(400, "Выберите разные тайтлы из комнаты");
        ids.add(b.anilistId);
        const item = db.prepare<[number, number], { planning_state: string }>("SELECT planning_state FROM shared_list_items WHERE list_id = ? AND anilist_id = ?").get(listId, b.anilistId);
        if (item?.planning_state === "proposed") requireGroupCapability(listId, user.id, "queue");
        const media = getMedia(b.anilistId);
        if (!media) throw new ApiError(400, "Нет сведений о тайтле");
        if (!Array.isArray(b.episodes) || !b.episodes.length || b.episodes.length > 2000 || new Set(b.episodes).size !== b.episodes.length || b.episodes.some(ep => !Number.isSafeInteger(ep) || !episodeAvailability(media, ep, a.startsAt).selectable)) throw new ApiError(400, `«${titleOf(b.anilistId)}»: выберите серии, вышедшие или объявленные к началу сеанса. TBA недоступны.`);
        if (!Number.isInteger(b.breakMinutes) || b.breakMinutes < 0 || b.breakMinutes > 240) throw new ApiError(400, "Перерыв должен быть от 0 до 240 минут");
        return { anilistId: b.anilistId, episodes: [...b.episodes].sort((x, y) => x - y), breakMinutes: b.breakMinutes, durationMinutes: media.duration && media.duration > 0 ? media.duration : 24, durationSource: media.duration && media.duration > 0 ? "catalog" as const : "estimate" as const };
      });
      const plan: SessionDraft = { blocks, skipCredits: input.skipCredits, timeZone: input.timeZone };
      const first = blocks[0];
      // Legacy columns are a compatibility projection only, never the authoritative plan.
      if (old) db.prepare("UPDATE group_sessions SET anilist_id = ?, ep = ?, count = ?, starts_at = ?, plan_json = ?, revision = revision + 1, prepared = 0, reminded = 0 WHERE id = ?")
        .run(first.anilistId, first.episodes[0], first.episodes.length, a.startsAt, JSON.stringify(plan), old.id);
      else {
        const id = Number(db.prepare("INSERT INTO group_sessions (list_id, anilist_id, ep, count, starts_at, created_by, created_at, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(listId, first.anilistId, first.episodes[0], first.episodes.length, a.startsAt, user.id, now(), JSON.stringify(plan)).lastInsertRowid);
        db.prepare("INSERT INTO group_rsvp (session_id, user_id, answer) VALUES (?, ?, 'yes')").run(id, user.id);
      }
      for (const b of blocks) queueAppend(listId, b.anilistId);
      tell(listId, user.id, { title: old ? "План сеанса изменён" : "Назначен сеанс", body: blocks.map(b => titleOf(b.anilistId)).join(" · "), actorId: user.id });
      break;
    }
    case "session-cancel": {
      const s = db.prepare<[number, number], SessionRow>("SELECT * FROM group_sessions WHERE id = ? AND list_id = ?").get(a.sessionId, listId);
      if (!s) throw new ApiError(404, "Сеанс не найден");
      if (!planner) throw new ApiError(403, "Отменить может тот, кто назначил, или организатор");
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
      if (!owner) throw new ApiError(403, "Голосование запускает организатор группы");
      if (db.prepare<[number], { x: number }>("SELECT 1 x FROM group_polls WHERE list_id = ? AND closed_at IS NULL").get(listId)) throw new ApiError(400, "Одно голосование уже идёт");
      const options = [...new Set((Array.isArray(a.options) ? a.options : []).map(Number))].filter((id) => inList(listId, id));
      if (options.length < 2) throw new ApiError(400, "Нужно хотя бы два тайтла");
      const hours = Math.min(24 * 7, Math.max(1, Number(a.hours) || 24));
      const id = Number(db.prepare("INSERT INTO group_polls (list_id, created_by, created_at, closes_at) VALUES (?, ?, ?, ?)").run(listId, user.id, now(), now() + hours * 3600).lastInsertRowid);
      options.forEach((o, k) => db.prepare("INSERT INTO group_poll_options (poll_id, anilist_id, ord) VALUES (?, ?, ?)").run(id, o, k));
      tell(listId, user.id, { title: "Что смотрим дальше? Голосование", body: `Голосование, ${options.length} ${plural(options.length, "тайтл", "тайтла", "тайтлов")}`, actorId: user.id });
      break;
    }
    case "vote": {
      requireGroupCapability(listId, user.id, "vote");
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
      if (!owner) throw new ApiError(403, "Закрыть может тот, кто запустил, или организатор");
      closePoll(p.id);
      break;
    }
    default: throw new ApiError(400, "Неизвестное действие");
  }
  })();
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
  for (const block of sessionView(s).plan!.blocks) {
  const current = { ...s, anilist_id: block.anilistId };
  applyGroupVoice(current, users);
  const items = await episodeItems(block.anilistId);
  const missing: number[] = [];
  for (const ep of block.episodes) {
    const list = items.get(ep) ?? [];
    if (list.some((i) => i.where === "library")) continue;
    const st = list.find((i) => i.where === "stream" && i.hash && i.index);
    if (!st) { missing.push(ep); continue; }
    for (const u of users) await startTask("prebuffer", `${st.hash}:${st.index}`, { userId: u, origin: "schedule", notify: false });
  }
  if (missing.length) notify(s.created_by, {
    kind: "group", anilistId: block.anilistId, href: `/anime/${block.anilistId}`, subject: listRow(s.list_id)?.name ?? null, error: true,
    title: "К сеансу не хватает серий", body: `${missing.join(", ")} — ни в библиотеке, ни в «Стриме»: найдите раздачу в «Озвучках»`,
  });
  }
}

/** Раз в минуту: голосования по сроку, сеансы (подготовка, напоминание, комната, завершение). */
export async function groupTick() {
  const t = now();
  for (const p of db.prepare<[number], { id: number }>("SELECT id FROM group_polls WHERE closed_at IS NULL AND closes_at <= ?").all(t)) closePoll(p.id);
  for (const s of db.prepare<[], SessionRow>("SELECT * FROM group_sessions WHERE status IN ('planned', 'live')").all()) {
    if (s.status === "live") {
      const begun = db.prepare<[number], { actual_started_at: number | null }>("SELECT actual_started_at FROM group_sessions WHERE id=?").get(s.id)?.actual_started_at;
      if (!begun && t >= s.starts_at + 2*3600) {
        db.prepare("UPDATE group_sessions SET status='missed' WHERE id=?").run(s.id);
        if (s.room_id) db.prepare("UPDATE watch_rooms SET ended_at=? WHERE id=?").run(t,s.room_id);
      } else if (!s.room_id || roomEnded(s.room_id)) db.prepare("UPDATE group_sessions SET status = 'interrupted' WHERE id = ?").run(s.id);
      continue;
    }
    for (const step of sessionDue({ startsAt: s.starts_at, status: s.status, prepared: Boolean(s.prepared), reminded: Boolean(s.reminded) }, t)) {
      if (step === "expire") db.prepare("UPDATE group_sessions SET status = 'missed' WHERE id = ? AND status = 'planned' AND revision = ?").run(s.id, s.revision);
      if (step === "prepare") {
        if (!db.prepare("UPDATE group_sessions SET prepared = 1 WHERE id = ? AND status = 'planned' AND revision = ? AND prepared = 0").run(s.id, s.revision).changes) continue;
        await prepareSession(s).catch((e) => console.warn(`[groups] подготовка сеанса ${s.id}: ${String(e)}`));
      }
      if (step === "remind") {
        if (!db.prepare("UPDATE group_sessions SET reminded = 1 WHERE id = ? AND status = 'planned' AND revision = ? AND reminded = 0").run(s.id, s.revision).changes) continue;
        for (const u of goingTo(s)) notify(u, {
          kind: "group", anilistId: s.anilist_id, href: `/groups/${s.list_id}`, subject: listRow(s.list_id)?.name ?? null,
          title: "Сеанс через 15 минут", body: `${titleOf(s.anilist_id)}, ${sessionEps(s)}`,
        });
      }
      if (step === "start") {
        db.transaction(() => {
        db.prepare("UPDATE shared_lists SET name = name WHERE id = ?").run(s.list_id);
        const fresh = db.prepare<[number], SessionRow>("SELECT * FROM group_sessions WHERE id = ?").get(s.id);
        if (!fresh || fresh.status !== "planned" || fresh.revision !== s.revision) return;
        if (db.prepare<[number], { id: number }>("SELECT id FROM group_sessions WHERE list_id = ? AND status = 'live'").get(s.list_id)) return;
        if (s.plan_json) {
          const first = sessionView(s).plan!.blocks[0];
          const media = getMedia(first.anilistId);
          if (!media || !episodeAvailability(media, first.episodes[0], t).selectable) return;
        }
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
        })();
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
  requireGroupCapability(listId, userId, "play");
  const g = groupRow(listId);
  return { id: listId, preset: g.preset, control: [...g.control, g.owner_id] };
}
