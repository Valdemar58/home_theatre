import pg from "pg";
pg.types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("PostgreSQL integer exceeds JavaScript safe range");
  return number;
});
pg.types.setTypeParser(1700, Number);
export function connectionOptions() {
  const options = {
    application_name: "anime-calendar", connectionTimeoutMillis: 10_000,
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 30_000),
    idle_in_transaction_session_timeout: 60_000,
  };
  if (process.env.DATABASE_URL) options.connectionString = process.env.DATABASE_URL;
  return options;
}
export const createClient = () => new pg.Client(connectionOptions());
