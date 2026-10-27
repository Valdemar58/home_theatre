// Русские подписи для значений AniList.
import type { GalleryImage, ListStatus } from "./types";

export const FORMAT_LABELS: Record<string, string> = {
  TV: "TV-сериал",
  TV_SHORT: "Короткий TV",
  ONA: "ONA",
  OVA: "OVA",
  MOVIE: "Фильм",
  SPECIAL: "Спешл",
  MUSIC: "Клип",
};

export const GENRE_LABELS: Record<string, string> = {
  Action: "Экшен",
  Adventure: "Приключения",
  Comedy: "Комедия",
  Drama: "Драма",
  Ecchi: "Этти",
  Fantasy: "Фэнтези",
  Hentai: "Хентай",
  Horror: "Ужасы",
  "Mahou Shoujo": "Махо-сёдзё",
  Mecha: "Меха",
  Music: "Музыка",
  Mystery: "Детектив",
  Psychological: "Психологическое",
  Romance: "Романтика",
  "Sci-Fi": "Фантастика",
  "Slice of Life": "Повседневность",
  Sports: "Спорт",
  Supernatural: "Сверхъестественное",
  Thriller: "Триллер",
};

export const COUNTRY_LABELS: Record<string, string> = { JP: "Япония", CN: "Китай", KR: "Корея", TW: "Тайвань" };

export const SOURCE_LABELS: Record<string, string> = {
  ORIGINAL: "Оригинал",
  MANGA: "Манга",
  LIGHT_NOVEL: "Ранобэ",
  WEB_NOVEL: "Веб-новелла",
  NOVEL: "Роман",
  VISUAL_NOVEL: "Визуальная новелла",
  VIDEO_GAME: "Игра",
  WEB_MANGA: "Веб-манга",
  OTHER: "Другое",
};

export const STATUS_LABELS: Record<string, string> = {
  RELEASING: "Выходит",
  FINISHED: "Вышло",
  NOT_YET_RELEASED: "Анонс",
  CANCELLED: "Отменено",
  HIATUS: "Перерыв",
};

export const SEASON_LABELS: Record<string, string> = { WINTER: "Зима", SPRING: "Весна", SUMMER: "Лето", FALL: "Осень" };

export const LIST_LABELS: Record<ListStatus | "waiting", string> = {
  watching: "Смотрю",
  planned: "Запланировано",
  waiting: "Жду выхода",
  completed: "Просмотрено",
  on_hold: "Отложено",
  dropped: "Брошено",
  rewatching: "Пересматриваю",
};

export const RELATION_LABELS: Record<string, string> = {
  PREQUEL: "Предыстория",
  SEQUEL: "Продолжение",
  PARENT: "Основное",
  SIDE_STORY: "Побочная история",
  SPIN_OFF: "Спин-офф",
  ALTERNATIVE: "Альтернатива",
  SUMMARY: "Пересказ",
  OTHER: "Другое",
  CHARACTER: "Общие персонажи",
  COMPILATION: "Компиляция",
  SOURCE: "Первоисточник",
  ADAPTATION: "Адаптация",
};

export const label = (map: Record<string, string>, key: string | null | undefined) =>
  key ? (map[key] ?? key) : "—";

export const IMAGE_KIND_LABELS: Record<GalleryImage["kind"], string> = {
  poster: "Постер",
  banner: "Баннер",
  backdrop: "Фон",
  screenshot: "Кадр",
  portrait: "портрет",
};

/** Источники корпуса текстов о сериях */
export const CORPUS_SOURCE_LABELS: Record<string, string> = { sdh: "Субтитры", "wiki-en": "Википедия", fandom: "Fandom", mal: "MyAnimeList", danime: "dアニメストア", tmdb: "TMDB" };
