import type { EpisodeInfo } from "./types";

// Чистые правила для сюжета: заглушки описаний, сборка серий сезона из TMDB/Kitsu.

/** Описание-заглушка: «Третий сезон аниме А.», «Продолжение «…».» — или его нет вовсе. */
export function isStubDescription(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/<[^>]+>/g, "").trim();
  return t.length < 160;
}

/** Название серии без смысла: «Эпизод 5», «Episode 5», «Серия 5». */
export function isGenericEpisodeTitle(title: string | null | undefined): boolean {
  return !title || /^(эпизод|серия|episode|ep\.?)\s*\d+$/i.test(title.trim());
}

export type RawEpisode = { number: number; title: string | null; overview: string | null; airDate: string | null; still: string | null };

/**
 * Серии одного тайтла AniList из сезона TMDB: сдвиг (вторая часть сезона начинается с 13-й серии)
 * и число серий тайтла; номера — с 1. Русские поля дополняются английскими, где русских нет.
 */
export function seasonEpisodes(ru: RawEpisode[], en: RawEpisode[], offset: number, count: number | null): EpisodeInfo[] {
  const enBy = new Map(en.map((e) => [e.number, e]));
  return ru
    .filter((e) => e.number > offset && (count === null || e.number <= offset + count))
    .sort((a, b) => a.number - b.number)
    .map((e) => {
      const alt = enBy.get(e.number);
      const ruText = e.overview?.trim() || null;
      const enText = alt?.overview?.trim() || null;
      return {
        number: e.number - offset,
        title: !isGenericEpisodeTitle(e.title) ? e.title : !isGenericEpisodeTitle(alt?.title) ? alt!.title : null,
        overview: ruText ?? enText,
        lang: ruText ? "ru" : enText ? "en" : null,
        airDate: e.airDate ?? alt?.airDate ?? null,
        still: e.still ?? alt?.still ?? null,
      };
    });
}

/** Дополнить серии вторым источником (Kitsu): пустые названия, описания и кадры. */
export function fillEpisodes(base: EpisodeInfo[], extra: EpisodeInfo[]): EpisodeInfo[] {
  if (!base.length) return extra;
  const by = new Map(extra.map((e) => [e.number, e]));
  return base.map((e) => {
    const x = by.get(e.number);
    if (!x) return e;
    return {
      ...e,
      title: e.title ?? x.title,
      overview: e.overview ?? x.overview,
      lang: e.overview ? e.lang : x.overview ? x.lang : null,
      airDate: e.airDate ?? x.airDate,
      still: e.still ?? x.still,
    };
  });
}

/** Сколько серий с описанием: по этому решаем, нужен ли запасной источник. */
export const described = (eps: EpisodeInfo[]) => eps.filter((e) => e.overview).length;

/** Описания серий для подсказки LLM: обрезанные и в общем бюджете символов. */
export function episodeDigest(eps: EpisodeInfo[], budget: number, perEpisode = 260): string {
  const lines: string[] = [];
  let used = 0;
  for (const e of eps) {
    if (!e.overview) continue;
    const text = e.overview.replace(/\s+/g, " ").trim();
    const line = `${e.number}. ${e.title ? `«${e.title}» — ` : ""}${text.length > perEpisode ? `${text.slice(0, perEpisode)}…` : text}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export type AirWindow = { start: string | null; end: string | null };

/** Дата AniList (год, месяц, день) → YYYY-MM-DD; неполная — null. */
export const fuzzyIso = (f: { year: number | null; month: number | null; day: number | null } | null | undefined) =>
  f?.year && f.month && f.day ? `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}` : null;

const DAY = 86400_000;

/**
 * Сколько серий сезона вышло в период показа тайтла (±14 дней; без конца — по сегодня) и с какой серии
 * сезона он начинается. Так видно, что anime-lists указали не тот сезон TMDB (серии прошлого года).
 */
export function seasonFit(eps: RawEpisode[], w: AirWindow, today = Date.now()): { inside: number; dated: number; offset: number } {
  if (!w.start) return { inside: 0, dated: 0, offset: 0 };
  const from = Date.parse(w.start) - 14 * DAY;
  const to = (w.end ? Date.parse(w.end) : today) + 14 * DAY;
  const dated = eps.filter((e) => e.airDate).sort((a, b) => a.number - b.number);
  const inside = dated.filter((e) => Date.parse(e.airDate!) >= from && Date.parse(e.airDate!) <= to);
  // Первая серия тайтла — первая вышедшая не раньше чем за 3 дня до начала показа
  const first = dated.find((e) => Date.parse(e.airDate!) >= Date.parse(w.start!) - 3 * DAY);
  return { inside: inside.length, dated: dated.length, offset: first ? first.number - 1 : 0 };
}
