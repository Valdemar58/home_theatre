import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({
  userId: undefined as number | undefined,
  authVersion: undefined as number | undefined,
  save: async () => {},
  destroy: () => {},
}));
vi.mock("iron-session", () => ({ getIronSession: async () => session }));
vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers(),
}));
process.env.DATABASE_DRIVER =
  process.env.POSTGRES_TEST === "1" ? "postgres" : "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "local-accounts-"));
const { db } = await import("./db");
const auth = await import("./local-accounts");
const { env } = await import("./env");
const { currentUser, authenticatedUser } = await import("./session");
const { deviceByToken } = await import("./desktop");
const { tokenHash } = await import("../../database/account-security.mjs");
let owner: import("./session").User;
const password = "a long synthetic password";
const tokenOf = (link: string) =>
  new URL(link, "http://localhost").hash.split("=")[1];
beforeEach(() => {
  env.sessionSecret = "synthetic-test-invitation-secret-at-least-32-chars";
  vi.restoreAllMocks();
  session.userId = undefined;
  session.authVersion = undefined;
  db.exec(
    "DELETE FROM account_audit; DELETE FROM account_tokens; DELETE FROM local_accounts; DELETE FROM account_attempts; DELETE FROM shared_lists; DELETE FROM desktop_devices; DELETE FROM users;",
  );
  const id = Number(
    db
      .prepare(
        "INSERT INTO users(jellyfin_id,name,is_admin,created_at) VALUES('preserved-jellyfin','original-admin',1,0)",
      )
      .run().lastInsertRowid,
  );
  owner = db
    .prepare<
      [number],
      import("./session").User
    >("SELECT * FROM users WHERE id=?")
    .get(id)!;
});
it("accepts an invitation for the existing pending identity, once, with provenance", async () => {
  const pending=await auth.register({login:"invited-pending",name:"Pending",password});
  const invitation=auth.issueToken(owner,"invite",null);
  expect(auth.acceptAccountInvitation(pending.id,tokenOf(invitation.link))).toEqual({ok:true,access:"approved"});
  expect(auth.credential(pending.id)?.access).toBe("approved");
  expect(db.prepare<[number],{invited_by:number}>("SELECT invited_by FROM users WHERE id=?").get(pending.id)?.invited_by).toBe(owner.id);
  expect(()=>auth.acceptAccountInvitation(pending.id,tokenOf(invitation.link))).toThrow();
  const another=await auth.register({login:"other-pending",name:"Other",password});
  expect(()=>auth.acceptAccountInvitation(another.id,tokenOf(invitation.link))).toThrow();
  expect(auth.credential(another.id)?.access).toBe("pending");
});
it("migrates the same identity, preserving lists, history references and an existing device token", async () => {
  const group = Number(
    db
      .prepare(
        "INSERT INTO shared_lists(name,owner_id,created_at) VALUES('Room',?,0)",
      )
      .run(owner.id).lastInsertRowid,
  );
  const token = "a".repeat(64);
  db.prepare(
    "INSERT INTO desktop_devices(id,token_hash,user_id,label,platform,created_at,expires_at) VALUES('preserved-device',?,?, 'PC','win32',0,9999999999)",
  ).run(tokenHash(token), owner.id);
  const link = auth.issueToken(owner, "claim", owner.id);
  const result = await auth.redeem({
    token: tokenOf(link.link),
    login: "My.Login",
    name: "Personal nick",
    password,
  });
  expect(result.id).toBe(owner.id);
  expect(auth.credential(owner.id)?.login).toBe("my.login");
  const u = db
    .prepare<
      [number],
      { name: string; jellyfin_id: string; is_admin: number }
    >("SELECT name,jellyfin_id,is_admin FROM users WHERE id=?")
    .get(owner.id)!;
  expect(u).toEqual({
    name: "Personal nick",
    jellyfin_id: "preserved-jellyfin",
    is_admin: 1,
  });
  expect(
    db
      .prepare<
        [number],
        { owner_id: number }
      >("SELECT owner_id FROM shared_lists WHERE id=?")
      .get(group)?.owner_id,
  ).toBe(owner.id);
  expect(deviceByToken(token).user_id).toBe(owner.id);
  await expect(
    auth.redeem({
      token: tokenOf(link.link),
      login: "other",
      name: "Other",
      password,
    }),
  ).rejects.toThrow("Ссылка");
});
it("denies product access before approval and opens the same signed-in pending account after approval", async () => {
  const r = await auth.register({
    login: "pending-user",
    name: "Pending",
    password,
  });
  session.userId = r.id;
  session.authVersion = r.version;
  expect((await authenticatedUser())?.id).toBe(r.id);
  expect(await currentUser()).toBeNull();
  auth.decide(owner, r.id, true);
  expect((await currentUser())?.id).toBe(r.id);
  expect(await auth.authenticate("PENDING-USER", password)).toMatchObject({
    id: r.id,
    access: "approved",
  });
});
it("only administrators can issue instant-access invites; tokens are hashed, single-use and not listed as URLs", async () => {
  expect(() =>
    auth.issueToken({ ...owner, is_admin: 0 }, "invite", null),
  ).toThrow("админа");
  const link = auth.issueToken(owner, "invite", null, 1);
  const raw = tokenOf(link.link);
  expect(
    JSON.stringify(db.prepare("SELECT * FROM account_tokens").all()),
  ).not.toContain(raw);
  const result = await auth.register({
    login: "invited-user",
    name: "Invited",
    password,
    token: raw,
  });
  expect(result.access).toBe("approved");
  expect(auth.localInvites(owner.id)[0]).toMatchObject({
    link: null,
    state: "used",
    usedBy: { id: result.id },
  });
  await expect(
    auth.register({
      login: "replay-user",
      name: "Replay",
      password,
      token: raw,
    }),
  ).rejects.toThrow("Ссылка");
  expect(
    db
      .prepare("SELECT user_id FROM local_accounts WHERE login='replay-user'")
      .get(),
  ).toBeUndefined();
});
it("rejects expired/revoked invitations and invitations whose issuer lost administrator rights", async () => {
  for (const scenario of ["expired", "revoked", "issuer"]) {
    const link = auth.issueToken(owner, "invite", null, 1);
    if (scenario === "expired")
      db.prepare("UPDATE account_tokens SET expires_at=0 WHERE id=?").run(
        link.id,
      );
    if (scenario === "revoked") auth.revokeInvitation(owner, link.id);
    if (scenario === "issuer")
      db.prepare("UPDATE users SET is_admin=0 WHERE id=?").run(owner.id);
    await expect(
      auth.register({
        login: `user-${scenario}`,
        name: "Expired",
        password,
        token: tokenOf(link.link),
      }),
    ).rejects.toThrow();
  }
});

it("copies an active invite after reload without listing plaintext, rejects another issuer and binds encryption to the invitation", async () => {
  const issued = auth.issueToken(owner, "invite", null, 24);
  const other = await auth.register({login:"another-admin",name:"Other admin",password});
  auth.decide(owner,other.id,true);auth.manage(owner,other.id,"admin");
  const actor = db.prepare<[number],typeof owner>("SELECT * FROM users WHERE id=?").get(other.id)!;
  expect(() => auth.copyInvitation(actor,issued.id)).toThrow("не найдено");
  expect(auth.localInvites(owner.id)[0]).toMatchObject({link:null,canCopy:true,state:"active"});
  expect(auth.copyInvitation(owner,issued.id).link).toBe(issued.link);
  const stored = db.prepare<[string],{token_secret:string}>("SELECT token_secret FROM account_tokens WHERE id=?").get(issued.id)!;
  expect(stored.token_secret).not.toContain(tokenOf(issued.link));
  const second = auth.issueToken(owner,"invite",null,24);
  db.prepare("UPDATE account_tokens SET token_secret=? WHERE id=?").run(stored.token_secret,second.id);
  expect(() => auth.copyInvitation(owner,second.id)).toThrow("недоступна");
  env.sessionSecret = "another-synthetic-test-key-at-least-32-characters";
  expect(() => auth.copyInvitation(owner,issued.id)).toThrow("недоступна");
});

it("keeps used/expired/revoked statuses accurate and stops copying with recoverable secrets cleared", async () => {
  for(const state of ["used","expired","revoked","legacy"]){
    const issued=auth.issueToken(owner,"invite",null,24);
    if(state==="used") await auth.register({login:"invite-used",name:"Invited",password,token:tokenOf(issued.link)});
    if(state==="expired") db.prepare("UPDATE account_tokens SET expires_at=0 WHERE id=?").run(issued.id);
    if(state==="revoked") auth.revokeInvitation(owner,issued.id);
    if(state==="legacy") db.prepare("UPDATE account_tokens SET token_secret=NULL WHERE id=?").run(issued.id);
    expect(auth.localInvites(owner.id).find(i=>i.id===issued.id)).toMatchObject({state:state==="legacy"?"active":state,canCopy:false,link:null});
    expect(()=>auth.copyInvitation(owner,issued.id)).toThrow();
    expect(db.prepare<[string],{token_secret:string|null}>("SELECT token_secret FROM account_tokens WHERE id=?").get(issued.id)?.token_secret).toBeNull();
  }
});

it("shows who and when invited or approved an account without changing its provenance after blocking",async()=>{
  const issued=auth.issueToken(owner,"invite",null,24);
  db.prepare("UPDATE account_tokens SET created_at=123 WHERE id=?").run(issued.id);
  const invited=await auth.register({login:"with-invitation",name:"Invited",password,token:tokenOf(issued.link)});
  const pending=await auth.register({login:"manual-approval",name:"Approved",password});auth.decide(owner,pending.id,true);
  const view=auth.localAccountsView();
  expect(view.accounts.find(a=>a.id===invited.id)).toMatchObject({invitedBy:{id:owner.id,name:owner.name},invitedAt:123,approvedBy:null,approvedAt:null});
  const approved=view.accounts.find(a=>a.id===pending.id)!;
  expect(approved).toMatchObject({invitedBy:null,invitedAt:null,approvedBy:{id:owner.id,name:owner.name}});expect(approved.approvedAt).toBeGreaterThan(0);
  auth.manage(owner,pending.id,"block");auth.manage(owner,pending.id,"unblock");
  expect(auth.localAccountsView().accounts.find(a=>a.id===pending.id)?.approvedAt).toBe(approved.approvedAt);
});
it("does not consume an invite on invalid input or duplicate login", async () => {
  const link = auth.issueToken(owner, "invite", null, 1),
    raw = tokenOf(link.link);
  await expect(
    auth.register({ login: "bad", name: "", password, token: raw }),
  ).rejects.toThrow();
  await auth.register({ login: "duplicate", name: "First", password });
  await expect(
    auth.register({ login: "DUPLICATE", name: "Other", password, token: raw }),
  ).rejects.toThrow("занят");
  expect(auth.tokenInfo(raw).purpose).toBe("invite");
});
it("password recovery invalidates old sessions and old password while preserving device binding", async () => {
  const claim = auth.issueToken(owner, "claim", owner.id);
  await auth.redeem({
    token: tokenOf(claim.link),
    login: "owner",
    name: "Owner",
    password,
  });
  session.userId = owner.id;
  session.authVersion = 1;
  expect((await currentUser())?.id).toBe(owner.id);
  const first = auth.issueToken(owner, "reset", owner.id),
    second = auth.issueToken(owner, "reset", owner.id);
  expect(() => auth.tokenInfo(tokenOf(first.link))).toThrow();
  const result = await auth.redeem({
    token: tokenOf(second.link),
    password: "a completely new password",
  });
  expect(result.version).toBe(2);
  expect(await currentUser()).toBeNull();
  session.authVersion = 2;
  expect((await currentUser())?.id).toBe(owner.id);
  await expect(auth.authenticate("owner", password)).rejects.toThrow(
    "Неверный",
  );
  expect(
    (await auth.authenticate("owner", "a completely new password")).id,
  ).toBe(owner.id);
});
it("blocking invalidates authenticated sessions and device access without deleting data", async () => {
  const r = await auth.register({
    login: "other-user",
    name: "Other",
    password,
  });
  auth.decide(owner, r.id, true);
  session.userId = r.id;
  session.authVersion = 1;
  const token = "b".repeat(64);
  db.prepare(
    "INSERT INTO desktop_devices(id,token_hash,user_id,label,platform,created_at,expires_at) VALUES('other-device',?,?, 'PC','linux',0,9999999999)",
  ).run(tokenHash(token), r.id);
  auth.manage(owner, r.id, "block");
  expect(await currentUser()).toBeNull();
  expect(() => deviceByToken(token)).toThrow();
  expect(auth.credential(r.id)).toBeDefined();
  auth.manage(owner, r.id, "unblock");
  expect(await currentUser()).toBeNull();
  expect(
    (await auth.authenticate("other-user", password)).version,
  ).toBeGreaterThan(1);
});
it("refuses self-demotion, self-blocking, unauthorised administration and stale signup decisions", async () => {
  expect(() => auth.manage(owner, owner.id, "friend")).toThrow();
  expect(() => auth.manage(owner, owner.id, "block")).toThrow();
  expect(() =>
    auth.manage({ ...owner, is_admin: 0 }, owner.id, "admin"),
  ).toThrow();
  const r = await auth.register({
    login: "reject-user",
    name: "Reject",
    password,
  });
  auth.decide(owner, r.id, false);
  expect(() => auth.decide(owner, r.id, true)).toThrow();
  await expect(auth.authenticate("reject-user", password)).rejects.toThrow(
    "отозван",
  );
});
it("persists rate limits in the DB and permits retry after expiry", () => {
  auth.limit("scope", 2, 60);
  auth.limit("scope", 2, 60);
  expect(() => auth.limit("scope", 2, 60)).toThrow("Слишком");
  db.prepare("UPDATE account_attempts SET resets_at=0").run();
  expect(() => auth.limit("scope", 2, 60)).not.toThrow();
});
it("validates Origin and bounded JSON input before account operations", async () => {
  const request = (origin: string, body: string) =>
    new Request("https://home.test/api/auth/register", {
      method: "POST",
      headers: { host: "home.test", origin },
      body,
    });
  expect(() => auth.sameOrigin(request("https://evil.test", "{}"))).toThrow();
  expect(() => auth.sameOrigin(request("invalid", "{}"))).toThrow();
  await expect(
    auth.authBody(request("https://home.test", "null")),
  ).rejects.toThrow("Некорректный");
  await expect(
    auth.authBody(request("https://home.test", "x".repeat(4097))),
  ).rejects.toThrow("большой");
  expect(await auth.authBody(request("https://home.test", "{}"))).toEqual({});
});
it("keeps foreign keys valid after users are removed by maintenance fixtures", async () => {
  const r = await auth.register({
    login: "maintenance",
    name: "Maintenance",
    password,
  });
  auth.decide(owner, r.id, true);
  auth.issueToken(owner, "reset", r.id);
  db.prepare("DELETE FROM users WHERE id=?").run(r.id);
  expect(auth.credential(r.id)).toBeUndefined();
});

it("registration/login endpoints keep pending users outside protected APIs and reject cross-origin login", async () => {
  const { POST: registerRoute } =
    await import("../app/api/auth/register/route");
  const { POST: loginRoute } = await import("../app/api/auth/login/route");
  const { authed, json } = await import("./route");
  const request = (path: string, body: unknown, origin = "http://home.test") =>
    new Request(`http://home.test${path}`, {
      method: "POST",
      headers: {
        host: "home.test",
        origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const registered = await registerRoute(
    request("/api/auth/register", {
      login: "route-user",
      name: "Route",
      password,
    }),
  );
  expect(registered.status).toBe(200);
  expect((await registered.json()).pending).toBe(true);
  const handler = vi.fn(async () => json({ ok: true })),
    protectedRoute = authed(handler);
  expect(
    (
      await protectedRoute(new Request("http://home.test/api/private"), {
        params: Promise.resolve({}),
      })
    ).status,
  ).toBe(401);
  expect(handler).not.toHaveBeenCalled();
  auth.decide(owner, session.userId!, true);
  expect(
    (
      await protectedRoute(new Request("http://home.test/api/private"), {
        params: Promise.resolve({}),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await loginRoute(
        request(
          "/api/auth/login",
          { login: "route-user", password },
          "https://evil.test",
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await loginRoute(
        request("/api/auth/login", { login: "route-user", password: "wrong" }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await loginRoute(
        request("/api/auth/login", { login: "route-user", password }),
      )
    ).status,
  ).toBe(200);
});

it("registration by a room invite establishes friendship and invites the same account to that room", async () => {
  const group = Number(
    db
      .prepare(
        "INSERT INTO shared_lists(name,owner_id,created_at) VALUES('Invited room',?,0)",
      )
      .run(owner.id).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(?,?,'member',0)",
  ).run(group, owner.id);
  const link = auth.issueToken(owner, "invite", null, 24, { groupId: group });
  const r = await auth.register({
    login: "room-invited",
    name: "Invited",
    password,
    token: tokenOf(link.link),
  });
  expect(
    db
      .prepare<
        [number, number],
        { status: string }
      >("SELECT status FROM shared_list_members WHERE list_id=? AND user_id=?")
      .get(group, r.id)?.status,
  ).toBe("invited");
});

it("a long-lived stream guard stops after credential migration and session revocation", async () => {
  session.userId = owner.id;
  const { sessionGuard } = await import("./session");
  const legacy = await sessionGuard();
  expect(legacy()).toBe(true);
  const link = auth.issueToken(owner, "claim", owner.id);
  await auth.redeem({
    token: tokenOf(link.link),
    login: "stream-owner",
    name: "Owner",
    password,
  });
  expect(legacy()).toBe(false);
  session.authVersion = 1;
  const active = await sessionGuard();
  expect(active()).toBe(true);
  auth.manage(owner, owner.id, "revoke-sessions");
  expect(active()).toBe(false);
});
