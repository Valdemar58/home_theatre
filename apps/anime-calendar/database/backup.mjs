import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectionOptions } from "./connection.mjs";

export function postgresEnvironment() {
  const p = new pg.Client(connectionOptions()).connectionParameters;
  return { ...process.env, PGHOST: p.host, PGPORT: String(p.port), PGDATABASE: p.database,
    PGUSER: p.user, PGPASSWORD: p.password ?? "" };
}
export function dumpDatabase(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + ".tmp";
  const r = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", temporary], {
    env: postgresEnvironment(), stdio: ["ignore", "ignore", "pipe"],
  });
  if (r.status !== 0) throw new Error(`PostgreSQL backup failed (${r.error?.message ?? r.stderr?.toString() ?? r.status})`);
  fs.renameSync(temporary, destination);
  console.log(`PostgreSQL backup saved: ${path.basename(destination)}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { dumpDatabase(process.argv[2] || path.join(process.env.DATA_DIR || "./data", "postgres.dump")); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
