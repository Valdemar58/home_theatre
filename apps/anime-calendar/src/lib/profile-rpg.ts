// RPG-характеристика зрителя по его списку: уровень, класс, атрибуты, «роза» жанров, оценки, эпохи,
// активность, зал славы и рекорды. Чистые функции — общие для сервера и тестов.

import { watchMinutes } from "./social-rules";
import type { ListEntryWithMedia } from "./types";

// ---------------------------------------------------------------- уровень

/**
 * Опыт — сумма опыта всех наград. Обычная награда: за каждый полученный уровень (бронза 20, серебро 50,
 * золото 120, платина 300 — суммируются). «Время просмотра» — 10 за каждый час, капает и после платины.
 * Уровень L требует 50·(L−1)^1.6 опыта: первые — быстро, дальше медленнее.
 */
export const TIER_XP = [0, 20, 50, 120, 300];
export const HOUR_XP = 10;
export const xpForLevel = (level: number) => 50 * Math.pow(level - 1, 1.6);
const tierXp = (tier: number) => TIER_XP.slice(1, tier + 1).reduce((a, b) => a + b, 0);
/** Опыт одной награды (часы — для «Время просмотра»). */
export const achievementXp = (a: { id: string; tier: number }, hours: number) => (a.id === "hours" ? hours * HOUR_XP : tierXp(a.tier));
export const badgeXp = (tiers: number[]) => tiers.reduce((s, t) => s + tierXp(t), 0);

export function levelOf(xp: number) {
  const level = 1 + Math.floor(Math.pow(Math.max(0, xp) / 50, 1 / 1.6));
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return { level, xp: Math.round(xp), progress: (xp - from) / (to - from), toNext: Math.ceil(to - xp) };
}

const RANKS: [number, string][] = [[50, "Легенда"], [35, "Мастер"], [20, "Ветеран"], [10, "Опытный зритель"], [0, "Новичок"]];
export const rankOf = (level: number) => RANKS.find(([min]) => level >= min)![1];

// ---------------------------------------------------------------- класс

export const CLASSES: Record<string, { name: string; motto: string }> = {
  Action: { name: "Воин", motto: "где драка — там и сюжет" },
  Adventure: { name: "Странник", motto: "за горизонтом — следующая арка" },
  Fantasy: { name: "Маг", motto: "другие миры — родной дом" },
  Romance: { name: "Бард", motto: "сердце важнее сражений" },
  Comedy: { name: "Шут", motto: "смех — лучшая броня" },
  Drama: { name: "Паломник", motto: "ищет смысл в каждой истории" },
  "Sci-Fi": { name: "Инженер", motto: "будущее уже наступило" },
  "Slice of Life": { name: "Хранитель очага", motto: "уют в мелочах" },
  Mystery: { name: "Сыщик", motto: "разгадает раньше героя" },
  Horror: { name: "Охотник на нечисть", motto: "не боится темноты" },
  Psychological: { name: "Мистик", motto: "смотрит в бездну, и бездна моргает" },
  Sports: { name: "Атлет", motto: "ещё один матч — и спать" },
  Mecha: { name: "Пилот", motto: "садись в робота" },
  Supernatural: { name: "Заклинатель", motto: "видит то, что скрыто" },
  Music: { name: "Менестрель", motto: "живёт в ритме опенингов" },
  Thriller: { name: "Следопыт", motto: "напряжение — его стихия" },
  Ecchi: { name: "Повеса", motto: "ценитель фансервиса" },
  "Mahou Shoujo": { name: "Волшебница", motto: "сила дружбы и трансформаций" },
};

// ---------------------------------------------------------------- статистика

export type RpgStats = {
  totals: { titles: number; completed: number; watching: number; dropped: number; planned: number; episodes: number; hours: number };
  level: ReturnType<typeof levelOf> & { rank: string; fromHours: number; fromBadges: number; inLevel: number; levelSize: number };
  klass: { genre: string; name: string; motto: string; second: string | null } | null;
  attributes: { key: string; name: string; value: number; hint: string; desc: string }[];
  /** «Роза» жанров: доля в досмотренном (с весом оценки), 0–1 от максимума */
  genres: { genre: string; count: number; weight: number; mean: number | null }[];
  scores: { hist: number[]; mean: number | null; anilistMean: number | null; count: number };
  formats: { format: string; count: number }[];
  eras: { from: number; count: number }[];
  activity: { month: string; count: number }[];
  studios: { name: string; count: number }[];
  hall: { id: number; title: string; cover: string | null; color: string | null; score: number }[];
  records: { kind: string; label: string; id: number; title: string; value: string }[];
  banner: string | null;
};

const titleOf = (e: ListEntryWithMedia) => e.media?.title.ru ?? e.media?.title.romaji ?? e.media?.title.english ?? `#${e.anilistId}`;
const clamp = (x: number) => Math.round(Math.max(0, Math.min(100, x)));

export function rpgStats(list: ListEntryWithMedia[], social: { friends: number; comments: number; together: number }, nowSec: number, badges: { id: string; tier: number }[] = []): RpgStats {
  const withMedia = list.filter((e) => e.media);
  const done = withMedia.filter((e) => e.status === "completed");
  const seen = withMedia.filter((e) => ["completed", "watching", "rewatching"].includes(e.status));
  const dropped = list.filter((e) => e.status === "dropped").length;
  const minutes = list.reduce((s, e) => s + watchMinutes(e, e.media), 0);
  const hours = Math.round(minutes / 60);
  const scored = list.filter((e) => e.score > 0);

  // Жанры: досмотренное и смотримое, вес оценки (без оценки — 1)
  const g = new Map<string, { count: number; weight: number; scores: number[] }>();
  for (const e of seen) {
    const w = e.score ? e.score / 7 : 1;
    for (const genre of e.media!.genres) {
      const x = g.get(genre) ?? { count: 0, weight: 0, scores: [] };
      x.count++;
      x.weight += w;
      if (e.score) x.scores.push(e.score);
      g.set(genre, x);
    }
  }
  const genreList = [...g].sort((a, b) => b[1].weight - a[1].weight);
  const maxW = genreList[0]?.[1].weight ?? 1;
  const genres = genreList.slice(0, 8).map(([genre, x]) => ({
    genre, count: x.count, weight: x.weight / maxW,
    mean: x.scores.length ? Math.round((x.scores.reduce((s, v) => s + v, 0) / x.scores.length) * 10) / 10 : null,
  }));
  const top = genreList.find(([genre]) => CLASSES[genre]);
  const second = genreList.find(([genre]) => genre !== top?.[0] && CLASSES[genre]);
  const klass = top ? { genre: top[0], ...CLASSES[top[0]], second: second?.[0] ?? null } : null;

  // Оценки: распределение 1–10 и сравнение со средней AniList по тем же тайтлам
  const hist = new Array(10).fill(0);
  for (const e of scored) hist[e.score - 1]++;
  const mean = scored.length ? scored.reduce((s, e) => s + e.score, 0) / scored.length : null;
  const withAvg = scored.filter((e) => e.media?.averageScore);
  const anilistMean = withAvg.length ? withAvg.reduce((s, e) => s + e.media!.averageScore! / 10, 0) / withAvg.length : null;
  const deviation = withAvg.length ? withAvg.reduce((s, e) => s + Math.abs(e.score - e.media!.averageScore! / 10), 0) / withAvg.length : 0;

  // Атрибуты 0–100
  const year = new Date(nowSec * 1000).getFullYear();
  const share = (pred: (e: ListEntryWithMedia) => boolean) => (seen.length ? seen.filter(pred).length / seen.length : 0);
  const entropy = (() => {
    const total = genreList.reduce((s, [, x]) => s + x.count, 0);
    if (!total) return 0;
    const h = genreList.reduce((s, [, x]) => { const p = x.count / total; return s - p * Math.log(p); }, 0);
    return h / Math.log(16);
  })();
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const fresh = share((e) => (e.media!.seasonYear ?? 0) >= year - 2);
  const old = share((e) => (e.media!.seasonYear ?? 9999) < 2010);
  const attributes = [
    { key: "stamina", name: "Выносливость", value: clamp((100 * Math.log1p(hours)) / Math.log1p(2500)), hint: `${hours} ч просмотра`,
      desc: "Сколько времени отдано аниме. Шкала логарифмическая: 100 — около 2500 часов." },
    { key: "grit", name: "Упорство", value: clamp(done.length + dropped ? (100 * done.length) / (done.length + dropped) : 0), hint: `досмотрено ${done.length}, брошено ${dropped}`,
      desc: "Доводите ли начатое до конца: доля досмотренного среди досмотренного и брошенного." },
    { key: "breadth", name: "Кругозор", value: clamp(entropy * 100), hint: `жанров в просмотренном: ${genreList.length}`,
      desc: "Насколько разнообразны жанры: 100 — смотрите всего понемногу, 0 — один жанр." },
    { key: "own", name: "Свой взгляд", value: clamp(deviation * 40), hint: withAvg.length ? `в среднем ±${deviation.toFixed(1)} от AniList` : "мало оценок",
      desc: "Насколько ваши оценки расходятся со средней AniList: 100 — расхождение в 2,5 балла и больше." },
    { key: "fresh", name: "На волне", value: clamp(fresh * 150), hint: `${pct(fresh)} — вышедшие за последние 3 года`,
      desc: "Следите ли за новинками: доля тайтлов последних трёх лет (100 — две трети и больше)." },
    { key: "classic", name: "Классика", value: clamp(old * 250), hint: `${pct(old)} — вышедшие до 2010`,
      desc: "Любовь к старому: доля тайтлов до 2010 года (100 — 40% и больше)." },
    { key: "generous", name: "Щедрость", value: clamp(mean ? (mean - 4) * (100 / 6) : 0), hint: mean ? `средняя оценка ${mean.toFixed(1)}` : "нет оценок",
      desc: "Насколько высоко вы оцениваете: средняя 4 — 0, средняя 10 — 100." },
    { key: "social", name: "Общительность", value: clamp(social.friends * 12 + social.comments * 3 + social.together * 10), hint: `друзей ${social.friends}, комментариев ${social.comments}, вместе ${social.together}`,
      desc: "Друзья, комментарии и совместный просмотр: друг — 12, комментарий — 3, тайтл вместе — 10." },
  ];

  // Форматы, эпохи (по 5 лет), активность за 12 месяцев, студии
  const count = <K,>(items: K[]) => { const m = new Map<K, number>(); for (const k of items) m.set(k, (m.get(k) ?? 0) + 1); return m; };
  const formats = [...count(seen.map((e) => e.media!.format ?? "?"))].map(([format, n]) => ({ format, count: n })).sort((a, b) => b.count - a.count);
  const eraMap = count(seen.filter((e) => e.media!.seasonYear).map((e) => Math.floor(e.media!.seasonYear! / 5) * 5));
  const eras = [...eraMap].map(([from, n]) => ({ from, count: n })).sort((a, b) => a.from - b.from);
  const months: string[] = [];
  const d = new Date(nowSec * 1000);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  const act = count(list.map((e) => { const t = new Date(e.updatedAt * 1000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`; }));
  const activity = months.map((month) => ({ month, count: act.get(month) ?? 0 }));
  const studios = [...count(seen.flatMap((e) => e.media!.studios ?? []))].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count).slice(0, 6);

  // Зал славы: высшие оценки (при равенстве — популярнее)
  const hall = [...scored].filter((e) => e.media && e.score >= 8)
    .sort((a, b) => b.score - a.score || b.media!.popularity - a.media!.popularity).slice(0, 8)
    .map((e) => ({ id: e.anilistId, title: titleOf(e), cover: e.media!.coverImage.large, color: e.media!.coverImage.color, score: e.score }));

  // Рекорды
  const records: RpgStats["records"] = [];
  const pick = (items: ListEntryWithMedia[], key: (e: ListEntryWithMedia) => number) => items.reduce<ListEntryWithMedia | null>((best, e) => (!best || key(e) > key(best) ? e : best), null);
  const longest = pick(done, (e) => e.media!.episodes ?? 0);
  if (longest?.media?.episodes) records.push({ kind: "longest", label: "Самый длинный", id: longest.anilistId, title: titleOf(longest), value: `${longest.media.episodes} серий` });
  const oldest = pick(seen.filter((e) => e.media!.seasonYear), (e) => -e.media!.seasonYear!);
  if (oldest) records.push({ kind: "oldest", label: "Самый старый", id: oldest.anilistId, title: titleOf(oldest), value: `${oldest.media!.seasonYear} год` });
  const mostTime = pick(seen, (e) => watchMinutes(e, e.media));
  if (mostTime) records.push({ kind: "time", label: "Больше всего времени", id: mostTime.anilistId, title: titleOf(mostTime), value: `${Math.round(watchMinutes(mostTime, mostTime.media) / 60)} ч` });
  // Скрытая жемчужина: высоко оценённое (8+) из малоизвестного — в списках меньше чем у 30 тыс.
  const hidden = pick(scored.filter((e) => e.score >= 8 && e.media && e.media.popularity < 30000), (e) => -e.media!.popularity);
  if (hidden) records.push({ kind: "gem", label: "Скрытая жемчужина", id: hidden.anilistId, title: titleOf(hidden), value: `★ ${hidden.score}, в списках у ${hidden.media!.popularity.toLocaleString("ru-RU")}` });
  const newest = pick(seen.filter((e) => e.media!.startDate.year), (e) => (e.media!.startDate.year ?? 0) * 400 + (e.media!.startDate.month ?? 0) * 31 + (e.media!.startDate.day ?? 0));
  if (newest) records.push({ kind: "newest", label: "Самый свежий", id: newest.anilistId, title: titleOf(newest), value: [newest.media!.season ? { WINTER: "зима", SPRING: "весна", SUMMER: "лето", FALL: "осень" }[newest.media!.season] : null, newest.media!.seasonYear].filter(Boolean).join(" ") });
  const popular = pick(seen, (e) => e.media!.popularity);
  if (popular) records.push({ kind: "popular", label: "Самый популярный", id: popular.anilistId, title: titleOf(popular), value: `в списках у ${popular.media!.popularity.toLocaleString("ru-RU")}` });
  const diff = (e: ListEntryWithMedia) => e.score - e.media!.averageScore! / 10;
  const above = pick(withAvg.filter((e) => diff(e) >= 1.5), diff);
  if (above) records.push({ kind: "above", label: "Цените выше всех", id: above.anilistId, title: titleOf(above), value: `ваша ${above.score}, AniList ${(above.media!.averageScore! / 10).toFixed(1)}` });
  const below = pick(withAvg.filter((e) => diff(e) <= -1.5), (e) => -diff(e));
  if (below) records.push({ kind: "below", label: "Не впечатлило", id: below.anilistId, title: titleOf(below), value: `ваша ${below.score}, AniList ${(below.media!.averageScore! / 10).toFixed(1)}` });
  const deepDrop = pick(list.filter((e) => e.status === "dropped" && e.media && e.episodes > 0), (e) => e.episodes);
  if (deepDrop) records.push({ kind: "drop", label: "Брошено дальше всех", id: deepDrop.anilistId, title: titleOf(deepDrop), value: `на ${deepDrop.episodes}-й серии` });
  const longFilm = pick(done.filter((e) => e.media!.format === "MOVIE" && e.media!.duration), (e) => e.media!.duration!);
  if (longFilm) records.push({ kind: "film", label: "Самый длинный фильм", id: longFilm.anilistId, title: titleOf(longFilm), value: `${longFilm.media!.duration} мин` });

  // Опыт — сумма наград; часы просмотра идут в «Время просмотра» (и после её платины)
  const fromHours = hours * HOUR_XP;
  const fromBadges = badgeXp(badges.filter((b) => b.id !== "hours").map((b) => b.tier));
  const level = levelOf(fromHours + fromBadges);
  const levelStart = xpForLevel(level.level);
  return {
    totals: {
      titles: list.length, completed: done.length, watching: list.filter((e) => e.status === "watching").length,
      dropped, planned: list.filter((e) => e.status === "planned").length, episodes: list.reduce((s, e) => s + e.episodes, 0), hours,
    },
    level: { ...level, rank: rankOf(level.level), fromHours, fromBadges, inLevel: Math.round(level.xp - levelStart), levelSize: Math.round(xpForLevel(level.level + 1) - levelStart) },
    klass, attributes, genres,
    scores: { hist, mean: mean === null ? null : Math.round(mean * 10) / 10, anilistMean: anilistMean === null ? null : Math.round(anilistMean * 10) / 10, count: scored.length },
    formats, eras, activity, studios, hall, records,
    banner: hall.map((h) => withMedia.find((e) => e.anilistId === h.id)?.media?.bannerImage).find(Boolean) ?? null,
  };
}
