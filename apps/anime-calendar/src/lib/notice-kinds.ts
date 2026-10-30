// Виды уведомлений: вкладка, подпись, цвет и значок. Общие для сервера (вкладка пишется в базу)
// и интерфейса (метка вида в карточке уведомления).

export type NoticeGroup = "titles" | "friends" | "achievements" | "important";
export const NOTICE_GROUPS: [NoticeGroup | "all", string][] = [["all", "Все"], ["titles", "Тайтлы"], ["friends", "Друзья"], ["achievements", "Достижения"], ["important", "Важное"]];

export type NoticeIcon = "play" | "flag" | "speaker" | "bolt" | "user" | "list" | "users" | "chat" | "alert" | "info" | "trophy" | "book";
/** Тон палитры (globals.css) */
export type NoticeTone = "accent" | "special" | "positive" | "negative" | "warning" | "info" | "neutral";

type KindInfo = { label: string; group: NoticeGroup; icon: NoticeIcon; tone: NoticeTone };

export const NOTICE_KINDS: Record<string, KindInfo> = {
  episode: { label: "Новая серия", group: "titles", icon: "play", tone: "accent" },
  finale: { label: "Вышел целиком", group: "titles", icon: "flag", tone: "special" },
  voices: { label: "Озвучки", group: "titles", icon: "speaker", tone: "info" },
  prebuffer: { label: "Можно смотреть", group: "titles", icon: "bolt", tone: "positive" },
  chapter: { label: "Новая глава", group: "titles", icon: "book", tone: "accent" },
  friend: { label: "Друзья", group: "friends", icon: "user", tone: "special" },
  "shared-list": { label: "Общий список", group: "friends", icon: "list", tone: "warning" },
  together: { label: "Смотрели вместе", group: "friends", icon: "users", tone: "positive" },
  room: { label: "Смотрим вместе", group: "friends", icon: "users", tone: "accent" },
  group: { label: "Группа", group: "friends", icon: "users", tone: "special" },
  "together-suggest": { label: "Смотрели вместе?", group: "friends", icon: "users", tone: "positive" },
  comment: { label: "Ответ на комментарий", group: "friends", icon: "chat", tone: "info" },
  achievement: { label: "Награда", group: "achievements", icon: "trophy", tone: "warning" },
  signup: { label: "Приглашение", group: "important", icon: "user", tone: "positive" },
};

const OTHER: KindInfo = { label: "Система", group: "important", icon: "info", tone: "neutral" };
const ERROR: KindInfo = { label: "Ошибка", group: "important", icon: "alert", tone: "negative" };

/** Вид уведомления; ошибка любой задачи — «Важное». */
export const kindInfo = (kind: string, error = false): KindInfo => (error ? ERROR : NOTICE_KINDS[kind] ?? OTHER);
