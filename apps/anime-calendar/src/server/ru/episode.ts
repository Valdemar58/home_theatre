// Номер серии из имени файла внутри раздачи и разбор наших же названий для Sonarr.
// Модуль чистый, чтобы его можно было тестировать.
import type { EpisodeRefLike } from "./title";

const isYear = (n: number) => n >= 1950 && n <= 2099;
const RESOLUTIONS = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160]);
const ok = (n: number) => n > 0 && n < 5000 && !isYear(n) && !RESOLUTIONS.has(n);

/**
 * Номер серии из имени файла:
 *   «Slime S3 [01].avi», «[AniLibria] Title - 05 [1080p].mkv», «Title.S03E07.mkv», «Title_Ep12.mkv», «07.mkv»
 */
export function localEpisode(fileName: string): number | null {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const patterns = [
    /S\d{1,2}\s?E(\d{1,4})/i,
    /(?:^|[\s._\-\[(])(?:E|EP|Ep\.?|Episode|Серия)\s?(\d{1,4})(?:v\d)?(?=$|[\s._\-\])])/i,
    /\[(\d{1,4})(?:v\d)?\]/,
    /\s-\s(\d{1,4})(?:v\d)?(?=$|[\s.\[(])/,
    /(?:^|[\s._])(\d{1,4})(?:v\d)?(?=$|[\s._\[(])/,
  ];
  for (const re of patterns) {
    for (const m of name.matchAll(new RegExp(re, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      const n = Number(m[1]);
      if (ok(n)) return n;
    }
  }
  return null;
}

/** Разобрать название, которое мы сами отдали Sonarr: «Title S02E13-24 [...]», «Title S03 [...]», «Title - 001-012 [...]» */
export function refFromTitle(title: string): EpisodeRefLike | null {
  const season = title.match(/\sS(\d{2})(?:E(\d{2,4})(?:-(\d{2,4}))?)?\s\[/);
  if (season) {
    const s = Number(season[1]);
    if (!season[2]) return { kind: "season", season: s, from: 1, to: 0, full: true };
    const from = Number(season[2]);
    return { kind: "season", season: s, from, to: season[3] ? Number(season[3]) : from, full: false };
  }
  const abs = title.match(/\s-\s(\d{3,4})(?:-(\d{3,4}))?\s\[/);
  if (abs) return { kind: "absolute", from: Number(abs[1]), to: abs[2] ? Number(abs[2]) : Number(abs[1]) };
  return null;
}

/**
 * Номера серий в файлах → серии Sonarr. В пакете второй части файлы часто пронумерованы
 * с 01, хотя в TVDB это 13–24: тогда сдвигаем на начало диапазона.
 */
export function assignEpisodes(
  locals: (number | null)[],
  ref: EpisodeRefLike,
): ({ season: number; episode: number } | { absolute: number } | null)[] {
  const nums = locals.filter((n): n is number => n !== null);
  if (!nums.length) return locals.map(() => null);
  const min = Math.min(...nums);
  if (ref.kind === "absolute") {
    const shift = min === 1 && ref.from > 1 ? ref.from - 1 : 0;
    return locals.map((n) => (n === null ? null : { absolute: n + shift }));
  }
  const shift = min === 1 && ref.from > 1 ? ref.from - 1 : 0;
  return locals.map((n) => (n === null ? null : { season: ref.season, episode: n + shift }));
}
