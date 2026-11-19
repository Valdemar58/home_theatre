import "server-only";
import { randomBytes } from "node:crypto";
import type { Account, AccountsView, InviteView, SignupRequest } from "@/lib/accounts";
import { INVITE_DAYS, inviteLimitReached } from "@/lib/accounts";
import { db, now } from "./db";
import { env, ssoConfigured } from "./env";
import { notify } from "./notifications";
import { ApiError } from "./route";
import type { User } from "./session";
import { ADMIN_GROUP, ensureJellyfinUser, FRIEND_GROUP, setJellyfinLibraries } from "./sso";
import { jellyfin } from "./stream";
import { inviteToList, roleIn } from "./together";

// Пользователи и приглашения (TASKS 7.9в): учётки живут в Authentik, календарь управляет ими через API (токен служебной
// учётки kino-calendar). Приглашение — одноразовая ссылка на поток регистрации kino-invite; созданная по ней учётка
// выключена, пока админ не одобрит заявку. Одобрение: включить, группа «друзья», учётка Jellyfin, дружба с пригласившим.

const INVITE_FLOW = "kino-invite";

type AkUser = {
  pk: number; uuid: string; username: string; name: string; email: string; is_active: boolean; last_login: string | null;
  path: string; attributes: Record<string, unknown>; groups_obj?: { pk: string; name: string }[];
};
type AkPage<T> = { results: T[] };

async function ak<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!ssoConfigured() || !env.authApiToken) throw new ApiError(400, "Единый вход не настроен (bootstrap.py --only authentik)");
  const res = await fetch(`${env.authUrl}/api/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.authApiToken}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ApiError(502, `Authentik ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const kinoUsers = async () => (await ak<AkPage<AkUser>>("/core/users/?path=kino&page_size=500&include_groups=true")).results;

let groupPks: Record<string, string> | null = null;
async function groupPk(name: string): Promise<string> {
  if (!groupPks?.[name]) {
    const all = (await ak<AkPage<{ pk: string; name: string }>>("/core/groups/?page_size=100")).results;
    groupPks = Object.fromEntries(all.map((g) => [g.name, g.pk]));
  }
  const pk = groupPks[name];
  if (!pk) throw new ApiError(502, `В Authentik нет группы ${name}`);
  return pk;
}

let flowPk: string | null = null;
const inviteFlow = async () => (flowPk ??= (await ak<{ pk: string }>(`/flows/instances/${INVITE_FLOW}/`)).pk);

const inviteLink = (id: string) => `${env.authPublicUrl}/if/flow/${INVITE_FLOW}/?itoken=${id}`;
const userName = (id: number | null) => (id ? db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? null : null);
const adminIds = () => db.prepare<[], { id: number }>("SELECT id FROM users WHERE is_admin = 1 AND blocked = 0").all().map((r) => r.id);

// ---------------------------------------------------------------- Приглашения

type InviteRow = { id: string; inviter_id: number; group_id: number | null; note: string | null; created_at: number; expires_at: number; used_by: number | null; revoked: number };

/** Новое приглашение: ссылка на неделю, одна регистрация. groupId — группа просмотра, куда позвать после одобрения. */
export async function createInvite(user: User, opts: { note?: string; groupId?: number }): Promise<InviteView> {
  const mine = db.prepare<[number, number], { n: number }>("SELECT count(*) n FROM invites WHERE inviter_id = ? AND used_by IS NULL AND revoked = 0 AND expires_at > ?")
    .get(user.id, now())!.n;
  if (!user.is_admin && inviteLimitReached(mine)) throw new ApiError(400, "Слишком много неиспользованных приглашений — отзовите старые");
  if (opts.groupId && !roleIn(opts.groupId, user.id)) throw new ApiError(403, "Позвать можно только в свою группу");
  const expires = now() + INVITE_DAYS * 86400;
  const inv = await ak<{ pk: string }>("/stages/invitation/invitations/", {
    method: "POST",
    body: JSON.stringify({
      name: `kino-${user.id}-${randomBytes(4).toString("hex")}`, flow: await inviteFlow(), single_use: true,
      expires: new Date(expires * 1000).toISOString(),
      // Попадёт в атрибуты созданной учётки (user_write пишет туда только ключи «attributes.»): по ним календарь узнаёт заявку
      fixed_data: { "attributes.kino_inviter": user.id },
    }),
  });
  // pk известен только после создания — дописать его в fixed_data
  await ak(`/stages/invitation/invitations/${inv.pk}/`, {
    method: "PATCH", body: JSON.stringify({ fixed_data: { "attributes.kino_inviter": user.id, "attributes.kino_invite": inv.pk } }),
  });
  db.prepare("INSERT INTO invites (id, inviter_id, group_id, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(inv.pk, user.id, opts.groupId ?? null, opts.note?.trim() || null, now(), expires);
  return inviteView(db.prepare<[string], InviteRow>("SELECT * FROM invites WHERE id = ?").get(inv.pk)!);
}

function inviteView(r: InviteRow): InviteView {
  const group = r.group_id ? db.prepare<[number], { name: string }>("SELECT name FROM shared_lists WHERE id = ?").get(r.group_id)?.name ?? null : null;
  // used_by = -1 — по ссылке зарегистрировались, заявка ждёт админа
  const state = r.revoked ? "revoked" : r.used_by === -1 ? "pending" : r.used_by ? "used" : r.expires_at < now() ? "expired" : "active";
  return {
    id: r.id, link: state === "active" ? inviteLink(r.id) : null, note: r.note, group, createdAt: r.created_at, expiresAt: r.expires_at,
    state, usedBy: r.used_by && r.used_by > 0 ? { id: r.used_by, name: userName(r.used_by) ?? "?" } : null,
    inviter: { id: r.inviter_id, name: userName(r.inviter_id) ?? "?" },
  };
}

export function myInvites(userId: number): InviteView[] {
  return db.prepare<[number], InviteRow>("SELECT * FROM invites WHERE inviter_id = ? ORDER BY created_at DESC LIMIT 30").all(userId).map(inviteView);
}

export async function revokeInvite(user: User, id: string) {
  const r = db.prepare<[string], InviteRow>("SELECT * FROM invites WHERE id = ?").get(id);
  if (!r || (r.inviter_id !== user.id && !user.is_admin)) throw new ApiError(404, "Приглашение не найдено");
  await ak(`/stages/invitation/invitations/${id}/`, { method: "DELETE" }).catch(() => undefined);
  db.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").run(id);
}

// ---------------------------------------------------------------- Заявки

type RequestRow = { auth_pk: number; auth_sub: string; username: string; email: string | null; inviter_id: number | null; invite_id: string | null; created_at: number; status: string; user_id: number | null };

/** Раз в минуту: новые выключенные учётки по приглашению → заявки и уведомление админам. */
export async function syncSignups() {
  if (!ssoConfigured() || !env.authApiToken) return;
  for (const u of await kinoUsers()) {
    if (u.is_active || u.attributes.kino_inviter === undefined) continue;
    if (db.prepare<[number], { n: number }>("SELECT count(*) n FROM signup_requests WHERE auth_pk = ?").get(u.pk)!.n) continue;
    const inviter = Number(u.attributes.kino_inviter) || null;
    const inviteId = typeof u.attributes.kino_invite === "string" ? u.attributes.kino_invite : null;
    db.prepare("INSERT INTO signup_requests (auth_pk, auth_sub, username, email, inviter_id, invite_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(u.pk, u.uuid, u.username, u.email || null, inviter, inviteId, now());
    if (inviteId) db.prepare("UPDATE invites SET used_by = -1 WHERE id = ? AND used_by IS NULL").run(inviteId);
    for (const id of adminIds()) {
      notify(id, {
        kind: "signup", actorId: inviter ?? undefined, title: `${u.username} просится в кинотеатр`,
        body: inviter ? `по приглашению ${userName(inviter) ?? "?"}` : undefined, href: "/accounts",
        actions: [{ type: "link", label: "Рассмотреть", href: "/accounts" }],
      });
    }
  }
}

export async function decideSignup(admin: User, authPk: number, approve: boolean) {
  const r = db.prepare<[number], RequestRow>("SELECT * FROM signup_requests WHERE auth_pk = ?").get(authPk);
  if (!r || r.status !== "pending") throw new ApiError(404, "Заявка не найдена или уже решена");
  if (!approve) {
    await ak(`/core/users/${authPk}/`, { method: "DELETE" });
    db.prepare("UPDATE signup_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE auth_pk = ?").run(admin.id, now(), authPk);
    if (r.invite_id) db.prepare("UPDATE invites SET used_by = NULL, revoked = 1 WHERE id = ?").run(r.invite_id);
    return;
  }
  await ak(`/core/users/${authPk}/`, { method: "PATCH", body: JSON.stringify({ is_active: true }) });
  await ak(`/core/groups/${await groupPk(FRIEND_GROUP)}/add_user/`, { method: "POST", body: JSON.stringify({ pk: authPk }) });
  const jfId = await ensureJellyfinUser(r.username);
  db.prepare(`INSERT INTO users (jellyfin_id, name, is_admin, created_at, auth_sub, email, invited_by) VALUES (?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(jellyfin_id) DO UPDATE SET auth_sub = excluded.auth_sub, email = excluded.email, invited_by = excluded.invited_by`)
    .run(jfId, r.username, now(), r.auth_sub, r.email, r.inviter_id);
  const user = db.prepare<[string], User>("SELECT * FROM users WHERE auth_sub = ?").get(r.auth_sub)!;
  db.prepare("UPDATE signup_requests SET status = 'approved', decided_by = ?, decided_at = ?, user_id = ? WHERE auth_pk = ?").run(admin.id, now(), user.id, authPk);
  const invite = r.invite_id ? db.prepare<[string], InviteRow>("SELECT * FROM invites WHERE id = ?").get(r.invite_id) : undefined;
  if (invite) db.prepare("UPDATE invites SET used_by = ? WHERE id = ?").run(user.id, invite.id);
  // Пригласивший и новичок — сразу друзья; позвать в группу, если приглашали туда
  const inviter = r.inviter_id ? db.prepare<[number], User>("SELECT * FROM users WHERE id = ?").get(r.inviter_id) : undefined;
  if (inviter && inviter.id !== user.id) {
    // Дружба — сразу принятая, без встречных уведомлений «хочет добавить» / «принял заявку»
    db.prepare("INSERT INTO friendships (from_id, to_id, status, created_at) VALUES (?, ?, 'accepted', ?) ON CONFLICT (from_id, to_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at").run(inviter.id, user.id, now());
    if (invite?.group_id && roleIn(invite.group_id, inviter.id)) inviteToList(inviter, invite.group_id, user.id);
    if (inviter.id !== admin.id) notify(inviter.id, { kind: "signup", actorId: user.id, title: "принят по вашему приглашению — теперь вы друзья", href: `/users/${user.id}` });
  }
}

// ---------------------------------------------------------------- Пользователи (админ)

type Row = { id: number; name: string; email: string | null; is_admin: number; blocked: number; auth_sub: string | null; invited_by: number | null; jellyfin_id: string; created_at: number };

export async function accountsView(): Promise<AccountsView> {
  const rows = db.prepare<[], Row>("SELECT id, name, email, is_admin, blocked, auth_sub, invited_by, jellyfin_id, created_at FROM users ORDER BY is_admin DESC, name").all();
  const akUsers = new Map((await kinoUsers().catch(() => [] as AkUser[])).map((u) => [u.uuid, u]));
  const jf = new Map((await jellyfin<{ Id: string; Policy: { EnableAllFolders: boolean; EnabledFolders: string[] } }[]>("/Users").catch(() => [])).map((u) => [u.Id, u]));
  const accounts: Account[] = rows.map((r) => {
    const a = r.auth_sub ? akUsers.get(r.auth_sub) : undefined;
    const p = jf.get(r.jellyfin_id)?.Policy;
    return {
      id: r.id, name: r.name, email: r.email ?? (a?.email || null), admin: Boolean(r.is_admin), blocked: Boolean(r.blocked),
      linked: Boolean(a), lastLogin: a?.last_login ? Math.round(Date.parse(a.last_login) / 1000) : null,
      invitedBy: r.invited_by ? { id: r.invited_by, name: userName(r.invited_by) ?? "?" } : null, createdAt: r.created_at,
      libraries: p ? p.EnableAllFolders || p.EnabledFolders.length > 0 : null,
    };
  });
  const requests: SignupRequest[] = db.prepare<[], RequestRow>("SELECT * FROM signup_requests WHERE status = 'pending' ORDER BY created_at").all()
    .map((r) => ({ authPk: r.auth_pk, username: r.username, email: r.email, createdAt: r.created_at, inviter: r.inviter_id ? { id: r.inviter_id, name: userName(r.inviter_id) ?? "?" } : null }));
  const invites = db.prepare<[number], InviteRow>("SELECT * FROM invites WHERE used_by IS NULL AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC").all(now()).map(inviteView);
  return { sso: ssoConfigured(), accounts, requests, invites };
}

const akUserOf = async (userId: number) => {
  const r = db.prepare<[number], Row>("SELECT * FROM users WHERE id = ?").get(userId);
  if (!r) throw new ApiError(404, "Пользователь не найден");
  const a = r.auth_sub ? (await kinoUsers()).find((u) => u.uuid === r.auth_sub) ?? (await ak<AkPage<AkUser>>(`/core/users/?uuid=${r.auth_sub}`)).results[0] : undefined;
  return { row: r, ak: a };
};

export type AccountAction = "admin" | "friend" | "block" | "unblock" | "libraries-on" | "libraries-off" | "reset" | "delete";

/** Действие админа над учёткой; reset возвращает ссылку на смену пароля. */
export async function accountAction(admin: User, userId: number, action: AccountAction): Promise<{ link?: string }> {
  if (userId === admin.id && ["friend", "block", "delete"].includes(action)) throw new ApiError(400, "С собой так нельзя");
  const { row, ak: a } = await akUserOf(userId);
  const needAk = () => {
    if (!a) throw new ApiError(400, "Учётка ещё не входила через единый вход — сначала пусть войдёт");
    return a;
  };
  switch (action) {
    case "admin":
    case "friend": {
      const u = needAk();
      const [add, drop] = action === "admin" ? [ADMIN_GROUP, FRIEND_GROUP] : [FRIEND_GROUP, ADMIN_GROUP];
      await ak(`/core/groups/${await groupPk(add)}/add_user/`, { method: "POST", body: JSON.stringify({ pk: u.pk }) });
      await ak(`/core/groups/${await groupPk(drop)}/remove_user/`, { method: "POST", body: JSON.stringify({ pk: u.pk }) });
      db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(action === "admin" ? 1 : 0, userId);
      // И в Jellyfin (плагин SSO права не трогает)
      const jfUser = await jellyfin<{ Policy: Record<string, unknown> }>(`/Users/${row.jellyfin_id}`).catch(() => null);
      if (jfUser) await jellyfin(`/Users/${row.jellyfin_id}/Policy`, { method: "POST", body: JSON.stringify({ ...jfUser.Policy, IsAdministrator: action === "admin" }) });
      return {};
    }
    case "block":
    case "unblock": {
      if (a) await ak(`/core/users/${a.pk}/`, { method: "PATCH", body: JSON.stringify({ is_active: action === "unblock" }) });
      db.prepare("UPDATE users SET blocked = ? WHERE id = ?").run(action === "block" ? 1 : 0, userId);
      // Jellyfin: заблокированный не войдёт и с ТВ
      const jfUser = await jellyfin<{ Policy: Record<string, unknown> }>(`/Users/${row.jellyfin_id}`).catch(() => null);
      if (jfUser) await jellyfin(`/Users/${row.jellyfin_id}/Policy`, { method: "POST", body: JSON.stringify({ ...jfUser.Policy, IsDisabled: action === "block" }) });
      return {};
    }
    case "libraries-on":
    case "libraries-off":
      await setJellyfinLibraries(row.jellyfin_id, action === "libraries-on");
      return {};
    case "reset": {
      const u = needAk();
      const res = await ak<{ link: string }>(`/core/users/${u.pk}/recovery/`, { method: "POST" });
      // Authentik строит ссылку по адресу запроса (внутреннему) — человеку нужна публичная
      return { link: res.link.replace(/^https?:\/\/[^/]+/, env.authPublicUrl) };
    }
    case "delete": {
      // Учётка входа и Jellyfin удаляются; в календаре человек остаётся заблокированным (комментарии, история)
      if (a) await ak(`/core/users/${a.pk}/`, { method: "DELETE" });
      await jellyfin(`/Users/${row.jellyfin_id}`, { method: "DELETE" }).catch(() => undefined);
      db.prepare("UPDATE users SET blocked = 1, auth_sub = NULL WHERE id = ?").run(userId);
      return {};
    }
  }
}
