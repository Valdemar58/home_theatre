// Форматирование дат и интервалов по-русски.
import type { FuzzyDate } from "./types";

export const browserTimeZone = () =>
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

export function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Год не текущий — тогда его нужно показывать в дате. */
const otherYear = (d: Date, nowMs: number, timeZone?: string) => {
  const year = (x: Date) => x.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return year(d) !== year(new Date(nowMs));
};

export function formatDate(unix: number, withWeekday = false, nowMs = Date.now()): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    ...(otherYear(d, nowMs) ? { year: "numeric" } : {}),
    ...(withWeekday ? { weekday: "short" } : {}),
  });
}

export function formatDateTime(unix: number, nowMs = Date.now()): string {
  return `${formatDate(unix, true, nowMs)}, ${formatTime(unix)}`;
}

/** Смещение пояса от UTC в минутах на момент времени (учитывает летнее время). */
export function tzOffsetMinutes(unix: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(unix * 1000))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** Метка пояса относительно Москвы: «МСК», «МСК+2», «МСК−7». */
export function tzLabel(unix: number, timeZone: string): string {
  const diff = (tzOffsetMinutes(unix, timeZone) - tzOffsetMinutes(unix, "Europe/Moscow")) / 60;
  if (diff === 0) return "МСК";
  const h = Number.isInteger(diff) ? String(Math.abs(diff)) : Math.abs(diff).toFixed(1);
  return `МСК${diff > 0 ? "+" : "−"}${h}`;
}

export type AiringParts = { weekday: string; date: string; time: string; tz: string; tzName: string; full: string };

/** «пятница, 9 октября, 17:00 МСК» по частям, в поясе устройства (или заданном). Год — если не текущий. */
export function formatAiring(unix: number, timeZone = browserTimeZone(), nowMs = Date.now()): AiringParts {
  const d = new Date(unix * 1000);
  const weekday = d.toLocaleDateString("ru-RU", { weekday: "long", timeZone });
  const date = d.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", ...(otherYear(d, nowMs, timeZone) ? { year: "numeric" } : {}), timeZone,
  });
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone });
  const tz = tzLabel(unix, timeZone);
  return { weekday, date, time, tz, tzName: timeZone, full: `${weekday}, ${date}, ${time} ${tz}` };
}

function pluralYears(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} год`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} года`;
  return `${n} лет`;
}

/** Календарная разница между датами (from ≤ to): полные годы, месяцы и оставшиеся дни. */
function calendarDiff(fromMs: number, toMs: number): { y: number; mo: number; d: number } {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  let mo = b.getUTCMonth() - a.getUTCMonth();
  let d = b.getUTCDate() - a.getUTCDate();
  // время суток «не дотянуло» — последний день ещё не полный
  if (b.getTime() % 86400000 < a.getTime() % 86400000) d--;
  if (d < 0) {
    mo--;
    d += new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
  }
  if (mo < 0) {
    y--;
    mo += 12;
  }
  return { y, mo, d };
}

/** Для прошедших событий (отметки, добавления): часы сервера могут чуть опережать браузер — не «через 1 мин». */
export const ago = (unix: number, nowMs = Date.now()) => relative(Math.min(unix, Math.floor(nowMs / 1000)), nowMs);

/** «через 3 д 4 ч», «через 25 мин», «2 д назад»; от месяца — без часов: «4 мес 12 д», «8 лет 2 мес 3 д» */
export function relative(unix: number, nowMs = Date.now()): string {
  const diff = unix - Math.floor(nowMs / 1000);
  const abs = Math.abs(diff);
  // Порядок дат — по миллисекундам: в пределах секунды diff ≥ 0, а момент уже в прошлом
  const cal = abs >= 28 * 86400 ? calendarDiff(Math.min(nowMs, unix * 1000), Math.max(nowMs, unix * 1000)) : { y: 0, mo: 0, d: 0 };
  if (cal.y || cal.mo) {
    const parts = [cal.y ? pluralYears(cal.y) : "", cal.mo ? `${cal.mo} мес` : "", cal.d ? `${cal.d} д` : ""];
    const text = parts.filter(Boolean).join(" ");
    return diff >= 0 ? `через ${text}` : `${text} назад`;
  }
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const text = d ? `${d} д${h ? ` ${h} ч` : ""}` : h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${Math.max(m, 1)} мин`;
  return diff >= 0 ? `через ${text}` : `${text} назад`;
}

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthName = (month0: number) => MONTHS[month0];
export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function fuzzyDate(d: FuzzyDate): string | null {
  if (!d.year) return null;
  if (!d.month) return String(d.year);
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day ?? 1));
  return date.toLocaleDateString("ru-RU", d.day ? { day: "numeric", month: "long", year: "numeric" } : { month: "long", year: "numeric" });
}

export function pluralEpisodes(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} серия`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} серии`;
  return `${n} серий`;
}
