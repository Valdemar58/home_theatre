import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const directory = mkdtempSync(path.join(tmpdir(), "ai-task-pause-"));
process.env.DATA_DIR = directory;
const { featureFlags } = await import("./feature-flags");
const { registerHandler, startTask, latestTask, resumeTaskQueues } = await import("./tasks");
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Task transition timed out");
};
afterAll(() => rmSync(featureFlags().overridesFile, { force: true }));

it("holds a disabled AI job without repeated attempts, then resumes it", async () => {
  const file = featureFlags().overridesFile;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, disabled: ["ai-personal"] }));
  let attempts = 0;
  registerHandler("test-ai-pause", {
    title: async () => "fixture", fresh: () => false, href: () => "/", noun: "fixture",
    run: async () => { attempts++; featureFlags().assert("personal"); return { summary: "done", isNew: true }; },
  });
  await startTask("test-ai-pause", "fixture", { origin: "user", notify: false });
  await until(() => Boolean(latestTask("test-ai-pause", "fixture")?.error));
  expect(latestTask("test-ai-pause", "fixture")?.status).toBe("queued");
  resumeTaskQueues(); resumeTaskQueues();
  expect(attempts).toBe(1);
  rmSync(file);
  resumeTaskQueues();
  await until(() => latestTask("test-ai-pause", "fixture")?.status === "done");
  expect(attempts).toBe(2);
  expect(latestTask("test-ai-pause", "fixture")?.error).toBeNull();
});
