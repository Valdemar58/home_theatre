// Награды: семейства с четырьмя уровнями (бронза → серебро → золото → платина).
// Пороги растут нелинейно: бронза — «попробовал», платина — редкость даже для заядлого зрителя.
// Значения считает server/achievements.ts; здесь — описания и уровни (общие для сервера и интерфейса).

export type Tier = 0 | 1 | 2 | 3 | 4;
export const TIER_NAMES = ["", "Бронза", "Серебро", "Золото", "Платина"] as const;

export type AchievementIcon =
  | "bolt" | "heart" | "smile" | "sparkles" | "rocket" | "cog" | "trophy" | "eye" | "moon" | "sun" | "search" | "music"
  | "clock" | "calendar" | "archive" | "flag" | "scale" | "chat" | "users" | "map" | "thumb"
  | "puzzle" | "globe" | "alert" | "star" | "film" | "pencil" | "squares" | "check" | "signal" | "userGroup" | "bulb"
  | "cloud" | "fire";

/** Тип награды — своя форма значка: жанры — грань, привычки — жетон, друзья — щит, события — ромб. */
export type AchievementGroup = "genre" | "habit" | "social" | "event";
export const GROUP_SHAPE: Record<AchievementGroup, "hex" | "coin" | "shield" | "diamond"> = {
  genre: "hex", habit: "coin", social: "shield", event: "diamond",
};

export type AchievementDef = {
  id: string;
  name: string;
  /** Что считается; {n:форма1|форма2|форма5} — порог со словом в нужной форме */
  desc: string;
  icon: AchievementIcon;
  thresholds: [number, number, number, number];
  group: AchievementGroup;
};

const T = "{n:тайтл|тайтла|тайтлов}";
const RARE: AchievementDef["thresholds"] = [5, 15, 35, 80];
const genre = (id: string, name: string, g: string, icon: AchievementIcon, thresholds: AchievementDef["thresholds"] = [10, 25, 60, 150]): AchievementDef =>
  ({ id: `genre:${g}`, name, desc: `Досмотреть ${T} в жанре «${name.toLowerCase()}»`, icon, thresholds, group: "genre" });

export const ACHIEVEMENTS: AchievementDef[] = [
  genre("action", "Экшен", "Action", "bolt"),
  genre("adventure", "Приключения", "Adventure", "map"),
  genre("romance", "Романтика", "Romance", "heart"),
  genre("comedy", "Комедия", "Comedy", "smile"),
  genre("fantasy", "Фэнтези", "Fantasy", "sparkles"),
  genre("drama", "Драма", "Drama", "eye"),
  genre("scifi", "Фантастика", "Sci-Fi", "rocket"),
  genre("sol", "Повседневность", "Slice of Life", "sun"),
  genre("supernatural", "Сверхъестественное", "Supernatural", "globe"),
  genre("psychological", "Психологическое", "Psychological", "puzzle", RARE),
  genre("mystery", "Детектив", "Mystery", "search", RARE),
  genre("thriller", "Триллер", "Thriller", "alert", RARE),
  genre("horror", "Ужасы", "Horror", "moon", RARE),
  genre("mecha", "Меха", "Mecha", "cog", RARE),
  genre("sports", "Спорт", "Sports", "trophy", RARE),
  genre("music", "Музыка", "Music", "music", RARE),
  genre("mahou", "Махо-сёдзё", "Mahou Shoujo", "star", RARE),
  { id: "hours", name: "Время просмотра", desc: "Провести за просмотром {n:час|часа|часов}", icon: "clock", thresholds: [50, 250, 1000, 2500], group: "habit" },
  { id: "rated", name: "Оценщик", desc: `Оценить ${T}`, icon: "pencil", thresholds: [10, 50, 150, 400], group: "habit" },
  { id: "diverse", name: "Разносторонний", desc: "Досмотреть хотя бы по 5 тайтлов в {n:жанре|жанрах|жанрах}", icon: "squares", thresholds: [4, 7, 10, 14], group: "habit" },
  { id: "finisher", name: "Доводящий до конца", desc: `Досмотреть ${T}, бросая не больше 15%`, icon: "check", thresholds: [20, 50, 120, 300], group: "habit" },
  { id: "films", name: "Киноман", desc: "Посмотреть {n:фильм|фильма|фильмов}", icon: "film", thresholds: [3, 10, 25, 60], group: "habit" },
  { id: "ongoing", name: "Держу руку на пульсе", desc: "Смотреть одновременно {n:онгоинг|онгоинга|онгоингов}", icon: "signal", thresholds: [2, 4, 7, 10], group: "habit" },
  { id: "archaeologist", name: "Археолог", desc: `Досмотреть ${T}, вышедших до 2000 года`, icon: "archive", thresholds: [3, 10, 25, 50], group: "habit" },
  { id: "marathon", name: "Марафонец", desc: "Досмотреть {n:сериал|сериала|сериалов} от 50 серий", icon: "flag", thresholds: [1, 3, 7, 15], group: "habit" },
  { id: "own-view", name: "Свой взгляд", desc: `Оценить ${T} на 2+ балла иначе, чем средняя оценка AniList`, icon: "scale", thresholds: [5, 15, 35, 70], group: "habit" },
  { id: "friends", name: "Душа компании", desc: "Завести {n:друга|друзей|друзей}", icon: "userGroup", thresholds: [1, 3, 7, 15], group: "social" },
  { id: "critic", name: "Критик", desc: "Написать {n:комментарий|комментария|комментариев}", icon: "chat", thresholds: [5, 25, 100, 300], group: "social" },
  { id: "together", name: "Вместе веселее", desc: `Посмотреть вместе ${T}`, icon: "users", thresholds: [1, 5, 15, 40], group: "social" },
  { id: "pioneer", name: "Первооткрыватель", desc: `Первым из друзей досмотреть ${T}, которые потом досмотрели и они`, icon: "bulb", thresholds: [1, 5, 15, 40], group: "social" },
  { id: "adviser", name: "Советчик", desc: "{n:раз|раза|раз} друг досмотрел то, что вы советуете, и оценил на 7+", icon: "thumb", thresholds: [1, 5, 15, 40], group: "social" },
];

// ---------------------------------------------------------------- сезонные события

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
const SEASON_NAMES: Record<string, string> = { WINTER: "Зима", SPRING: "Весна", SUMMER: "Лето", FALL: "Осень" };
const SEASON_ICONS: Record<string, AchievementIcon> = { WINTER: "cloud", SPRING: "sparkles", SUMMER: "sun", FALL: "fire" };

/** Сезон AniList по дате: зима — янв–мар, весна — апр–июн, лето — июл–сен, осень — окт–дек. */
export function seasonOf(unix: number): { season: (typeof SEASONS)[number]; year: number } {
  const d = new Date(unix * 1000);
  return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
}

/** Награда сезона: «Осень 2026» — посмотреть N тайтлов этого сезона (досмотреть или начать). */
export function seasonEvent(season: string, year: number): AchievementDef {
  const name = `${SEASON_NAMES[season]} ${year}`;
  return { id: `season:${year}:${season}`, name, desc: `Посмотреть ${T} сезона «${name}»`, icon: SEASON_ICONS[season], thresholds: [3, 6, 10, 15], group: "event" };
}

/** Порядок сезонного события во времени (для сортировки «новые сверху»). */
export function eventOrder(id: string): number {
  const m = /^season:(\d{4}):(WINTER|SPRING|SUMMER|FALL)$/.exec(id);
  return m ? Number(m[1]) * 4 + SEASONS.indexOf(m[2] as (typeof SEASONS)[number]) : 0;
}

/** Определение по id, включая сезонные. */
export function achievementDef(id: string): AchievementDef | undefined {
  const m = /^season:(\d{4}):(WINTER|SPRING|SUMMER|FALL)$/.exec(id);
  return m ? seasonEvent(m[2], Number(m[1])) : ACHIEVEMENTS.find((a) => a.id === id);
}

export function tierOf(value: number, thresholds: readonly number[]): Tier {
  let t = 0;
  for (const th of thresholds) if (value >= th) t++;
  return t as Tier;
}

/** Прогресс к следующему уровню, 0–1 (на платине — 1). */
export function progressToNext(value: number, thresholds: readonly number[]): { next: number | null; ratio: number } {
  const t = tierOf(value, thresholds);
  if (t >= thresholds.length) return { next: null, ratio: 1 };
  const prev = t ? thresholds[t - 1] : 0;
  const next = thresholds[t];
  return { next, ratio: Math.max(0, Math.min(1, (value - prev) / (next - prev))) };
}

/** 1 тайтл, 2 тайтла, 5 тайтлов */
function plural(n: number, [one, few, many]: string[]) {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

export const describe = (def: AchievementDef, n: number) =>
  def.desc.replace(/\{n:([^}]+)\}/, (_, forms: string) => `${n} ${plural(n, forms.split("|"))}`);

export type AchievementProgress = { id: string; value: number; tier: Tier; /** когда получен текущий уровень */ earnedAt: number | null };
