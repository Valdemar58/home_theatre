// Пользователи и приглашения (TASKS 7.9в): общие типы и правила для сервера и интерфейса.

/** Срок жизни ссылки-приглашения, дней */
export const INVITE_DAYS = 7;
/** Сколько действующих приглашений может держать не-админ */
export const INVITE_LIMIT = 5;

export const inviteLimitReached = (active: number) => active >= INVITE_LIMIT;

/** Куда вернуться после входа: только свой путь — не чужой сайт («//evil», «https://…», «/\\evil»). */
export const safeNext = (next: string | null | undefined) => {
  if (!next || !next.startsWith("/") || /[\\\u0000-\u0020\u007f]/.test(next))
    return "/calendar";
  try {
    return new URL(next, "https://home.invalid").origin ===
      "https://home.invalid"
      ? next
      : "/calendar";
  } catch {
    return "/calendar";
  }
};

type Ref = { id: number; name: string };

export type InviteState = "active" | "pending" | "used" | "expired" | "revoked";

export type InviteView = {
  id: string;
  /** Ссылка — только у действующего */
  link: string | null;
  note: string | null;
  /** Группа просмотра, куда позвать после одобрения */
  group: string | null;
  createdAt: number;
  expiresAt: number;
  state: InviteState;
  usedBy: Ref | null;
  inviter: Ref;
};

export type SignupRequest = {
  authPk: number;
  username: string;
  email: string | null;
  createdAt: number;
  inviter: Ref | null;
};

export type Account = {
  id: number;
  name: string;
  email: string | null;
  admin: boolean;
  blocked: boolean;
  /** Есть учётка единого входа (входил через Authentik или одобрен) */
  linked: boolean;
  lastLogin: number | null;
  invitedBy: Ref | null;
  createdAt: number;
  /** Доступ к библиотекам Jellyfin; null — учётки Jellyfin нет */
  libraries: boolean | null;
};

export type AccountsView = {
  sso: boolean;
  accounts: Account[];
  requests: SignupRequest[];
  invites: InviteView[];
};

export const INVITE_STATE_LABEL: Record<InviteState, string> = {
  active: "действует",
  pending: "ждёт одобрения",
  used: "принято",
  expired: "истекло",
  revoked: "отозвано",
};
