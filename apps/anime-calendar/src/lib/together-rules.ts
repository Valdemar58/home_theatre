// «Посмотрели вместе»: кому и до какой серии отметить. Общие для сервера, окна отметки и тестов.
//
//  • прогресс только растёт: «до серии N» не откатывает того, кто ушёл дальше;
//  • досмотревшим («Просмотрено») ничего не меняем — пересмотр каждый отмечает сам;
//  • N не больше числа серий тайтла.

import type { ListStatus } from "./types";

export type MemberState = { userId: number; status: ListStatus | null; episodes: number };

/** Что изменится у участника при отметке до серии upTo (null — ничего). */
export function togetherChange(m: MemberState, upTo: number, total: number | null): { from: number; to: number } | null {
  const to = total ? Math.min(upTo, total) : upTo;
  if (m.status === "completed") return null;
  if (to <= m.episodes) return null;
  return { from: m.episodes, to };
}

/**
 * Серия по умолчанию в окне: если кто-то из отмеченных ушёл дальше остальных — подтянуть всех до него
 * (досмотрели вместе, а отметил только он); если все на одной серии — следующая.
 */
export function defaultUpTo(members: MemberState[], total: number | null): number {
  const eps = members.filter((m) => m.status !== "completed").map((m) => m.episodes);
  if (!eps.length) return total ?? 1;
  const max = Math.max(...eps);
  const n = eps.every((e) => e === max) ? max + 1 : max;
  return total ? Math.min(n, total) : n;
}

/** «серии 4–8», «серия 5» — для уведомлений и подписи изменения. */
export function episodesRange(from: number, to: number): string {
  return to - from === 1 ? `серия ${to}` : `серии ${from + 1}–${to}`;
}
