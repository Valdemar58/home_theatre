import "server-only";
import path from "node:path";
import { createSyncFn } from "synckit";
import type { Db, Statement } from "../../database/legacy-sqlite";
import { db as sqliteDb, migrateLlmOutputs as migrateLegacy } from "../../database/legacy-sqlite";
export type { Db, Statement } from "../../database/legacy-sqlite";

// Сеть pg работает в worker; синхронный контракт доменных модулей сохраняется.
// Запросы процесса и транзакции используют одно соединение без нативных модулей.
const globals = globalThis as unknown as { __db?: Db };
function open(): Db {
  if (process.env.DATABASE_DRIVER === "sqlite") return sqliteDb;
  if (process.env.DATABASE_DRIVER && process.env.DATABASE_DRIVER !== "postgres") throw new Error("Unknown DATABASE_DRIVER");
  const query = createSyncFn<(mode: string, sql?: string, params?: unknown[]) => { rows: unknown[]; changes: number; lastInsertRowid: number }>(
    path.join(process.cwd(), "database", "pg-worker.mjs"), { timeout: 45_000 });
  let depth = 0;
  const db: Db = {
    prepare<P extends unknown[] = unknown[], R = unknown>(sql: string): Statement<P, R> {
      return {
        get: (...params) => query("query", sql, params).rows[0] as R | undefined,
        all: (...params) => query("query", sql, params).rows as R[],
        run: (...params) => query("run", sql, params),
      };
    },
    exec: (sql) => { query("exec", sql); },
    transaction: (fn) => () => {
      const level = depth++;
      const savepoint = `calendar_${level}`;
      try {
        db.exec(level ? `SAVEPOINT ${savepoint}` : "BEGIN");
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Database transaction callbacks must be synchronous");
        db.exec(level ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        db.exec(level ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
        throw error;
      } finally { depth--; }
    },
  };
  return db;
}
export const db = new Proxy({} as Db, {
  get(_target, key) {
    const instance = globals.__db ?? (globals.__db = open());
    const value = Reflect.get(instance, key);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
export function stmt<P extends unknown[] = unknown[], R = unknown>(sql: string) {
  let statement: Statement<P, R> | undefined;
  return () => statement ?? (statement = db.prepare<P, R>(sql));
}
export const now = () => Math.floor(Date.now() / 1000);
export function migrateLlmOutputs(legacy: Db) {
  if (process.env.DATABASE_DRIVER !== "sqlite") throw new Error("Use versioned PostgreSQL migrations");
  return migrateLegacy(legacy);
}
