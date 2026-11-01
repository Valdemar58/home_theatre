import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "./connection.mjs";
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = value => value instanceof Uint8Array ? { binary: Buffer.from(value).toString("base64") } : value;
const signature = values => BigInt("0x" + createHash("sha256").update(JSON.stringify(values.map(normalize))).digest("hex"));
const modulus = 1n << 256n;

export async function importSqlite(sourcePath, { auto = false } = {}) {
  if (!fs.existsSync(sourcePath)) { if (auto) return { skipped: "no SQLite database" }; throw new Error("SQLite source does not exist"); }
  const client = createClient();
  await client.connect();
  let sqlite;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(68413620261101)");
    if (auto && (await client.query("SELECT 1 FROM calendar_data_imports LIMIT 1")).rowCount) {
      await client.query("ROLLBACK"); return { skipped: "SQLite was already imported" };
    }
    const target = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT IN ('calendar_migrations', 'calendar_data_imports') ORDER BY table_name")).rows.map(r => r.table_name);
    for (const table of target) {
      if ((await client.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount) throw new Error(`Target table ${table} is not empty; import refuses to overwrite application data`);
    }
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    const snapshotPath = sourcePath + `.before-postgres-${Date.now()}.db`;
    try { await backup(source, snapshotPath); } finally { source.close(); }
    sqlite = new DatabaseSync(snapshotPath, { readOnly: true });
    console.log(`Consistent SQLite snapshot saved: ${path.basename(snapshotPath)}`);
    const broken = sqlite.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`SQLite has ${broken.length} foreign-key violations; repair these before import`);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const report = [];
    for (const table of tables) {
      if (!target.includes(table)) throw new Error(`Source table ${table} has no PostgreSQL migration`);
      const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c => c.name);
      const pgColumns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [table])).rows.map(c => c.column_name);
      if (columns.some(c => !pgColumns.includes(c))) throw new Error(`Source columns of ${table} are newer than PostgreSQL migrations`);
      let count = 0, checksum = 0n, batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const values = batch.flat().map(v => v instanceof Uint8Array ? Buffer.from(v) : v);
        const slots = batch.map((_, i) => '(' + columns.map((_, j) => '$' + (i * columns.length + j + 1)).join(',') + ')').join(',');
        await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES ${slots}`, values);
        batch = [];
      };
      for (const row of sqlite.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`).iterate()) {
        const values = columns.map(c => row[c]);
        checksum = (checksum + signature(values)) % modulus; count++; batch.push(values);
        if (batch.length >= 100) await flush();
      }
      await flush();
      // Сверяем не только количество строк: все значения, включая бинарные эмбеддинги.
      let actual = 0n, actualCount = 0;
      await client.query(`DECLARE import_verify NO SCROLL CURSOR FOR SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`);
      for (;;) {
        const rows = (await client.query("FETCH 1000 FROM import_verify")).rows;
        if (!rows.length) break;
        for (const row of rows) { actual = (actual + signature(columns.map(c => row[c]))) % modulus; actualCount++; }
      }
      await client.query("CLOSE import_verify");
      if (count !== actualCount || checksum !== actual) throw new Error(`Validation failed for ${table}; the entire import will be rolled back`);
      const identities = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_identity='YES'", [table])).rows;
      for (const { column_name: column } of identities) await client.query(`SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT MAX(${quote(column)}) FROM ${quote(table)}),1), EXISTS(SELECT 1 FROM ${quote(table)}))`, [table, column]);
      report.push({ table, rows: count, checksum: checksum.toString(16) });
      console.log(`${table}: ${count} rows verified`);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    await client.query("INSERT INTO calendar_data_imports (source_sha256, report) VALUES ($1,$2)", [digest, JSON.stringify(report)]);
    await client.query("COMMIT");
    return { digest, snapshot: snapshotPath, tables: report.length, rows: report.reduce((n,r) => n+r.rows,0) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { sqlite?.close(); await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(await importSqlite(process.argv[2] ?? path.join(process.env.DATA_DIR || "./data", "anime-calendar.db"))); }
  catch (error) { console.error(`Import failed: ${error.message}`); process.exitCode = 1; }
}
