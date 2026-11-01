import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.mjs";
import { createClient } from "./connection.mjs";
import { importSqlite } from "./import-sqlite.mjs";

// Отдельный smoke-check, запускается только в одноразовой calendar-test-db.
if (process.env.POSTGRES_TEST !== "1") throw new Error("Import tests require the isolated PostgreSQL test service");
await migrate(); await migrate();
const client = createClient(); await client.connect();
try {
  const source = path.join(mkdtempSync(path.join(tmpdir(), "calendar-import-")), "test.db");
  const sqlite = new DatabaseSync(source);
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, jellyfin_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE anime_profile (anilist_id INTEGER PRIMARY KEY, data TEXT NOT NULL, embedding BLOB, updated_at INTEGER NOT NULL);`);
  sqlite.prepare("INSERT INTO users VALUES (?,?,?,?)").run(42, "migration-test", "Тест 日本語", 1793480400);
  const embedding = Buffer.from(new Float32Array([0.1, 0.2, -0.3]).buffer);
  sqlite.prepare("INSERT INTO anime_profile VALUES (?,?,?,?)").run(30002, '{"title":"Берсерк"}', embedding, 1793480400);
  sqlite.close();
  const result = await importSqlite(source);
  assert.equal(result.rows, 2);
  assert.equal((await client.query("SELECT name FROM users WHERE id=42")).rows[0].name, "Тест 日本語");
  assert.deepEqual((await client.query("SELECT embedding FROM anime_profile WHERE anilist_id=30002")).rows[0].embedding, embedding);
  const inserted = await client.query("INSERT INTO users (jellyfin_id,name,created_at) VALUES ('next-id','Next',0) RETURNING id");
  assert.ok(inserted.rows[0].id > 42, "Identity sequence must advance beyond imported IDs");
  await assert.rejects(() => importSqlite(source), /not empty/);
  assert.match((await importSqlite(source, { auto: true })).skipped, /already imported/);
  // Удаляем только тестовые строки, оставляя схему для тестов адаптера.
  await client.query("DELETE FROM users"); await client.query("DELETE FROM anime_profile"); await client.query("DELETE FROM calendar_data_imports");
  const brokenPath = path.join(path.dirname(source), "broken.db");
  const broken = new DatabaseSync(brokenPath);
  broken.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, jellyfin_id TEXT, name TEXT, created_at INTEGER); CREATE TABLE zzz_unsupported_table (id INTEGER)");
  broken.prepare("INSERT INTO users VALUES (1,'rollback','Rollback',0)").run(); broken.close();
  await assert.rejects(() => importSqlite(brokenPath), /no PostgreSQL migration/);
  assert.equal((await client.query("SELECT count(*) n FROM users")).rows[0].n, 0, "Failed import must roll back all rows");
  console.log("PostgreSQL migration/import checks passed (idempotence, binary data, identities, refusal to overwrite, rollback)");
} finally { await client.end(); }
