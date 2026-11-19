import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    env: { DATABASE_DRIVER: "sqlite" },
    // PostgreSQL fixtures share one disposable database and reset the same tables.
    // SQLite fixtures have separate temporary files and may run in parallel.
    fileParallelism: process.env.POSTGRES_TEST !== "1",
  },
});
