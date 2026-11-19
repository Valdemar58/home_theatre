import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { newToken, tokenHash } from "./account-security.mjs";
import { createClient } from "./connection.mjs";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "user-id": { type: "string" },
    "base-url": { type: "string" },
    sqlite: { type: "string" },
  },
});
const command = positionals[0];
if (!["claim-admin", "reset", "create-owner"].includes(command))
  throw new Error(
    "Usage: node database/account-admin.mjs claim-admin|reset|create-owner [--user-id N] --base-url URL [--sqlite FILE]",
  );
const base = new URL(
  values["base-url"] || process.env.PUBLIC_URL || "http://127.0.0.1:5056",
);
if (
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  !["https:", "http:"].includes(base.protocol)
)
  throw new Error("Use a server origin without credentials or a path");
if (
  base.protocol === "http:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
)
  throw new Error("Remote recovery links require HTTPS");
let pg, sqlite;
const query = async (sql, params = []) => {
  if (sqlite) {
    const statement = sqlite.prepare(sql);
    return /^\s*(SELECT|INSERT.*RETURNING)/is.test(sql)
      ? statement.all(...params)
      : statement.run(...params);
  }
  return (
    await pg.query(
      sql.replace(/\?/g, () => "$" + ++query.index),
      params,
    )
  ).rows;
};
query.index = 0;
async function q(sql, params = []) {
  query.index = 0;
  return query(sql, params);
}
try {
  if (values.sqlite) {
    sqlite = new DatabaseSync(values.sqlite);
    sqlite.exec("PRAGMA foreign_keys=ON");
  } else {
    pg = createClient();
    await pg.connect();
  }
  await q("BEGIN");
  let user;
  if (command === "create-owner") {
    if (
      (
        await q(
          "SELECT id FROM users WHERE is_admin=1 UNION SELECT user_id FROM local_accounts WHERE access='approved' LIMIT 1",
        )
      ).length
    )
      throw new Error(
        "Existing owner or approved users found. Use claim-admin to preserve the current owner identity.",
      );
    const result = await q(
      "INSERT INTO users(jellyfin_id,name,is_admin,created_at) VALUES(?,?,1,?) RETURNING id,name,is_admin,blocked",
      [`local:${randomUUID()}`, "Владелец", Math.floor(Date.now() / 1000)],
    );
    user = result[0];
  } else {
    if (values["user-id"]) {
      const id = Number(values["user-id"]);
      if (!Number.isSafeInteger(id) || id < 1)
        throw new Error("Invalid user ID");
      user = (
        await q("SELECT id,name,is_admin,blocked FROM users WHERE id=?", [id])
      )[0];
    } else {
      const admins = await q(
        "SELECT id,name,is_admin,blocked FROM users WHERE is_admin=1 AND blocked=0",
      );
      if (admins.length !== 1)
        throw new Error(
          "Specify --user-id; expected exactly one active administrator",
        );
      user = admins[0];
    }
    if (!user) throw new Error("User not found");
  }
  if (command !== "reset" && (!user.is_admin || user.blocked))
    throw new Error("Claim requires an active existing administrator");
  const account = (
    await q("SELECT user_id,access FROM local_accounts WHERE user_id=?", [
      user.id,
    ])
  )[0];
  if (
    command === "reset" &&
    (!account || account.access !== "approved" || user.blocked)
  )
    throw new Error("Password recovery requires an approved local account");
  if (command !== "reset" && account)
    throw new Error("Account already configured. Use reset.");
  const purpose = command === "reset" ? "reset" : "claim",
    raw = newToken(),
    id = randomUUID(),
    now = Math.floor(Date.now() / 1000);
  await q(
    "UPDATE account_tokens SET revoked=1 WHERE user_id=? AND purpose=? AND used_at IS NULL",
    [user.id, purpose],
  );
  await q(
    "INSERT INTO account_tokens(id,token_hash,purpose,user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    [id, tokenHash(raw), purpose, user.id, now, now + 3600],
  );
  await q(
    "INSERT INTO account_audit(id,user_id,actor_id,action,created_at) VALUES(?,?,NULL,?,?)",
    [randomUUID(), user.id, `owner-cli-${purpose}`, now],
  );
  await q("COMMIT");
  console.log(
    `One-time ${purpose} link for existing user #${user.id}; expires in 1 hour:`,
  );
  console.log(`${base.origin}/account/setup#token=${raw}`);
} catch (error) {
  try {
    await q("ROLLBACK");
  } catch {}
  console.error(error.message);
  process.exitCode = 1;
} finally {
  sqlite?.close();
  await pg?.end();
}
