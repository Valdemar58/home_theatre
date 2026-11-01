import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createClient } from "./connection.mjs";
import { dumpDatabase, postgresEnvironment } from "./backup.mjs";

if (process.env.POSTGRES_TEST !== "1") throw new Error("Backup checks require the isolated PostgreSQL test database");
const client = createClient(); await client.connect();
try {
  await client.query("INSERT INTO cache(key,value,expires_at,class) VALUES ('backup-fixture','日本語 / русский',0,'entity') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  dumpDatabase("/tmp/calendar-backup-check.dump");
  await client.query("CREATE DATABASE calendar_restore_test");
  const environment = { ...postgresEnvironment(), PGDATABASE: "calendar_restore_test", DATABASE_URL: "" };
  const result = spawnSync(process.execPath, ["database/restore.mjs", "/tmp/calendar-backup-check.dump"], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const savedDatabase = process.env.PGDATABASE;
  process.env.PGDATABASE = "calendar_restore_test";
  const restored = createClient(); await restored.connect();
  try {
    assert.equal((await restored.query("SELECT value FROM cache WHERE key='backup-fixture'")).rows[0].value, "日本語 / русский");
    assert.equal((await restored.query("SELECT count(*) n FROM calendar_migrations")).rows[0].n, 2);
  } finally { await restored.end(); process.env.PGDATABASE = savedDatabase; }
  const refused = spawnSync(process.execPath, ["database/restore.mjs", "/tmp/calendar-backup-check.dump"], { env: environment, encoding: "utf8" });
  assert.notEqual(refused.status, 0, "Restore must refuse a nonempty database");
  console.log("PostgreSQL backup/restore verified, including data, migration history and overwrite refusal");
} finally {
  await client.query("DROP DATABASE IF EXISTS calendar_restore_test");
  await client.query("DELETE FROM cache WHERE key='backup-fixture'");
  await client.end();
}
