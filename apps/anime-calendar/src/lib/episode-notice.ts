// Что написать о вышедших сериях (правила без базы — для сервера и тестов).

import { airedCount } from "./entry-rules";
import type { MediaLite } from "./types";

type Media = Pick<MediaLite, "episodes" | "status" | "nextAiringEpisode">;

/** Сколько серий вышло к моменту t: снимок мог устареть — серия, чьё время прошло, тоже вышла. */
export function airedNow(m: Media, t: number): number | null {
  const base = airedCount(m);
  const next = m.nextAiringEpisode;
  if (next && next.airingAt <= t) return Math.max(base ?? 0, next.episode);
  return base;
}

/**
 * Уведомление о сериях, вышедших после notified (null — нечего сообщать).
 *  • «Смотрю»: каждая новая серия (несколько сразу — одним уведомлением);
 *  • «Жду выхода»: только когда вышла последняя.
 */
export function episodeNotice(e: { waiting: boolean; episodes: number }, m: Media, notified: number, aired: number):
  { kind: "episode" | "finale"; title: string; body: string | null } | null {
  if (aired <= notified) return null;
  const total = m.episodes;
  const finale = Boolean(total && aired >= total);
  if (e.waiting) {
    return finale && notified < total! ? { kind: "finale", title: `Вышла последняя серия — все ${total} можно смотреть`, body: null } : null;
  }
  const title = aired - notified === 1
    ? `Вышла ${aired} серия${finale ? " — финал" : ""}`
    : `Вышли серии ${notified + 1}–${aired}${finale ? " — финал" : ""}`;
  const behind = aired - e.episodes;
  return { kind: "episode", title, body: behind > 1 ? `Не просмотрено: ${behind}` : null };
}
