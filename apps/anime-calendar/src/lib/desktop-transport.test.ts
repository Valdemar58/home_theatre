import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./client", () => ({ api: mocks.api }));
import { connectDesktop, type DesktopDiagnostics } from "./desktop-transport";
class Channel extends EventTarget {
  readyState = "connecting"; binaryType = "arraybuffer";
  onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: ArrayBuffer }) => void;
  open() { this.readyState = "open"; this.onopen?.(); this.dispatchEvent(new Event("open")); }
  send(raw: string) {
    const r = JSON.parse(raw), bytes = new Uint8Array(r.length + 8), view = new DataView(bytes.buffer);
    view.setUint32(0, r.id); view.setUint32(4, 0); bytes.fill(42, 8);
    queueMicrotask(() => this.onmessage?.({ data: bytes.buffer }));
  }
}
class Peer {
  static all: Peer[] = [];
  dc = new Channel(); iceGatheringState = "complete"; connectionState = "new"; signalingState = "have-local-offer";
  localDescription = { sdp: "v=0\r\nfixture" }; remoteDescription: unknown = null;
  constructor() { Peer.all.push(this); }
  createDataChannel() { return this.dc; }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
  close() { this.connectionState = "closed"; this.dc.readyState = "closed"; }
}
let sw: EventTarget, reports: DesktopDiagnostics[], dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); Peer.all = []; reports = []; dispose = undefined; sw = new EventTarget();
  Object.assign(sw, { controller: {}, register: vi.fn(async () => ({})), ready: Promise.resolve({}) });
  vi.stubGlobal("window", { isSecureContext: true }); vi.stubGlobal("navigator", { serviceWorker: sw }); vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))));
  mocks.api.mockResolvedValue({ generation: 1, recovering: false, relayEnabled: false, iceServers: [], answer: "v=0\r\nanswer" });
});
afterEach(async () => { dispose?.(); await vi.advanceTimersByTimeAsync(500); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function start() {
  const promise = connectDesktop("fixture-lease", d => reports.push(d));
  await vi.advanceTimersByTimeAsync(4001); dispose = await promise;
}
function range() {
  const port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as unknown };
  const event = new Event("message"); Object.assign(event, { data: { type: "desktop-range", lease: "fixture-lease", offset: 0, length: 4 }, ports: [port] });
  sw.dispatchEvent(event); return port;
}
it("direct-only connection ends initial loading after 30 seconds without attempting the disabled HTTP relay", async () => {
  await start(); const port = range(); await vi.advanceTimersByTimeAsync(30000);
  expect(reports.at(-1)?.mode).toBe("closed"); expect(reports.at(-1)?.reason).toContain("30 секунд");
  expect(reports.at(-1)?.reason).toContain("ретрансляция отключена");
  expect(fetch).not.toHaveBeenCalled(); expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("30 секунд") }));
});
it("a successful direct read cancels the initial deadline and preserves later buffered recovery", async () => {
  await start(); Peer.all.at(-1)!.dc.open(); const port = range(); await vi.advanceTimersByTimeAsync(1);
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(ArrayBuffer) }), expect.any(Array));
  expect(reports.at(-1)?.directBytes).toBe(4); expect(fetch).not.toHaveBeenCalled();
  const channel = Peer.all.at(-1)!.dc; channel.readyState = "closed"; channel.onclose?.();
  await vi.advanceTimersByTimeAsync(45000);
  expect(reports.some(d => d.mode === "closed")).toBe(false);
});
it("missing browser transport produces an actionable failure instead of an endless spinner", async () => {
  vi.stubGlobal("navigator", {}); await start();
  expect(reports.at(-1)?.mode).toBe("closed"); expect(reports.at(-1)?.reason).toContain("Браузер"); expect(fetch).not.toHaveBeenCalled();
});
it("older servers without relay capability information retain the existing HTTP fallback", async () => {
  mocks.api.mockResolvedValue({ generation: 1, recovering: false, iceServers: [] });
  await start(); const port = range(); await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("?offset=0&length=4"), expect.any(Object));
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(ArrayBuffer) }), expect.any(Array)); expect(reports.at(-1)?.mode).toBe("relay");
});
it("does not disconnect a slow mobile transfer while packets keep making progress", async () => {
  await start(); const dc = Peer.all.at(-1)!.dc; dc.open();
  dc.send = raw => {
    const request = JSON.parse(raw);
    for(let i=0;i<4;i++)setTimeout(()=>{
      const packet=new Uint8Array(9),view=new DataView(packet.buffer);view.setUint32(0,request.id);view.setUint32(4,i);packet[8]=42;dc.onmessage?.({data:packet.buffer});
    },(i+1)*5000);
  };
  const port=range();await vi.advanceTimersByTimeAsync(21000);
  expect(reports.at(-1)?.directBytes).toBe(4);expect(reports.some(r=>r.mode==="closed")).toBe(false);
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({bytes:expect.any(ArrayBuffer)}),expect.any(Array));
});
