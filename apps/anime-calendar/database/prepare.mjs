import { migrate } from "./migrate.mjs";
import { importSqlite } from "./import-sqlite.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function prepareDatabase() {
  if (process.env.DATABASE_DRIVER === "sqlite") return;
  if (process.env.DATABASE_MIGRATE !== "false") await migrate();
  if ((process.env.DATABASE_IMPORT_SQLITE || "auto") === "auto") {
    console.log(await importSqlite(path.join(process.env.DATA_DIR || "./data", "anime-calendar.db"), { auto: true }));
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await prepareDatabase(); }
  catch (error) { console.error(`Database preparation failed: ${error.message}`); process.exitCode = 1; }
}
