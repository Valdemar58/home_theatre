import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "coverage-"));
const { db } = await import("./db");
const { recordCoverage, coverageAttempt } = await import("./watch-coverage");
const session = { sid: "one", userId: 1, anilistId: 42, ep: 3, duration: 1000 };
beforeEach(() => {
  db.exec("DELETE FROM playback_coverage; DELETE FROM users;");
  db.prepare("INSERT INTO users (id,jellyfin_id,name,created_at) VALUES (1,'coverage','viewer',0)").run();
});
it("persists the union without crediting seek gaps or duplicate requests", () => {
  recordCoverage(session, [[0, 400]]);
  expect(recordCoverage(session, [[800, 1000]]).seconds).toBe(600);
  expect(recordCoverage(session, [[0, 400]]).watched).toBe(false);
  expect(recordCoverage(session, [[400, 600]]).watched).toBe(true);
  expect(recordCoverage(session, undefined).seconds).toBe(800);
});
it("isolates episodes and playback attempts, including already completed attempts", () => {
  expect(recordCoverage(session, [[0, 900]]).watched).toBe(true);
  expect(recordCoverage({ ...session, sid: "next", ep: 4 }, [[0, 10]]).seconds).toBe(10);
  expect(recordCoverage({ ...session, sid: "rewatch" }, [[0, 20]]).watched).toBe(false);
});
it("continues an unfinished same-file attempt after reopening, but not a different file or completed attempt", () => {
  const first = coverageAttempt(session, "file-a");
  recordCoverage({ ...session, sid: first }, [[0, 400]]);
  expect(coverageAttempt({ ...session, sid: "reopen" }, "file-a")).toBe(first);
  expect(coverageAttempt({ ...session, sid: "other" }, "file-b")).toBe("other");
  recordCoverage({ ...session, sid: first }, [[400, 800]]);
  expect(coverageAttempt({ ...session, sid: "rewatch" }, "file-a")).toBe("rewatch");
});
