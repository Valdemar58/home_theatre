// Как часто обновлять сохранённые данные. Вышедшее давно почти не меняется (оценки и популярность — медленно):
// обновляем редко и в фоне; онгоинг — часто. Сохранённое не удаляется (класс «entity»), срок — только «когда
// проверить снова».

import type { FuzzyDate } from "./types";

const H = 3600;
const D = 86400;

/** Что о тайтле нужно знать для политики: статус и когда закончился. */
export type Liveness = { status: string | null; endDate?: FuzzyDate | null; finaleAt?: number | null };

/**
 * Через сколько секунд проверить тайтл снова. part: «airing» — серии и расписание, «info» — остальное
 * (описание, оценки, связи, персонажи).
 */
export function freshFor(m: Liveness, part: "airing" | "info" = "info", nowSec = Math.floor(Date.now() / 1000)): number {
  switch (m.status) {
    case "RELEASING":
      return part === "airing" ? 6 * H : D;
    case "NOT_YET_RELEASED":
      return D;
    case "HIATUS":
      return 7 * D;
    case "FINISHED":
    case "CANCELLED": {
      const ended = endedAt(m);
      // Недавно закончился: дозаливки, BD-версии, оценки ещё двигаются
      if (ended === null) return 30 * D;
      return nowSec - ended < 90 * D ? 7 * D : 90 * D;
    }
    default:
      return D;
  }
}

/** Время окончания показа (секунды): финал из расписания или дата окончания. */
export function endedAt(m: Liveness): number | null {
  if (m.finaleAt) return m.finaleAt;
  const e = m.endDate;
  if (!e?.year) return null;
  return Math.floor(Date.UTC(e.year, (e.month ?? 12) - 1, e.day ?? 28) / 1000);
}

/** Классы записей кэша: entity — данные о тайтлах и персонажах (не удаляются), listing — выдачи каталога и поиска,
 *  volatile — состояние сервисов (Sonarr, торренты, Seerr). */
export type CacheClass = "entity" | "listing" | "volatile";

const ENTITY = /^(media:|title-chars:|character:|shiki-desc:|shiki-chars:|shiki-media:|tmdb-|kitsu-eps:|plot-eps:|corpus-wd:|fandom-|airing:|ru-topic:|ru:names:|lite:)/;
const LISTING = /^(browse:|shiki-search:|genres$|seerr-search:|similar:|jimaku-index$|.*popular)/;

/** Класс записи по ключу (для старых записей и вызовов без явного класса). */
export function cacheClassOf(key: string): CacheClass {
  if (ENTITY.test(key)) return "entity";
  if (LISTING.test(key)) return "listing";
  return "volatile";
}

/** Сколько держать просроченную запись класса на случай недоступности источника (секунды; null — всегда). */
export function keepAfterExpiry(cls: CacheClass): number | null {
  return cls === "entity" ? null : cls === "listing" ? 30 * D : D;
}
