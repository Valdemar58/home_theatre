// Правила соц-функций без базы — общие для сервера и тестов.

export type Visibility = "all" | "friends" | "private";
export const VISIBILITIES: Visibility[] = ["all", "friends", "private"];

/** Отношение «я → он»: нет, я отправил заявку, мне прислали заявку, друзья. */
export type FriendState = "none" | "outgoing" | "incoming" | "friends";

/** Видны ли профиль и списки владельца зрителю. */
export function canSee(viewerId: number, owner: { id: number; visibility: Visibility }, state: FriendState): boolean {
  if (viewerId === owner.id) return true;
  if (owner.visibility === "all") return true;
  if (owner.visibility === "friends") return state === "friends";
  return false;
}

/** Состояние по строкам дружбы между двумя пользователями (их может быть не больше одной на пару). */
export function friendState(me: number, rows: { from_id: number; to_id: number; status: string }[]): FriendState {
  const row = rows[0];
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  return row.from_id === me ? "outgoing" : "incoming";
}

const DEFAULT_DURATION = 24; // минут, если AniList не знает длительность

/** Минуты просмотра по записи: просмотренные серии × длительность (не больше числа серий тайтла). */
export function watchMinutes(e: { episodes: number; status: string }, m: { episodes: number | null; duration: number | null; format?: string | null } | null): number {
  if (!m) return 0;
  // Фильм без отметки серий, но «просмотрен» — одна «серия»
  let eps = e.episodes;
  if (!eps && e.status === "completed") eps = m.episodes ?? 1;
  if (m.episodes) eps = Math.min(eps, m.episodes);
  return eps * (m.duration ?? DEFAULT_DURATION);
}
