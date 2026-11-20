import "server-only";
import { randomUUID } from "node:crypto";
import {
  hashPassword,
  verifyPassword,
  tokenHash,
  newToken,
} from "../../database/account-security.mjs";
import { db, now } from "./db";
import { ApiError, adminOnly } from "./route";
import { env } from "./env";
import type { User } from "./session";
import type { AccountsView, InviteView } from "@/lib/accounts";
import { requireGroupCapability } from "./group-policy";
import { inviteToList } from "./together";
import { sealInvitation, openInvitation } from "./invitation-secret";

type Credential = {
  user_id: number;
  login: string;
  password_hash: string;
  access: "pending" | "approved" | "blocked";
  session_version: number;
  created_at: number;
  last_login: number | null;
};
type Token = {
  id: string;
  token_hash: string;
  token_secret: string | null;
  purpose: "invite" | "reset" | "claim";
  user_id: number | null;
  issuer_id: number | null;
  group_id: number | null;
  note: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
  revoked: number;
};
export const legacyAuthEnabled = () =>
  process.env.LEGACY_AUTH_ENABLED === "1" &&
  !db
    .prepare(
      "SELECT user_id FROM local_accounts WHERE access='approved' LIMIT 1",
    )
    .get();
export const credential = (id: number) =>
  db
    .prepare<
      [number],
      Credential
    >("SELECT * FROM local_accounts WHERE user_id=?")
    .get(id);
function requireAdmin(actor: User) {
  adminOnly(actor);
  const current = db
    .prepare<
      [number],
      { is_admin: number; blocked: number }
    >("SELECT is_admin,blocked FROM users WHERE id=?")
    .get(actor.id);
  if (!current?.is_admin || current.blocked)
    throw new ApiError(403, "Только для администратора");
}
export function audit(
  user: number | null,
  actor: number | null,
  action: string,
) {
  db.prepare(
    "INSERT INTO account_audit(id,user_id,actor_id,action,created_at) VALUES(?,?,?,?,?)",
  ).run(randomUUID(), user, actor, action, now());
}
export function loginName(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(value)
  )
    throw new ApiError(
      400,
      "Логин: 3–40 латинских букв, цифр, точек, дефисов или подчёркиваний",
    );
  return value.toLowerCase();
}
function nickname(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60)
    throw new ApiError(400, "Укажите ник до 60 символов");
  return value.trim();
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  let valid = false;
  try {
    const url = new URL(origin ?? "");
    valid =
      ["http:", "https:"].includes(url.protocol) &&
      url.host === req.headers.get("host");
  } catch {}
  if (!valid) throw new ApiError(403, "Откройте действие в приложении");
}
export async function authBody(req: Request) {
  sameOrigin(req);
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        throw new ApiError(413, "Слишком большой запрос");
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Некорректный запрос");
  }
}
export function limit(key: string, max: number, seconds: number) {
  db.transaction(() => {
    db.prepare("DELETE FROM account_attempts WHERE resets_at<=?").run(now());
    const hash = tokenHash(key);
    db.prepare(
      "INSERT INTO account_attempts(key,count,resets_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=account_attempts.count+1",
    ).run(hash, now() + seconds);
    const row = db
      .prepare<
        [string],
        { count: number }
      >("SELECT count FROM account_attempts WHERE key=?")
      .get(hash)!;
    if (row.count > max)
      throw new ApiError(429, "Слишком много попыток. Попробуйте позже");
  })();
}
export function authLimit(req: Request, operation: string) {
  // The per-account limit below remains effective if an untrusted client spoofs proxy headers.
  const ip =
    req.headers.get("x-public-access") === "1"
      ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "remote"
      : "local";
  limit(
    `auth:${operation}:${ip}`,
    operation === "register" ? 8 : 60,
    operation === "register" ? 3600 : 900,
  );
}
function tokenRow(raw: unknown, purpose?: Token["purpose"]) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    throw new ApiError(400, "Ссылка недействительна или уже использована");
  const t = db
    .prepare<[string], Token>("SELECT * FROM account_tokens WHERE token_hash=?")
    .get(tokenHash(raw));
  if (
    !t ||
    t.revoked ||
    t.used_at !== null ||
    t.expires_at <= now() ||
    (purpose && t.purpose !== purpose)
  )
    throw new ApiError(400, "Ссылка недействительна или уже использована");
  if (
    t.purpose === "invite" &&
    !db
      .prepare("SELECT id FROM users WHERE id=? AND is_admin=1 AND blocked=0")
      .get(t.issuer_id)
  )
    throw new ApiError(400, "Приглашение больше недействительно");
  return t;
}
export function tokenInfo(raw: unknown) {
  const t = tokenRow(raw);
  const u = t.user_id
    ? db
        .prepare<
          [number],
          { name: string }
        >("SELECT name FROM users WHERE id=?")
        .get(t.user_id)
    : null;
  return {
    purpose: t.purpose,
    name: u?.name ?? null,
    login: t.user_id ? credential(t.user_id)?.login : null,
    expiresAt: t.expires_at,
  };
}
function useToken(t: Token, user: number) {
  if (
    !db
      .prepare(
        "UPDATE account_tokens SET used_at=?,used_by=?,token_secret=NULL WHERE id=? AND used_at IS NULL AND revoked=0 AND expires_at>?",
      )
      .run(now(), user, t.id, now()).changes
  )
    throw new ApiError(409, "Ссылка уже использована");
}
const identity = (id: number) => ({
  id,
  version: credential(id)!.session_version,
  access: credential(id)!.access,
});
async function passwordDigest(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value) > 256
  )
    throw new ApiError(400, "Пароль: не менее 12 символов, не более 256 байт");
  return hashPassword(value);
}
export async function register(input: Record<string, unknown>) {
  const login = loginName(input.login),
    name = nickname(input.name);
  const hash = await passwordDigest(input.password);
  return db.transaction(() => {
    if (
      db.prepare("SELECT user_id FROM local_accounts WHERE login=?").get(login)
    )
      throw new ApiError(409, "Этот логин уже занят");
    const invitation = input.token ? tokenRow(input.token, "invite") : null;
    const id = Number(
      db
        .prepare(
          "INSERT INTO users(jellyfin_id,name,is_admin,created_at,blocked,invited_by) VALUES(?,?,0,?,?,?)",
        )
        .run(
          `local:${randomUUID()}`,
          name,
          now(),
          invitation ? 0 : 1,
          invitation?.issuer_id ?? null,
        ).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO local_accounts(user_id,login,password_hash,access,created_at) VALUES(?,?,?,?,?)",
    ).run(id, login, hash, invitation ? "approved" : "pending", now());
    if (invitation) {
      useToken(invitation, id);
      db.prepare(
        "INSERT INTO friendships(from_id,to_id,status,created_at) VALUES(?,?,'accepted',?) ON CONFLICT(from_id,to_id) DO UPDATE SET status='accepted'",
      ).run(invitation.issuer_id, id, now());
      if (invitation.group_id && invitation.issuer_id) {
        const issuer = db
          .prepare<[number], User>("SELECT * FROM users WHERE id=?")
          .get(invitation.issuer_id);
        if (issuer) inviteToList(issuer, invitation.group_id, id);
      }
    }
    audit(id, id, invitation ? "registered-invited" : "registered-pending");
    return identity(id);
  })();
}
export async function authenticate(login: unknown, password: unknown) {
  const key =
    typeof login === "string" ? login.toLowerCase().slice(0, 100) : "";
  limit(`login:${key}`, 12, 900);
  const c = db
    .prepare<[string], Credential>("SELECT * FROM local_accounts WHERE login=?")
    .get(key);
  if (!(await verifyPassword(password as string, c?.password_hash)))
    throw new ApiError(401, "Неверный логин или пароль");
  return db.transaction(() => {
    db.prepare("UPDATE users SET name=name WHERE id=?").run(c!.user_id);
    const fresh = credential(c!.user_id),
      user = db
        .prepare<[number], User>("SELECT * FROM users WHERE id=?")
        .get(c!.user_id);
    if (
      !fresh ||
      !user ||
      fresh.password_hash !== c!.password_hash ||
      fresh.session_version !== c!.session_version
    )
      throw new ApiError(401, "Повторите вход");
    if (
      fresh.access === "blocked" ||
      (user.blocked && fresh.access !== "pending")
    )
      throw new ApiError(403, "Доступ к аккаунту отозван");
    db.prepare("UPDATE local_accounts SET last_login=? WHERE user_id=?").run(
      now(),
      fresh.user_id,
    );
    return {
      id: fresh.user_id,
      version: fresh.session_version,
      access: fresh.access,
    };
  })();
}
export async function redeem(input: Record<string, unknown>) {
  const initial = tokenRow(input.token);
  if (initial.purpose === "invite")
    throw new ApiError(400, "Это приглашение для регистрации");
  const login = initial.purpose === "claim" ? loginName(input.login) : null,
    name = initial.purpose === "claim" ? nickname(input.name) : null;
  const hash = await passwordDigest(input.password);
  return db.transaction(() => {
    const t = tokenRow(input.token);
    const id = t.user_id!;
    db.prepare("UPDATE users SET name=name WHERE id=?").run(id);
    const c = credential(id);
    if (t.purpose === "claim") {
      if (c)
        throw new ApiError(
          409,
          "Аккаунт уже настроен. Используйте восстановление пароля",
        );
      if (
        db
          .prepare("SELECT user_id FROM local_accounts WHERE login=?")
          .get(login)
      )
        throw new ApiError(409, "Этот логин уже занят");
      db.prepare(
        "INSERT INTO local_accounts(user_id,login,password_hash,access,created_at) VALUES(?,?,?,'approved',?)",
      ).run(id, login, hash, now());
      db.prepare("UPDATE users SET name=?,blocked=0 WHERE id=?").run(name, id);
    } else {
      if (
        !c ||
        c.access !== "approved" ||
        db
          .prepare<
            [number],
            { blocked: number }
          >("SELECT blocked FROM users WHERE id=?")
          .get(id)?.blocked
      )
        throw new ApiError(403, "Доступ к аккаунту отозван");
      db.prepare(
        "UPDATE local_accounts SET password_hash=?,session_version=session_version+1 WHERE user_id=?",
      ).run(hash, id);
    }
    useToken(t, id);
    db.prepare(
      "UPDATE account_tokens SET revoked=1 WHERE user_id=? AND purpose IN ('reset','claim') AND used_at IS NULL",
    ).run(id);
    audit(
      id,
      t.issuer_id,
      t.purpose === "claim" ? "legacy-account-claimed" : "password-reset",
    );
    return identity(id);
  })();
}
export function issueToken(
  actor: User,
  purpose: Token["purpose"],
  user: number | null,
  hours = 24,
  opts: { groupId?: number; note?: string } = {},
) {
  requireAdmin(actor);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720)
    throw new ApiError(400, "Срок ссылки: 1–720 часов");
  if (opts.groupId) requireGroupCapability(opts.groupId, actor.id, "invite");
  if (user) {
    const target = db
      .prepare<[number], User>("SELECT * FROM users WHERE id=?")
      .get(user);
    if (!target) throw new ApiError(404, "Пользователь не найден");
    const c = credential(user);
    if (purpose === "claim" && c)
      throw new ApiError(409, "Аккаунт уже настроен");
    if (
      purpose === "reset" &&
      (!c || c.access !== "approved" || target.blocked)
    )
      throw new ApiError(400, "Сначала одобрите доступ или настройте аккаунт");
  }
  const raw = newToken(),
    id = randomUUID();
  db.transaction(() => {
    if (user)
      db.prepare(
        "UPDATE account_tokens SET revoked=1 WHERE user_id=? AND purpose=? AND used_at IS NULL",
      ).run(user, purpose);
    db.prepare(
      "INSERT INTO account_tokens(id,token_hash,purpose,user_id,issuer_id,group_id,note,created_at,expires_at,token_secret) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      tokenHash(raw),
      purpose,
      user,
      actor.id,
      opts.groupId ?? null,
      String(opts.note ?? "").slice(0, 120) || null,
      now(),
      now() + hours * 3600,
      purpose === "invite" ? sealInvitation(raw, id) : null,
    );
    audit(user, actor.id, `${purpose}-issued`);
  })();
  return {
    id,
    link: `${env.publicUrl}/account/setup#token=${raw}`,
    expiresAt: now() + hours * 3600,
  };
}
export function decide(actor: User, id: number, approve: boolean) {
  requireAdmin(actor);
  db.transaction(() => {
    const c = credential(id);
    if (!c || c.access !== "pending")
      throw new ApiError(409, "Заявка уже обработана");
    const decision = db.prepare(
      "UPDATE local_accounts SET access=?,session_version=session_version+? WHERE user_id=? AND access='pending'",
    ).run(approve ? "approved" : "blocked", approve ? 0 : 1, id);
    // A second administrator may have decided after the initial SELECT.
    if (!decision.changes) throw new ApiError(409, "Заявка уже обработана");
    db.prepare("UPDATE users SET blocked=? WHERE id=?").run(
      approve ? 0 : 1,
      id,
    );
    audit(id, actor.id, approve ? "approved" : "rejected");
  })();
}
export function manage(actor: User, id: number, action: string) {
  requireAdmin(actor);
  if (action === "reset" || action === "claim")
    return issueToken(actor, action, id);
  db.transaction(() => {
    db.prepare(
      "UPDATE users SET name=name WHERE id=(SELECT min(id) FROM users)",
    ).run();
    db.prepare("UPDATE users SET name=name WHERE id=?").run(id);
    const target = db
      .prepare<[number], User>("SELECT * FROM users WHERE id=?")
      .get(id);
    if (!target) throw new ApiError(404, "Пользователь не найден");
    if (id === actor.id && ["block", "delete", "friend"].includes(action))
      throw new ApiError(400, "Нельзя отозвать собственный доступ или роль");
    if (
      ![
        "block",
        "unblock",
        "delete",
        "admin",
        "friend",
        "revoke-sessions",
      ].includes(action)
    )
      throw new ApiError(400, "Неизвестное действие");
    if (["block", "delete", "friend"].includes(action) && target.is_admin) {
      const remaining = db
        .prepare<
          [],
          { n: number }
        >("SELECT count(*) n FROM users WHERE is_admin=1 AND blocked=0")
        .get()!.n;
      if (remaining <= 1)
        throw new ApiError(400, "Нельзя отключить последнего администратора");
    }
    if (action === "admin" || action === "friend")
      db.prepare("UPDATE users SET is_admin=? WHERE id=?").run(
        action === "admin" ? 1 : 0,
        id,
      );
    if (["block", "delete", "unblock"].includes(action)) {
      const c = credential(id);
      if (!c) throw new ApiError(400, "Сначала настройте локальный аккаунт");
      db.prepare("UPDATE users SET blocked=? WHERE id=?").run(
        action === "unblock" ? 0 : 1,
        id,
      );
      db.prepare("UPDATE local_accounts SET access=? WHERE user_id=?").run(
        action === "unblock" ? "approved" : "blocked",
        id,
      );
    }
    if (["block", "delete", "friend"].includes(action))
      db.prepare(
        "UPDATE account_tokens SET revoked=1,token_secret=NULL WHERE (issuer_id=? OR user_id=?) AND used_at IS NULL",
      ).run(id, id);
    db.prepare(
      "UPDATE local_accounts SET session_version=session_version+1 WHERE user_id=?",
    ).run(id);
    audit(id, actor.id, action);
  })();
  return { ok: true };
}
export function localInvites(user: number, all = false): InviteView[] {
  db.prepare("UPDATE account_tokens SET token_secret=NULL WHERE purpose='invite' AND token_secret IS NOT NULL AND expires_at<=?").run(now());
  const rows = all
    ? db
        .prepare<
          [],
          Token
        >("SELECT * FROM account_tokens WHERE purpose='invite' ORDER BY created_at DESC LIMIT 100")
        .all()
    : db
        .prepare<
          [number],
          Token
        >("SELECT * FROM account_tokens WHERE purpose='invite' AND issuer_id=? ORDER BY created_at DESC LIMIT 30")
        .all(user);
  const ref = (id: number | null) =>
    id
      ? db
          .prepare<
            [number],
            { id: number; name: string }
          >("SELECT id,name FROM users WHERE id=?")
          .get(id)
      : null;
  return rows.map((t) => ({
    id: t.id,
    link: null,
    note: t.note,
    group: t.group_id
      ? (db
          .prepare<
            [number],
            { name: string }
          >("SELECT name FROM shared_lists WHERE id=?")
          .get(t.group_id)?.name ?? null)
      : null,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    usedAt: t.used_at,
    canCopy: !!t.token_secret && !t.revoked && t.used_at === null && t.expires_at > now(),
    state: t.revoked
      ? "revoked"
      : t.used_at !== null
        ? "used"
        : t.expires_at <= now()
          ? "expired"
          : "active",
    usedBy: ref(t.used_by) ?? null,
    inviter: ref(t.issuer_id) ?? { id: 0, name: "Администратор" },
  }));
}
export function copyInvitation(actor: User, id: string) {
  requireAdmin(actor);
  const t = db.prepare<[string, number], Token>("SELECT * FROM account_tokens WHERE id=? AND issuer_id=? AND purpose='invite'").get(id, actor.id);
  if (!t) throw new ApiError(404, "Приглашение не найдено");
  if (t.revoked || t.used_at !== null || t.expires_at <= now()) throw new ApiError(409, "Приглашение уже использовано, отозвано или истекло");
  let raw: string;
  try {
    raw = openInvitation(t.token_secret || "", t.id);
    if (tokenHash(raw) !== t.token_hash) throw new Error();
  } catch { throw new ApiError(409, "Полная ссылка недоступна. Создайте новое приглашение."); }
  audit(null, actor.id, "invite-copied");
  return { link: `${env.publicUrl}/account/setup#token=${raw}` };
}
export function revokeInvitation(actor: User, id: string) {
  requireAdmin(actor);
  db.prepare(
    "UPDATE account_tokens SET revoked=1,token_secret=NULL WHERE id=? AND purpose='invite'",
  ).run(id);
  audit(null, actor.id, "invite-revoked");
}
export function localAccountsView(): AccountsView & { local: true } {
  const rows = db
    .prepare<
      [],
      User & { created_at: number }
    >("SELECT * FROM users ORDER BY id")
    .all();
  return {
    local: true,
    sso: false,
    accounts: rows
      .filter((u) => credential(u.id)?.access !== "pending")
      .map((u) => {
        const c = credential(u.id);
        const invitation = db.prepare<[number], {issuer_id:number|null;created_at:number}>("SELECT issuer_id,created_at FROM account_tokens WHERE purpose='invite' AND used_by=? AND used_at IS NOT NULL ORDER BY created_at,id LIMIT 1").get(u.id);
        const approval = db.prepare<[number], {actor_id:number|null;created_at:number}>("SELECT actor_id,created_at FROM account_audit WHERE user_id=? AND action='approved' ORDER BY created_at,id LIMIT 1").get(u.id);
        const person = (id:number|null|undefined) => id ? db.prepare<[number],{id:number;name:string}>("SELECT id,name FROM users WHERE id=?").get(id) ?? null : null;
        return {
          id: u.id,
          name: u.name,
          email: null,
          admin: !!u.is_admin,
          blocked: !!u.blocked,
          linked: !!c,
          lastLogin: c?.last_login ?? null,
          invitedBy: person(invitation?.issuer_id ?? u.invited_by),
          invitedAt: invitation?.created_at ?? null,
          approvedBy: person(approval?.actor_id),
          approvedAt: approval?.created_at ?? null,
          createdAt: u.created_at,
          libraries: null,
        };
      }),
    requests: rows
      .filter((u) => credential(u.id)?.access === "pending")
      .map((u) => ({
        authPk: u.id,
        username: credential(u.id)!.login,
        email: null,
        createdAt: credential(u.id)!.created_at,
        inviter: null,
      })),
    invites: localInvites(0, true),
  };
}
