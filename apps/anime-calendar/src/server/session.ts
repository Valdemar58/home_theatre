import "server-only";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { db, now, stmt } from "./db";
import { env } from "./env";

export type SessionData = { userId?: number; shikiState?: string; shikiRedirect?: string; oidc?: { state: string; verifier: string; next: string; redirect: string } };

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

function options(): SessionOptions {
  const password = env.sessionSecret || (process.env.NODE_ENV !== "production" ? "dev-only-secret-dev-only-secret-0000" : "");
  if (password.length < 32) throw new Error("SESSION_SECRET должен быть не короче 32 символов");
  return {
    password,
    cookieName: "anime_calendar_session",
    // В домашней сети обычно http, поэтому secure не требуем
    cookieOptions: { secure: false, sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 90 },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), options());
}

const byId = stmt<[number], User>("SELECT * FROM users WHERE id = ?");

export async function currentUser(): Promise<User | null> {
  const s = await getSession();
  const user = s.userId ? (byId().get(s.userId) ?? null) : null;
  // Заблокированный выходит сразу, даже с живой cookie
  return user && !user.blocked ? user : null;
}

export function upsertUser(jellyfinId: string, name: string, isAdmin: boolean): User {
  db.prepare(
    "INSERT INTO users (jellyfin_id, name, is_admin, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(jellyfin_id) DO UPDATE SET name = excluded.name, is_admin = excluded.is_admin",
  ).run(jellyfinId, name, isAdmin ? 1 : 0, now());
  return db.prepare<[string], User>("SELECT * FROM users WHERE jellyfin_id = ?").get(jellyfinId)!;
}

export const getUserById = (id: number) => byId().get(id) ?? null;
