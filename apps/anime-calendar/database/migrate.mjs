import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { connectionOptions } from "./connection.mjs";
export const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
export async function migrate(direction = "up") {
  if (!["up", "down"].includes(direction)) throw new Error("Migration direction must be up or down");
  return runner({ databaseUrl: connectionOptions(), dir: migrationDirectory, direction,
    migrationsTable: "calendar_migrations", checkOrder: true, singleTransaction: true,
    count: direction === "down" ? 1 : Infinity,
    log: message => console.log(message),
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await migrate(process.argv[2] ?? "up"); }
  catch (error) { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; }
}
