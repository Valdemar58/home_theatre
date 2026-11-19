import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db, now } from "./db";
import { env } from "./env";
import { isRemote } from "./remote";
import { ApiError } from "./route";
import type { User } from "./session";
import { jellyfin } from "./stream";

// Единый вход (TASKS 7.9б): календарь — OIDC-клиент Authentik (код + PKCE). Код меняется на токен по внутреннему
// адресу (http://authentik:9000), сведения о человеке — из userinfo тем же путём, поэтому подпись id_token не
// проверяем. Учётка календаря привязана к uuid Authentik (`users.auth_sub`); старые — по имени при первом входе.
// Права админа — по группе kino-admins. У каждого есть учётка Jellyfin (аватар, прогресс, ТВ) — заводится сама.

export const ADMIN_GROUP = "kino-admins";
export const FRIEND_GROUP = "kino-friends";

export type Claims = { sub: string; preferred_username: string; email?: string; name?: string; groups?: string[] };

const b64url = (b: Buffer) => b.toString("base64url");

/** Адрес календаря, с которого пришёл запрос: из интернета — публичный, дома — как открыт. */
export function originOf(req: Request): string {
  if (isRemote(req) && env.publicUrl) return env.publicUrl;
  const host = req.headers.get("host") ?? "localhost:5056";
  return `http://${host}`;
}

/** Начало входа: куда отправить браузер и что запомнить в сессии. */
export function authorizeStart(req: Request, next: string) {
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const redirect = `${originOf(req)}/api/auth/oidc/callback`;
  const q = new URLSearchParams({
    response_type: "code", client_id: env.authClientId, redirect_uri: redirect, scope: "openid email profile",
    state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  });
  return { url: `${env.authPublicUrl}/application/o/authorize/?${q}`, saved: { state, verifier, next, redirect } };
}

/** Код → токен → сведения о человеке (всё по внутреннему адресу). */
export async function exchange(code: string, verifier: string, redirect: string): Promise<Claims> {
  const res = await fetch(`${env.authUrl}/application/o/token/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${env.authClientId}:${env.authClientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ApiError(502, `Authentik не принял код входа: HTTP ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  const info = await fetch(`${env.authUrl}/application/o/userinfo/`, {
    headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!info.ok) throw new ApiError(502, `Authentik не отдал сведения о пользователе: HTTP ${info.status}`);
  return (await info.json()) as Claims;
}

type JfUser = { Id: string; Name: string; Policy: Record<string, unknown> };

/** Учётка Jellyfin по имени: есть — она, нет — новая (случайный пароль: входят через SSO или Quick Connect). */
export async function ensureJellyfinUser(name: string, libraries = true): Promise<string> {
  const users = await jellyfin<JfUser[]>("/Users");
  const have = users.find((u) => u.Name.toLowerCase() === name.toLowerCase());
  if (have) return have.Id;
  const u = await jellyfin<JfUser>("/Users/New", { method: "POST", body: JSON.stringify({ Name: name, Password: b64url(randomBytes(24)) }) });
  await setJellyfinLibraries(u.Id, libraries);
  return u.Id;
}

/** Доступ к библиотекам Jellyfin: все или никаких (смотреть в календаре можно и без них — через админа). */
export async function setJellyfinLibraries(jellyfinId: string, on: boolean) {
  const u = await jellyfin<JfUser>(`/Users/${jellyfinId}`);
  await jellyfin(`/Users/${jellyfinId}/Policy`, {
    method: "POST", body: JSON.stringify({ ...u.Policy, EnableAllFolders: on, EnabledFolders: [], EnableContentDownloading: on }),
  });
}

/** Учётка календаря для вошедшего: по uuid, иначе старая с тем же именем, иначе новая. */
export async function userForClaims(c: Claims): Promise<User> {
  const isAdmin = c.groups?.includes(ADMIN_GROUP) ? 1 : 0;
  let user = db.prepare<[string], User>("SELECT * FROM users WHERE auth_sub = ?").get(c.sub);
  if (!user) {
    user = db.prepare<[string], User>("SELECT * FROM users WHERE auth_sub IS NULL AND lower(name) = lower(?)").get(c.preferred_username);
    if (user) db.prepare("UPDATE users SET auth_sub = ? WHERE id = ?").run(c.sub, user.id);
  }
  if (!user) {
    const jfId = await ensureJellyfinUser(c.preferred_username);
    db.prepare("INSERT INTO users (jellyfin_id, name, is_admin, created_at, auth_sub, email) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(jellyfin_id) DO UPDATE SET auth_sub = excluded.auth_sub")
      .run(jfId, c.preferred_username, isAdmin, now(), c.sub, c.email ?? null);
  }
  db.prepare("UPDATE users SET name = ?, email = ?, is_admin = ? WHERE auth_sub = ?").run(c.preferred_username, c.email ?? null, isAdmin, c.sub);
  return db.prepare<[string], User>("SELECT * FROM users WHERE auth_sub = ?").get(c.sub)!;
}
