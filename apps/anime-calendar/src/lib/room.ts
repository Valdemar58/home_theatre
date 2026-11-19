// Комната совместного просмотра (TASKS 9.4а) — правила, общие для сервера и плеера. Комната одноразовая: один сеанс,
// пауза, перемотка и смена серии — у всех сразу, поток у каждого свой. Состояние — «где были в момент at» по часам
// сервера: позиция сейчас считается, а не пересылается каждую секунду.

/** Кто управляет: все равны или организатор (и те, кому он дал право). */
export type RoomPreset = "equal" | "host";

export type RoomState = {
  generation?: number;
  session?: import("./session-playback").SessionPlayback;
  ep: number;
  playing: boolean;
  /** Позиция, с, в момент at (мс, часы сервера) */
  pos: number;
  at: number;
  /** Ждём этих участников (грузятся) — комната на паузе, пока список не опустеет */
  hold: number[];
};

/** Связь участника: что сообщает его плеер раз в несколько секунд. */
export type RoomPresence = {
  position?: number | null;
  buffered?: [number, number][];
  online: boolean;
  buffering: boolean;
  /** Оценка скорости потока hls.js, бит/с */
  bw: number | null;
  /** Задержка до сервера, мс */
  rtt: number | null;
  /** Насколько отстаёт (−) или спешит (+) от комнаты, с */
  drift: number | null;
  seenAt: number;
};

export type RoomMember = {
  id: number;
  name: string;
  status: "invited" | "joined" | "left";
  host: boolean;
  /** Право управлять в пресете «организатор» */
  control: boolean;
  presence: RoomPresence | null;
};

export type RoomActionKind = "play" | "pause" | "seek" | "ep" | "join" | "leave" | "hold" | "resume" | "skip";
export type RoomAction = { userId: number; kind: RoomActionKind; pos: number | null; ep?: number; at: number };

export type RoomView = {
  groupId?: number | null;
  canInvite?: boolean;
  id: string;
  anilistId: number;
  ownerId: number;
  preset: RoomPreset;
  state: RoomState;
  members: RoomMember[];
  /** Последние действия: кто нажал паузу, кто продолжил */
  actions: RoomAction[];
  ended: boolean;
  /** Кто смотрит этот снимок */
  me: number;
};

/** Где комната в момент t (часы сервера). */
export const positionAt = (s: Pick<RoomState, "playing" | "pos" | "at">, t: number) => (s.playing ? s.pos + Math.max(0, t - s.at) / 1000 : s.pos);

export function canControl(preset: RoomPreset, m: Pick<RoomMember, "host" | "control" | "status"> | undefined) {
  if (!m || m.status !== "joined") return false;
  return preset === "equal" || m.host || m.control;
}

/**
 * Поправка плеера к комнате. drift — насколько плеер впереди (+) или позади (−), с. Больше 2 с — перемотка,
 * меньше 0,25 с — ничего, между — догоняем скоростью 0,95–1,05 (незаметно на слух). На паузе — только перемотка.
 */
export function correction(drift: number, playing: boolean): { seek: boolean; rate: number } {
  const a = Math.abs(drift);
  if (!playing) return { seek: a > 0.5, rate: 1 };
  if (a > 2) return { seek: true, rate: 1 };
  if (a < 0.25) return { seek: false, rate: 1 };
  return { seek: false, rate: Math.round((1 - Math.max(-0.05, Math.min(0.05, drift * 0.05))) * 1000) / 1000 };
}

/** Сдвиг часов сервера по одному замеру (запрос ушёл t0, ответ пришёл t1, сервер сказал now). */
export const clockOffset = (t0: number, t1: number, now: number) => now - (t0 + t1) / 2;

/** Качество связи для подписи: тон палитры. */
export function netTone(p: Pick<RoomPresence, "bw" | "rtt"> | null): "positive" | "warning" | "negative" | "neutral" {
  if (!p || (p.bw === null && p.rtt === null)) return "neutral";
  if ((p.bw !== null && p.bw < 1.5e6) || (p.rtt !== null && p.rtt > 600)) return "negative";
  if ((p.bw !== null && p.bw < 4e6) || (p.rtt !== null && p.rtt > 250)) return "warning";
  return "positive";
}

/** Сколько ждём одного участника, прежде чем смотреть без него. */
export const HOLD_MAX_MS = 90_000;
