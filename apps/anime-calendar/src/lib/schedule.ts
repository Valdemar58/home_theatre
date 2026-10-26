// Чистые функции расписания: тип серии, сетка месяца, группировка по дням в часовом поясе.
import type { Airing, MediaLite } from "./types";

export type AiringKind = "finale" | "premiere" | "episode";

/** Финал — серия с номером, равным общему числу серий. Если число серий неизвестно, финала нет. */
export function airingKind(airing: Pick<Airing, "episode">, media: Pick<MediaLite, "episodes">): AiringKind {
  if (media.episodes && airing.episode === media.episodes) return "finale";
  if (airing.episode === 1) return "premiere";
  return "episode";
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Ключ дня YYYY-MM-DD для момента времени (unix, секунды) в заданном часовом поясе. */
export function dayKey(unixSeconds: number, timeZone: string): string {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(unixSeconds * 1000));
}

export function keyFromParts(year: number, month0: number, day: number): string {
  return new Date(Date.UTC(year, month0, day)).toISOString().slice(0, 10);
}

export function todayKey(timeZone: string): string {
  return dayKey(Math.floor(Date.now() / 1000), timeZone);
}

export type GridDay = { key: string; day: number; inMonth: boolean };

/**
 * Сетка месяца по неделям (пн–вс), month0: 0–11. По умолчанию столько недель, сколько
 * нужно месяцу (4–6); full = true — всегда 6 недель (42 дня).
 */
export function monthGrid(year: number, month0: number, full = false): GridDay[] {
  const first = new Date(Date.UTC(year, month0, 1));
  const offset = (first.getUTCDay() + 6) % 7; // пн = 0
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const weeks = full ? 6 : Math.ceil((offset + daysInMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const d = new Date(Date.UTC(year, month0, 1 - offset + i));
    return { key: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month0 };
  });
}

/** 7 дней недели (пн–вс), в которую входит день key. */
export function weekDays(key: string): GridDay[] {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const offset = (date.getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(Date.UTC(y, m - 1, d - offset + i));
    return { key: x.toISOString().slice(0, 10), day: x.getUTCDate(), inMonth: true };
  });
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return keyFromParts(y, m - 1, d + days);
}

/**
 * Диапазон запроса (unix, секунды) для набора дней. С запасом ±1 сутки:
 * точное попадание в день определяется на клиенте через dayKey в его часовом поясе.
 */
export function fetchRange(firstKey: string, lastKey: string): { from: number; to: number } {
  const [y1, m1, d1] = firstKey.split("-").map(Number);
  const [y2, m2, d2] = lastKey.split("-").map(Number);
  return {
    from: Date.UTC(y1, m1 - 1, d1 - 1) / 1000,
    to: Date.UTC(y2, m2 - 1, d2 + 2) / 1000,
  };
}

export type DayItem = { airing: Airing; media: MediaLite; kind: AiringKind };

export function groupByDay(airings: Airing[], media: Record<number, MediaLite>, timeZone: string): Map<string, DayItem[]> {
  const days = new Map<string, DayItem[]>();
  for (const airing of airings) {
    const m = media[airing.mediaId];
    if (!m) continue;
    const key = dayKey(airing.airingAt, timeZone);
    const item = { airing, media: m, kind: airingKind(airing, m) };
    const list = days.get(key);
    if (list) list.push(item);
    else days.set(key, [item]);
  }
  for (const list of days.values()) {
    // Сначала финалы, затем по популярности
    list.sort((a, b) =>
      Number(b.kind === "finale") - Number(a.kind === "finale") || b.media.popularity - a.media.popularity);
  }
  return days;
}

/** Финальная серия по полному расписанию тайтла (для карточки). */
export function finaleOf(
  media: Pick<MediaLite, "episodes" | "status" | "endDate">,
  schedule: { episode: number; airingAt: number }[],
): { airingAt: number | null; episode: number | null; tentative: boolean } | null {
  if (media.episodes) {
    const exact = schedule.find((s) => s.episode === media.episodes);
    if (exact) return { airingAt: exact.airingAt, episode: exact.episode, tentative: false };
  }
  if (schedule.length && media.status === "RELEASING") {
    const last = schedule.reduce((a, b) => (b.episode > a.episode ? b : a));
    return { airingAt: last.airingAt, episode: last.episode, tentative: true };
  }
  return null;
}

export function displayTitle(t: MediaLite["title"]): string {
  return t.ru || t.english || t.romaji || t.native || "Без названия";
}

export function secondaryTitle(t: MediaLite["title"]): string | null {
  const main = displayTitle(t);
  const alt = t.romaji && t.romaji !== main ? t.romaji : t.english && t.english !== main ? t.english : null;
  return alt;
}
