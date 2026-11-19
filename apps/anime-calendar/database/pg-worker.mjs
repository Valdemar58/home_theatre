import { runAsWorker } from "synckit";
import { createClient } from "./connection.mjs";
import { parameters } from "./sql.mjs";
let client, identities;
let inTransaction = false, transactionLost = false;
async function connect() {
  if (client) return;
  const pending = createClient();
  pending.on("error", () => { if (inTransaction) transactionLost = true; client = null; });
  try { await pending.connect(); }
  catch (error) { await pending.end().catch(() => {}); throw error; }
  const result = await pending.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'");
  identities = new Map(result.rows.map(r => [r.table_name, r.column_name]));
  client = pending;
}
runAsWorker(async (mode, sql, params = []) => {
  if (transactionLost) {
    // Не переподключаемся посреди транзакции и не повторяем её записи автоматически.
    if (/^\s*ROLLBACK\s*;?\s*$/i.test(sql)) {
      transactionLost = false; inTransaction = false;
      return { rows: [], changes: 0, lastInsertRowid: 0 };
    }
    throw new Error("PostgreSQL transaction interrupted; roll back before continuing");
  }
  await connect();
  let statement = parameters(sql);
  const table = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(statement)?.[1];
  const identity = mode === "run" && identities.get(table);
  if (identity && !/\bRETURNING\b/i.test(statement)) statement = statement.replace(/;\s*$/, "") + ` RETURNING "${identity}"`;
  const values = params.map(p => p instanceof Uint8Array ? Buffer.from(p) : p === undefined ? null : p);
  let result;
  try { result = await client.query(statement, values); }
  catch (error) {
    if (["57P01", "57P02", "57P03", "08006", "08003", "ECONNRESET", "EPIPE"].includes(error.code) || /connection.*(?:closed|terminated)/i.test(error.message)) {
      if (inTransaction) transactionLost = true;
      const old = client; client = null; await old?.end().catch(() => {});
    }
    throw error;
  }
  if (/^\s*BEGIN\b/i.test(statement)) inTransaction = true;
  if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(statement)) inTransaction = false;
  return { rows: result.rows ?? [], changes: result.rowCount ?? 0, lastInsertRowid: identity ? result.rows[0]?.[identity] ?? 0 : 0 };
});
