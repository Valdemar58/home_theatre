import type { RoomPreset } from "./room";
import type { ListStatus } from "./types";

// Группа просмотра (TASKS 9.4в) — общий список, который смотрят вместе: расписание сеансов («приду / не приду»,
// напоминание, сеанс сам открывает комнату), голосование, что смотреть, очередь и прогресс группы, подготовка серий
// к сеансу, пресет управления комнатой. Правила — общие для сервера и интерфейса.

export type Rsvp = "yes" | "maybe" | "no";

export type GroupSession = {
  id: number;
  anilistId: number;
  /** С какой серии и сколько серий за сеанс */
  ep: number;
  count: number;
  /** Начало, с (unix) */
  startsAt: number;
  createdBy: number;
  status: "planned" | "live" | "done" | "cancelled";
  roomId: string | null;
  rsvp: { userId: number; answer: Rsvp }[];
};

export type GroupPoll = {
  id: number;
  createdBy: number;
  createdAt: number;
  closesAt: number;
  closedAt: number | null;
  winner: number | null;
  /** Варианты — тайтлы группы; голоса — кто за (можно за несколько) */
  options: { anilistId: number; votes: number[] }[];
};

export type GroupQueueItem = {
  anilistId: number;
  /** Серия, до которой досмотрела вся группа (минимум по участникам) */
  progress: number;
  /** Озвучка, которую группа выбрала для тайтла */
  voice: string | null;
};

export type GroupPlan = {
  preset: RoomPreset;
  /** Кому организатор дал пульт (пресет «организатор») */
  control: number[];
  sessions: GroupSession[];
  poll: GroupPoll | null;
  queue: GroupQueueItem[];
  /** Могу ли я назначать сеансы и запускать голосование */
  canPlan: boolean;
};

/** За сколько до начала готовить серии, напоминать; сколько ждать начала, прежде чем считать сеанс пропущенным. */
export const PREP_BEFORE = 60 * 60;
export const REMIND_BEFORE = 15 * 60;
export const SESSION_GRACE = 3 * 3600;
export const SESSION_MAX_EPS = 12;

/**
 * Прогресс группы — серия, до которой досмотрели все (минимум; досмотревший целиком — все серии). Скрытые от друзей
 * не учитываются; никто ничего не знает — 0.
 */
export function groupProgress(states: { status: ListStatus | null; episodes: number; hidden: boolean }[], total: number | null): number {
  const known = states.filter((s) => !s.hidden);
  if (!known.length) return 0;
  return Math.min(...known.map((s) => (s.status === "completed" ? (total ?? s.episodes) : s.status ? s.episodes : 0)));
}

/** Победитель голосования: больше всех голосов, при равенстве — тот, кто раньше в списке вариантов; без голосов — нет. */
export function pollWinner(options: GroupPoll["options"]): number | null {
  let best: GroupPoll["options"][number] | null = null;
  for (const o of options) if (o.votes.length && (!best || o.votes.length > best.votes.length)) best = o;
  return best?.anilistId ?? null;
}

/** Что пора сделать с запланированным сеансом в момент now (с). */
export function sessionDue(s: { startsAt: number; status: GroupSession["status"]; prepared: boolean; reminded: boolean }, now: number):
  ("prepare" | "remind" | "start" | "expire")[] {
  if (s.status !== "planned") return [];
  if (now >= s.startsAt + SESSION_GRACE) return ["expire"];
  const out: ("prepare" | "remind" | "start")[] = [];
  if (!s.prepared && now >= s.startsAt - PREP_BEFORE) out.push("prepare");
  if (!s.reminded && now >= s.startsAt - REMIND_BEFORE && now < s.startsAt) out.push("remind");
  if (now >= s.startsAt) out.push("start");
  return out;
}

/** Серии сеанса подписью: «5 серия», «5–7 серии». */
export const sessionEps = (s: Pick<GroupSession, "ep" | "count">) => (s.count > 1 ? `${s.ep}–${s.ep + s.count - 1} серии` : `${s.ep} серия`);
