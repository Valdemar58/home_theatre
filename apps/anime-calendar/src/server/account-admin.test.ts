import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "account-cli-")), "fixture.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, jellyfin_id TEXT, name TEXT, is_admin INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE shared_lists(id INTEGER PRIMARY KEY);`);
  db.exec(readFileSync("database/account-schema.sql", "utf8"));
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["database/account-admin.mjs", ...args, "--sqlite", file, "--base-url", "http://127.0.0.1:5057"],
    { encoding: "utf8" });
  return { db, run };
}

it("owner bootstrap is not claimed by an unapproved registration and cannot be repeated", () => {
  const { db, run } = fixture();
  try {
    db.exec(`INSERT INTO users(id,name,is_admin,blocked) VALUES(1,'Pending',0,1);
      INSERT INTO local_accounts(user_id,login,password_hash,access,created_at) VALUES(1,'pending','fixture','pending',0);`);
    expect(run("create-owner").status).toBe(0);
    expect(db.prepare("SELECT id FROM users WHERE is_admin=1").get()).toEqual({ id: 2 });
    expect(db.prepare("SELECT access FROM local_accounts WHERE user_id=1").get()).toEqual({ access: "pending" });
    expect(run("create-owner").status).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM users").get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

it("CLI recovery preserves the existing owner ID and replaces only unused recovery links", () => {
  const { db, run } = fixture();
  try {
    db.exec("INSERT INTO users(id,jellyfin_id,name,is_admin) VALUES(42,'preserved','Admin',1)");
    expect(run("claim-admin").status).toBe(0);
    expect(run("claim-admin").status).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM account_tokens WHERE revoked=0").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT id,jellyfin_id FROM users").get()).toEqual({ id: 42, jellyfin_id: "preserved" });
    expect(run("reset", "--user-id", "42").status).toBe(1);
    db.exec("INSERT INTO local_accounts(user_id,login,password_hash,access,created_at) VALUES(42,'owner','fixture','approved',0)");
    expect(run("claim-admin").status).toBe(1);
    expect(run("reset", "--user-id", "42").status).toBe(0);
  } finally { db.close(); }
});
