// Адрес картинки для <img>: через серверный кэш (/api/img) с нужным размером.
// Кэшируются только известные источники; остальные — напрямую.

export type ImgSize = "tiny" | "thumb" | "card" | "full";

/** Ширина уменьшенных копий (с запасом под экраны с плотностью 2x); tiny — размытая заглушка на время загрузки. */
export const IMG_SIZES = { tiny: 32, thumb: 240, card: 480 } as const;

// Версия в адресе: ответы кэшируются браузером навсегда (immutable), поэтому при смене
// содержимого (крупнее оригиналы, апскейл) меняем версию — иначе браузер покажет старое.
// v2 — обложки AniList в 460px вместо 230px; v3 — общий ключ для medium/large-адресов одной обложки.
const IMG_V = 3;

// Источники: AniList, Shikimori, TMDB, TheTVDB, YouTube и VK (превью видео), обложки AniLib
const HOSTS = [
  "anilist.co", "shikimori.io", "shikimori.one", "image.tmdb.org", "artworks.thetvdb.com", "kitsu.app",
  "img.youtube.com", "i.ytimg.com", "userapi.com", "cdnlibs.org", "imglib.info", "wikia.nocookie.net",
];

export function isCacheable(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function imgSrc(url: string, size: ImgSize = "full", upscaled = false): string {
  if (!url || !isCacheable(url)) return url;
  return `/api/img?u=${encodeURIComponent(url)}&s=${size}&v=${IMG_V}${upscaled ? "&up=1" : ""}`;
}
