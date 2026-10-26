// Правила статуса записи при отметке серий — общие для сервера (ручная отметка, синхронизация
// с Jellyfin, AniLib) и мгновенного обновления интерфейса.
//
//  • отметили серию у «Запланировано», «Отложено», «Брошено» (или тайтла нет в списке) — «Смотрю»;
//  • отметили не последнюю серию у «Просмотрено» — «Пересматриваю»;
//  • досмотрели последнюю серию вышедшего тайтла (в т. ч. пересмотр) — «Просмотрено».
//
// «+N новых» честно: запоминаем, сколько серий было вышедшими при последней отметке (airedMark),
// и считаем новыми только вышедшие после неё. Остальное — «осталось N» (бэклог, пересмотр).

import type { ListStatus, MediaLite } from "./types";

type Media = Pick<MediaLite, "episodes" | "status" | "nextAiringEpisode">;

export type EntryState = { status: ListStatus; waiting: boolean; episodes: number; airedMark: number | null };
export type ProgressPatch = Partial<{ status: ListStatus; waiting: boolean; episodes: number }>;

/** Сколько серий уже вышло (null — неизвестно: анонс без расписания). */
export function airedCount(m: Media): number | null {
  if (m.nextAiringEpisode) return Math.max(0, m.nextAiringEpisode.episode - 1);
  if (m.status === "FINISHED") return m.episodes ?? null;
  if (m.status === "NOT_YET_RELEASED") return 0;
  return null;
}

export function applyProgress(prev: EntryState | null, patch: ProgressPatch, m: Media): EntryState {
  let status: ListStatus = patch.status ?? prev?.status ?? "planned";
  let waiting = patch.waiting ?? prev?.waiting ?? false;
  let episodes = patch.episodes ?? prev?.episodes ?? 0;
  if (m.episodes) episodes = Math.min(episodes, m.episodes);

  // Автостатус — только когда статус не выбрали явно, а отметили серию
  if (patch.status === undefined && patch.episodes !== undefined) {
    const was = prev?.status;
    if (was === "completed" && m.episodes && episodes < m.episodes) status = "rewatching";
    else if ((!was || ["planned", "on_hold", "dropped"].includes(was)) && episodes > (prev?.episodes ?? 0)) status = "watching";
  }
  if (patch.waiting) status = "planned";
  if (status !== "planned") waiting = false;
  if ((status === "watching" || status === "rewatching") && m.episodes && episodes >= m.episodes && m.status === "FINISHED") {
    status = "completed";
  }
  if (status === "completed" && m.episodes) episodes = m.episodes;

  // Отметили серию или сменили статус — запоминаем, сколько тогда было вышедших
  const touched = patch.episodes !== undefined || (patch.status !== undefined && patch.status !== prev?.status);
  const airedMark = touched ? airedCount(m) : (prev?.airedMark ?? null);
  return { status, waiting, episodes, airedMark };
}

/** «+N новых» (вышли после последней отметки) и «осталось N» (всего не просмотрено из вышедших). */
export function episodeProgress(e: Pick<EntryState, "status" | "episodes" | "airedMark">, m: Media): { fresh: number; remaining: number } {
  const aired = airedCount(m);
  if (aired === null) return { fresh: 0, remaining: 0 };
  const remaining = Math.max(0, aired - e.episodes);
  // Пересмотр и записи без отметки (старые) — никаких «новых»
  const fresh = e.status === "rewatching" || e.airedMark === null ? 0 : Math.max(0, aired - Math.max(e.airedMark, e.episodes));
  return { fresh, remaining };
}
