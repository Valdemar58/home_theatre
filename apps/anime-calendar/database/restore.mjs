import { spawnSync } from "node:child_process";
import path from "node:path";
import { createClient } from "./connection.mjs";
import { postgresEnvironment } from "./backup.mjs";
try {
  const client = createClient();
  await client.connect();
  try {
    const tables = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' LIMIT 1");
    if (tables.rowCount) throw new Error("Restore requires an empty database; refusing to overwrite existing tables");
  } finally { await client.end(); }
  const source = process.argv[2] || path.join(process.env.DATA_DIR || "./data", "postgres.dump");
  const environment = postgresEnvironment();
  const result = spawnSync("pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", environment.PGDATABASE, source], {
    env: environment, stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) throw new Error(`PostgreSQL restore failed: ${result.error?.message ?? result.stderr?.toString()}`);
  console.log("PostgreSQL restore completed");
} catch (error) { console.error(error.message); process.exitCode = 1; }
