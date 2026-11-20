import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./llm-config", () => ({ OLLAMA_URL: "http://ollama.test", external: {
  apiKey: "fixture", url: "http://llm.test", concurrency: 1,
} }));
const directory = mkdtempSync(path.join(tmpdir(), "ai-provider-gate-"));
process.env.DATA_DIR = directory;
process.env.MAPVEC_URL = "http://ocr.test";
const { externalChat, ollamaChat } = await import("./llm-providers");
const { featureFlags } = await import("./feature-flags");
const { mapvec } = await import("./mapvec");
const request = { model: "fixture", schema: { type: "object" as const }, system: "", user: "", timeoutMs: 1000 };
function disable(name: string) {
  const file = featureFlags().overridesFile;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, disabled: [name] }));
}
afterEach(() => { rmSync(featureFlags().overridesFile, { force: true }); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("does not send a queued external request after the switch is disabled", async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const first = externalChat(request);
  const queued = externalChat(request);
  disable("ai-enabled");
  release(Response.json({ choices: [{ message: { content: "{}" } }], usage: {} }));
  await expect(first).resolves.toHaveProperty("text", "{}");
  await expect(queued).rejects.toThrow("отключён администратором");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("blocks OCR and local chat before any provider network request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  disable("ai-enabled");
  await expect(ollamaChat(request)).rejects.toThrow("отключён администратором");
  await expect(mapvec("/lines", "fixture", new AbortController().signal)).rejects.toThrow("отключён администратором");
  expect(fetch).not.toHaveBeenCalled();
});
