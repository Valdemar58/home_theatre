import "server-only";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";
import { db, now, stmt } from "./db";
import { env } from "./env";

export type SessionData = {
  userId?: number;
  authVersion?: number;
  shikiState?: string;
  shikiRedirect?: string;
  oidc?: { state: string; verifier: string; next: string; redirect: string };
};

export type User = {
  id: number;
  jellyfin_id: string;
  name: string;
  is_admin: number;
  shiki_user_id: number | null;
  shiki_nickname: string | null;
  shiki_access: string | null;
  shiki_refresh: string | null;
  shiki_expires: number | null;
  shiki_synced_at: number | null;
  shiki_error: string | null;
  lib_user_id: number | null;
  lib_nickname: string | null;
  lib_synced_at: number | null;
  lib_error: string | null;
  visibility: import("@/lib/social-rules").Visibility;
  auth_sub: string | null;
  email: string | null;
  blocked: number;
  invited_by: number | null;
};

function options(secure: boolean): SessionOptions {
  const password =
    env.sessionSecret ||
    (process.env.NODE_ENV !== "production"
      ? "dev-only-secret-dev-only-secret-0000"
      : "");
  if (password.length < 32)
    throw new Error("SESSION_SECRET должен быть не короче 32 символов");
  return {
    password,
    cookieName: "anime_calendar_session",
    // В домашней сети обычно http, поэтому secure не требуем
    cookieOptions: {
      secure,
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 90,
    },
  };
}

export async function getSession() {
  const h = await headers();
  const publicHost = env.publicUrl.startsWith("https://")
    ? new URL(env.publicUrl).host
    : "";
  const secure =
    process.env.SESSION_COOKIE_SECURE === "1" ||
    (process.env.SESSION_COOKIE_SECURE !== "0" &&
      (h.get("x-forwarded-proto") === "https" ||
        Boolean(publicHost && h.get("host") === publicHost)));
  return getIronSession<SessionData>(await cookies(), options(secure));
}

const byId = stmt<[number], User>("SELECT * FROM users WHERE id = ?");

export async function authenticatedUser(): Promise<User | null> {
  const s = await getSession();
  const user = s.userId ? (byId().get(s.userId) ?? null) : null;
  if (!user) return null;
  const account = db
    .prepare<
      [number],
      { session_version: number }
    >("SELECT session_version FROM local_accounts WHERE user_id=?")
    .get(user.id);
  if (account && s.authVersion !== account.session_version) return null;
  return user;
}

export async function currentUser(): Promise<User | null> {
  const user = await authenticatedUser();
  if (!user || user.blocked) return null;
  const account = db
    .prepare<
      [number],
      { access: string }
    >("SELECT access FROM local_accounts WHERE user_id=?")
    .get(user.id);
  return !account || account.access === "approved" ? user : null;
}

export function upsertUser(
  jellyfinId: string,
  name: string,
  isAdmin: boolean,
): User {
  db.prepare(
    "INSERT INTO users (jellyfin_id, name, is_admin, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(jellyfin_id) DO UPDATE SET name = excluded.name, is_admin = excluded.is_admin",
  ).run(jellyfinId, name, isAdmin ? 1 : 0, now());
  return db
    .prepare<[string], User>("SELECT * FROM users WHERE jellyfin_id = ?")
    .get(jellyfinId)!;
}

export const getUserById = (id: number) => byId().get(id) ?? null;

/** Capture the cookie identity once; long-lived streams recheck the DB after revocation. */
export async function sessionGuard() {
  const s = await getSession(),
    id = s.userId,
    version = s.authVersion;
  return () => {
    if (!id) return false;
    try {
      const row = db
        .prepare<
          [number],
          {
            blocked: number;
            access: string | null;
            session_version: number | null;
          }
        >("SELECT u.blocked,a.access,a.session_version FROM users u LEFT JOIN local_accounts a ON a.user_id=u.id WHERE u.id=?")
        .get(id);
      return (
        !!row &&
        !row.blocked &&
        (row.session_version === null ||
          (row.access === "approved" && row.session_version === version))
      );
    } catch {
      return false;
    }
  };
}
