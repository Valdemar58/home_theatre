// Общие типы для сервера и клиента.
import type { DeepState } from "./plot-deep";

export type FuzzyDate = { year: number | null; month: number | null; day: number | null };

export type MediaLite = {
  id: number;
  idMal: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  countryOfOrigin: string | null;
  source: string | null;
  isAdult: boolean;
  /** Оценка AniList, 0–100 */
  averageScore: number | null;
  /** Оценка MAL (через Shikimori), 0–10 */
  malScore: number | null;
  popularity: number;
  genres: string[];
  title: { romaji: string | null; english: string | null; native: string | null; ru: string | null };
  coverImage: { large: string | null; color: string | null };
  bannerImage: string | null;
  studios: string[];
  startDate: FuzzyDate;
  endDate: FuzzyDate;
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  /** Время выхода финальной серии (есть только в снимках для списков) */
  finaleAt?: number | null;
};

export type Airing = { mediaId: number; episode: number; airingAt: number };

export type CalendarResponse = { media: Record<number, MediaLite>; airings: Airing[] };

export const LIST_STATUSES = ["watching", "planned", "completed", "on_hold", "dropped", "rewatching"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export type ListEntry = {
  anilistId: number;
  malId: number | null;
  status: ListStatus;
  /** Локальный статус «Жду выхода» (в Shikimori уходит как planned) */
  waiting: boolean;
  episodes: number;
  score: number;
  updatedAt: number;
  /** Впечатления (только локально, в Shikimori не уходят) */
  note: string | null;
  /** Личные теги: «так плохо, что смешно», «озвучка решает»… */
  tags: string[];
  /** Студия озвучки, с которой смотрел */
  voice: string | null;
  /** «Рекомендую к просмотру»: да / нет / не выбрано */
  recommend: boolean | null;
  /** Скрыто от друзей */
  private: boolean;
  /** Сколько серий было вышедшими при последней отметке (для «+N новых») */
  airedMark: number | null;
};

export type ListEntryWithMedia = ListEntry & { media: MediaLite | null };

export type GalleryImage = {
  url: string;
  thumb: string;
  kind: "poster" | "banner" | "backdrop" | "screenshot" | "portrait";
  source: "AniList" | "TMDB" | "Shikimori" | "Fandom";
  /** Подпись вместо «вид · источник» (облик персонажа: «Облик Сидзу · с 8 серии») */
  caption?: string;
};

/** Видео с Shikimori: опенинги, эндинги, трейлеры, клипы (YouTube / VK). */
export type AnimeVideo = {
  kind: "op" | "ed" | "pv" | "op_ed_clip" | "character_trailer" | "episode_preview" | "other";
  name: string | null;
  /** Страница видео на сайте-источнике */
  url: string;
  /** Адрес для встраиваемого плеера (https) */
  player: string;
  image: string | null;
};

/** Галерея тайтла — отдельным запросом, чтобы страница не ждала Shikimori/TMDB */
export type AnimeImages = {
  /** Опенинги, эндинги, трейлеры */
  videos: AnimeVideo[];
  /** Постеры, баннеры, фоны и кадры */
  images: GalleryImage[];
  /** Широкая картинка для фона страницы (лучшая из доступных) */
  backdrop: string | null;
};

export type AnimeDetails = MediaLite & {
  /** Постер в максимальном размере */
  coverXL: string | null;
  description: string | null;
  synonyms: string[];
  trailer: { id: string; site: string } | null;
  schedule: { episode: number; airingAt: number }[];
  relations: { relationType: string; media: MediaLite }[];
  tags: { name: string; rank: number; spoiler: boolean }[];
  externalIds: { tmdbTv: number | null; tmdbMovie: number | null; tvdb: number | null; tmdbSeason: number | null };
};

/** Серия: название и описание из TMDB (русские, иначе английские) или Kitsu */
export type EpisodeInfo = {
  number: number;
  title: string | null;
  overview: string | null;
  /** Язык описания: английское показываем, если русского нет */
  lang: "ru" | "en" | null;
  airDate: string | null;
  still: string | null;
  /** Есть подробный пересказ в корпусе сюжета (сам текст — по кнопке, /api/anime/[id]/corpus?ep=N) */
  detail?: { sources: string[]; chars: number } | null;
};

/** Тексты одной серии из корпуса сюжета: по источникам, подробные первыми */
export type EpisodeTexts = {
  source: string; lang: string; depth: "teaser" | "full" | "script"; title: string | null; text: string; url: string | null;
  /** Перевод на русский (ИИ), если уже сделан */
  translation: { text: string; model: string; provider: string } | null;
}[];

/** Сюжет тайтла: серии, синопсис от ИИ вместо заглушки, «что было раньше» */
export type PlotInfo = {
  episodes: EpisodeInfo[];
  source: "TMDB" | "Kitsu" | null;
  /** Описание Shikimori — заглушка вида «Второй сезон …» (или его нет) */
  stub: boolean;
  /** Синопсис вместо заглушки: описание сезона из TMDB или составленный ИИ (по AniList, TMDB и первым сериям) */
  synopsis: string | null;
  synopsisBy: "tmdb" | "ai" | null;
  /** Синопсис ещё составляется */
  pending: boolean;
  /** Есть предыдущие сезоны — можно составить пересказ */
  hasPrequels: boolean;
  /** thin — о последней из прошлых частей известна только завязка (нет описаний серий) */
  recap: { text: string; points: string[]; prequels: { id: number; title: string }[]; thin: boolean } | null;
  /** Пересказ сезона ИИ по порциям серий (слепо по порядку): что показать — решает курсор зрителя (stateAt) */
  season: { states: DeepState[]; total: number; model: string | null } | null;
};

export type SeerrStatus = {
  configured: boolean;
  found: boolean;
  /** "mapping" — точное соответствие из anime-lists, "search" — найдено поиском по названию */
  matchedBy?: "mapping" | "search";
  mediaType?: "tv" | "movie";
  tmdbId?: number;
  title?: string;
  status?: number;
  seasons?: { seasonNumber: number; name: string; episodeCount: number; status: number }[];
  suggestedSeason?: number | null;
  url?: string;
};

// ---------------------------------------------------------------- AniLib

export type LibField = "status" | "episodes" | "score";

/** Что синхронизация сделает с закладкой AniLib. */
export type LibAction =
  | "add"        // в календаре нет — добавить
  | "update"     // изменилось на AniLib (или пустое в календаре) — обновить
  | "conflict"   // изменено и там, и тут — остаётся как в календаре
  | "same"       // без изменений
  | "removed"    // удалено из календаря после прошлой синхронизации — не возвращаем
  | "unmatched"  // не нашли в AniList — нужно сопоставить вручную
  | "skipped";   // папка AniLib без пары в календаре

export type LibValues = { status: ListStatus | null; episodes: number | null; score: number | null };

export type LibPlanItem = {
  libMediaId: number;
  title: string;
  original: string;
  cover: string | null;
  url: string;
  folder: string;
  anilistId: number | null;
  /** Как сопоставлено: id от AniLib, вручную или поиском по названию */
  how: "anilib" | "manual" | "search" | null;
  action: LibAction;
  lib: LibValues;
  local: LibValues | null;
  /** Поля, которые изменятся */
  fields: LibField[];
  /** Поля, изменённые и там, и тут: остаются как в календаре */
  conflicts: LibField[];
};

export type LibPlan = { items: LibPlanItem[]; counts: Record<LibAction, number> };

export type LibProgress = {
  stage: "fetch" | "match" | "apply" | "done" | "error";
  done: number;
  total: number;
  /** true — с записью в список, false — только предпросмотр */
  apply: boolean;
  plan?: LibPlan;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type LibStatus = {
  linked: boolean;
  userId: number | null;
  nickname: string | null;
  profileUrl: string | null;
  syncedAt: number | null;
  error: string | null;
  progress: LibProgress | null;
};

// ---------------------------------------------------------------- карточка: прогноз и похожее

/** «Насколько мне понравится» — процент и объяснение (без LLM). */
export type MatchInfo = {
  percent: number;
  verdict: string;
  /** Похоже на понравившееся мне */
  similarTo: { id: number; title: string }[];
  /** Похоже на то, что я бросил или оценил низко */
  dislikedSimilar: { id: number; title: string }[];
  likedTags: string[];
  dislikedTags: string[];
  /** По разбору ИИ: что в тайтле совпадает со вкусом («мрачный тон», «юмор: пародия») и что против него */
  likedTraits?: string[];
  dislikedTraits?: string[];
  /** Мало понравившегося в списке — прогноз неуверенный */
  lowConfidence: boolean;
};

export type SimilarItem = {
  media: MediaLite;
  /** Похожесть на этот тайтл, 0–100 */
  similarity: number;
  /** Прогноз «насколько понравится» (для непросмотренного) */
  match: number | null;
  watched: boolean;
};

/** Действие прямо в уведомлении. */
export type NoticeAction =
  | { type: "friend"; userId: number }
  | { type: "shared-invite"; listId: number }
  | { type: "undo"; eventId: number }
  | { type: "link"; label: string; href: string };

/** Уведомление (колокольчик в шапке, страница «Уведомления») */
export type Notice = {
  id: number;
  kind: string;
  group: import("./notice-kinds").NoticeGroup;
  /** Ошибка фоновой задачи */
  error: boolean;
  /** Что произошло — короткой строкой */
  title: string;
  body: string | null;
  href: string | null;
  createdAt: number;
  read: boolean;
  /** К какому тайтлу (обложка и название) */
  media: { id: number; title: string; cover: string | null; color: string | null } | null;
  /** Кто (аватар) */
  actor: { id: number; name: string } | null;
  /** Подпись вместо тайтла/автора, если их нет (например, раздача без тайтла) */
  subject: string | null;
  actions: NoticeAction[];
  /** Награда и полученный уровень (уведомление «Награда») */
  achievement: { id: string; tier: number } | null;
};

export type NoticeCounts = Record<import("./notice-kinds").NoticeGroup | "all", number>;

export type TaskStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** Фоновая задача (поиск озвучек и т. п.) */
export type TaskInfo = {
  id: number;
  kind: string;
  key: string;
  status: TaskStatus;
  origin: "user" | "auto" | "schedule";
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
};

/** Сбор корпуса сюжета (задача «corpus»): шаг, сколько сделано, что нашлось по источникам */
export type CorpusProgress = {
  anilistId: number;
  /** Текущий шаг: источник или пересказ */
  step: string;
  done: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  finished: boolean;
  /** Сколько примерно осталось, с (на момент updatedAt) */
  etaSec: number | null;
  /** Серий с текстом по источникам */
  found: Record<string, number>;
  errors: string[];
};

/** Корпус сюжета тайтла: задача, её прогресс и что уже собрано */
export type CorpusState = {
  task: TaskInfo | null;
  progress: CorpusProgress | null;
  /** Серий с каким-либо текстом и с подробным пересказом */
  episodes: number;
  deep: number;
  /** Серий по источникам: tmdb, wiki-en, fandom, danime */
  sources: Record<string, number>;
};

/** Озвучки тайтла: найденное фоновой задачей и её состояние */
export type VoicesState = {
  data: import("@/server/ru/releases").RuReleasesResponse | null;
  fetchedAt: number | null;
  task: TaskInfo | null;
};

/** Совпадение вкусов двух пользователей. */
export type TasteMatch = {
  /** 0–100 */
  percent: number;
  /** Общих тайтлов с оценкой у обоих */
  common: number;
  /** Насколько совпадают оценки общих (0–100), если их ≥ MIN_COMMON */
  agree: number | null;
  /** Обоим понравилось (без скрытых записей) */
  bothLiked: { id: number; title: string }[];
};

/** Другой пользователь сервера глазами текущего. */
export type Person = {
  id: number;
  name: string;
  state: import("./social-rules").FriendState;
  /** Профиль и списки открыты текущему */
  visible: boolean;
  /** Совпадение вкусов, 0–100 (null — мало данных или профиль скрыт) */
  taste: number | null;
};

export type ProfileStats = {
  total: number;
  byStatus: Partial<Record<ListStatus, number>>;
  meanScore: number | null;
  hours: number;
  episodes: number;
  topGenres: string[];
};

export type Profile = {
  user: { id: number; name: string };
  self: boolean;
  state: import("./social-rules").FriendState;
  visible: boolean;
  /** Только для своего профиля */
  visibility?: import("./social-rules").Visibility;
  stats: ProfileStats | null;
  /** Совпадение вкусов со мной (чужой открытый профиль, если хватает данных) */
  taste: TasteMatch | null;
};

/** Тайтл, который советуют друзья. */
export type FriendPick = {
  media: MediaLite;
  by: { id: number; name: string; taste: number | null }[];
  weight: number;
};

/** Друг о тайтле (для страницы тайтла). */
export type FriendOpinion = {
  user: { id: number; name: string };
  status: ListStatus;
  episodes: number;
  score: number;
  recommend: boolean | null;
  updatedAt: number;
  /** Совпадение вкусов со мной */
  taste: number | null;
};

/** Участник общего списка. */
export type SharedMember = { id: number; name: string; status: "invited" | "member" };

export type SharedListSummary = {
  id: number;
  name: string;
  ownerId: number;
  role: "owner" | "member" | "invited";
  members: SharedMember[];
  counts: { total: number; watching: number; done: number };
  covers: string[];
};

/** Тайтл общего списка: живые статусы участников из их личных списков. */
export type SharedItem = {
  media: MediaLite;
  addedBy: number | null;
  addedAt: number;
  members: { userId: number; status: ListStatus | null; episodes: number; score: number; updatedAt: number | null; hidden: boolean }[];
  state: "planned" | "watching" | "done";
};

export type SharedListDetail = {
  id: number;
  name: string;
  ownerId: number;
  role: "owner" | "member" | "invited";
  members: SharedMember[];
  items: SharedItem[];
};

/** Кандидат в окне «Посмотрели вместе». */
export type CoWatcher = {
  id: number;
  name: string;
  me: boolean;
  /** Участник общего списка с этим тайтлом — отмечен по умолчанию */
  inSharedList: boolean;
  status: ListStatus | null;
  episodes: number;
};

/** Идёт «Смотрим вместе с…». */
export type WatchSessionInfo = {
  id: number;
  owner: { id: number; name: string };
  /** Я — владелец (мои серии засчитываются остальным) */
  mine: boolean;
  members: { id: number; name: string }[];
  startedAt: number;
  lastActivity: number;
};

export type TogetherState = {
  people: CoWatcher[];
  /** Серия по умолчанию в окне */
  upTo: number;
  /** Мои общие списки: есть ли там тайтл */
  lists: { id: number; name: string; has: boolean }[];
  session: WatchSessionInfo | null;
};

/** Отметка «вместе», сделанная мне кем-то (для «Отменить»). */
export type TogetherEvent = { actor: string; anilistId: number; from: number; to: number; undone: boolean; createdAt: number };

/** Комментарий под тайтлом (плоский список; дерево строит клиент — lib/comments-tree.ts). */
export type CommentItem = {
  id: number;
  parentId: number | null;
  user: { id: number; name: string };
  body: string;
  spoiler: boolean;
  /** К какой серии (необязательно) */
  episode: number | null;
  createdAt: number;
  editedAt: number | null;
  /** Удалён, но остался ради ответов */
  deleted: boolean;
  /** Мой (можно править) */
  mine: boolean;
  /** Оценка тайтла автором, если его список мне виден */
  score: number | null;
};

/** Сохранённый набор фильтров каталога. */
export type FilterPreset = { id: number; name: string; query: string; isDefault: boolean };

// ---------------------------------------------------------------- персонажи и граф сюжета

export type CharacterRole = "MAIN" | "SUPPORTING" | "BACKGROUND";

/** Персонаж тайтла: AniList + русское имя Shikimori */
export type CharacterLite = {
  id: number;
  name: string;
  nameRu: string | null;
  native: string | null;
  image: string | null;
  role: CharacterRole;
  /** Сэйю (японский голос) */
  voice: string | null;
};

/** На какую серию показывать сюжет: мой прогресс, выбранная серия или весь сезон */
export type PlotViewMode = "progress" | "ep" | "all";
export type PlotCursor = {
  /** Досмотрено до серии (весь сезон — 1e6) */
  ep: number;
  mode: PlotViewMode;
  /** Мой прогресс по списку */
  watched: number;
  inList: boolean;
  total: number | null;
};

/** Отношение персонажа (граф сюжета; со сроком действия по сериям) */
export type PlotRelationInfo = {
  otherId: number;
  otherHref: string;
  otherName: string;
  otherImage: string | null;
  kind: string;
  label: string | null;
  anilistId: number;
  fromEp: number | null;
  /** Кончилось в серии (если зритель это уже видел) */
  endedEp: number | null;
};

export type PlotEventInfo = {
  id: number; key: string | null; anilistId: number; title: string; summary: string | null; kind: string | null;
  epFrom: number | null; epTo: number | null; major: boolean; role: string | null;
};

/** Персонаж в составе тайтла на серию курсора */
export type CastMember = {
  /** Сущность графа (главная из склеенных) */
  id: number;
  /** Все склеенные с ним сущности, раскрытые к курсору (для имён в тексте) */
  entities: number[];
  href: string;
  anilistCharId: number | null;
  name: string;
  native: string | null;
  role: CharacterRole;
  image: string | null;
  lookLabel: string | null;
  description: string | null;
  goal: string | null;
  groups: { id: number; name: string; role: string | null }[];
  /** Другие имена, раскрытые к курсору («он же …») */
  aka: string[];
  firstEp: number | null;
  voice: string | null;
};

export type TitleCast = {
  cursor: PlotCursor;
  /** Граф построен (иначе — состав из AniList без сюжета) */
  built: boolean;
  upTo: number;
  groupWord: string | null;
  powerSystem: boolean;
  members: CastMember[];
  groups: { id: number; name: string; count: number }[];
  /** Сколько персонажей появится после курсора */
  hidden: number;
  /** Для блока «Сюжет»: связей, событий и арок на курсор */
  stats: { relations: number; events: number; arcs: number };
};

/** Событие сюжета на курсор зрителя: участники, причины и последствия, которые он уже видел */
export type EventLinkInfo = { kind: string; note: string | null; key: string; anilistId: number; title: string; ep: number | null };
export type EventBrief = {
  key: string;
  anilistId: number;
  title: string;
  summary: string | null;
  kind: string | null;
  epFrom: number | null;
  epTo: number | null;
  arc: string | null;
  major: boolean;
  participants: { id: number; name: string; href: string; image: string | null; role: string | null }[];
  /** Что к нему привело (причина, повод, условие, мотив) */
  causes: EventLinkInfo[];
  /** К чему привело — только раскрытое к курсору */
  consequences: EventLinkInfo[];
};
export type EventDetails = EventBrief & {
  course: string | null;
  motives: { id: number; name: string; href: string; text: string }[];
  /** Последствий после курсора */
  hiddenConsequences: number;
  sources: string[];
  /** Событие после курсора зрителя — не показываем */
  hiddenUntil: number | null;
  cursor: PlotCursor;
};
export type TitleEvents = { cursor: PlotCursor; arcs: { name: string | null; events: EventBrief[] }[]; hidden: number };

/** Имя в тексте → персонаж (spoiler — зритель его ещё не видел) */
export type NameRef = {
  alias: string; entity: number; href: string; spoiler: boolean; anilistId: number | null; revealedEp: number;
  /** Имя привязано к особому облику (прошлая жизнь, маскировка): карточка — под этим именем и с этим обликом */
  as: { name: string; image: string | null; lookLabel: string } | null;
};

export type CharacterDetails = {
  id: number | null;
  entityId: number | null;
  href: string;
  name: string;
  nameRu: string | null;
  native: string | null;
  alternative: string[];
  image: string | null;
  /** Описание AniList; спойлеры размечены ~!…!~ */
  description: string | null;
  /** Кто это — по разбору серий, на серию курсора */
  plotDescription: string | null;
  goal: string | null;
  gender: string | null;
  age: string | null;
  /** Облики, показанные к курсору; future — сколько ещё будет */
  looks: { image: string; label: string | null; anilistId: number | null; fromEp: number | null }[];
  futureLooks: number;
  names: { name: string; kind: string; who: string | null; fromEp: number | null; anilistId: number | null }[];
  futureNames: number;
  /** Склеенные с ним персонажи («он же»), раскрытые к курсору */
  aka: { name: string; href: string; revealedEp: number; anilistId: number }[];
  /** Страница склеена с другой — перейти туда */
  redirect: string | null;
  /** Персонаж ещё не появлялся у зрителя */
  hiddenUntil: { anilistId: number; ep: number } | null;
  groups: { id: number; name: string; role: string | null; past: boolean }[];
  appearances: { media: MediaLite; role: CharacterRole }[];
  relations: PlotRelationInfo[];
  events: PlotEventInfo[];
  /** Только если в тайтле есть система сил */
  abilities: { name: string; text: string | null; status: string; fromEp: number; anilistId: number }[] | null;
};
