import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ leaseFor: vi.fn(() => ({ bytes: 321 })), relayChunk: vi.fn(async (_lease: unknown, _offset: number, length: number) => new Uint8Array(length)) }));
vi.mock("@/server/route", () => ({ authed: (handler: unknown) => handler, ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/server/desktop-stream", () => ({ ...mocks, CHUNK: 1048576, parseRange: (range: string | null, bytes: number) => range ? [2, 5] : [0, bytes - 1] }));
import { GET, HEAD } from "./route";
type Handler = (req: Request, user: { id: number }, params: { lease: string }) => Promise<Response>;
const invoke = (handler: unknown, method: string, range?: string) => (handler as Handler)(new Request("https://example.test/desktop-media/secret/file.mp4", { method, headers: range ? { range } : {} }), { id: 2 }, { lease: "secret" });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); mocks.relayChunk.mockClear(); });
it("rejects disabled native HTTP relay immediately instead of returning an endlessly pending body", async () => {
  vi.stubEnv("DESKTOP_RELAY_ENABLED", "0"); vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(invoke(GET, "GET")).rejects.toMatchObject({ status: 503 });
  expect(mocks.relayChunk).not.toHaveBeenCalled();
});
it("serves authenticated HEAD metadata without starting media transfer when relay is disabled", async () => {
  vi.stubEnv("DESKTOP_RELAY_ENABLED", "0");
  const response = await invoke(HEAD, "HEAD", "bytes=2-5");
  expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 2-5/321");
  expect(response.headers.get("content-length")).toBe("4"); expect(await response.text()).toBe("");
  expect(mocks.leaseFor).toHaveBeenCalledWith("secret", 2); expect(mocks.relayChunk).not.toHaveBeenCalled();
});
it("preserves explicitly enabled HTTP range relay", async () => {
  vi.stubEnv("DESKTOP_RELAY_ENABLED", "1");
  const response = await invoke(GET, "GET", "bytes=2-5");
  expect(response.status).toBe(206); expect((await response.arrayBuffer()).byteLength).toBe(4);
  expect(mocks.relayChunk).toHaveBeenCalledTimes(1);
});
