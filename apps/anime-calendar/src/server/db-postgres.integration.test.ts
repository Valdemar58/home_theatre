import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
describe.skipIf(process.env.POSTGRES_TEST !== "1")("PostgreSQL adapter", () => {
  it("supports generated IDs, repeated parameters, binary data, and transaction rollback", async () => {
    process.env.DATABASE_DRIVER = "postgres";
    const { db } = await import("./db-postgres");
    expect(db.prepare<[], { ok: number }>("SELECT 1 ok").get()?.ok).toBe(1);
    // Other integration fixtures insert explicit IDs; PostgreSQL does not advance their sequence.
    db.prepare("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 0) + 1, false)").get();
    expect(() => db.transaction(() => {
      const r = db.prepare("INSERT INTO users (jellyfin_id,name,created_at) VALUES (?,?,?)").run("pg-test", "Postgres", 0);
      expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
      const row = db.prepare<[number], { id: number; name: string }>("SELECT id,name FROM users WHERE id=?1 OR id=?1").get(Number(r.lastInsertRowid));
      expect(row?.name).toBe("Postgres");
      db.transaction(() => db.prepare("UPDATE users SET name=? WHERE id=?").run("Nested", r.lastInsertRowid))();
      expect(db.prepare<[number], { name: string }>("SELECT name FROM users WHERE id=?").get(Number(r.lastInsertRowid))?.name).toBe("Nested");
      throw new Error("rollback fixture");
    })()).toThrow("rollback fixture");
    expect(db.prepare("SELECT 1 FROM users WHERE jellyfin_id=?").get("pg-test")).toBeUndefined();
    expect(() => db.prepare("SELECT pg_terminate_backend(pg_backend_pid())").get()).toThrow();
    expect(db.prepare<[], { ok: number }>("SELECT 1 ok").get()?.ok).toBe(1);
  });
});
