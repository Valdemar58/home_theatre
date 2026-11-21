import { expect, it, vi } from "vitest";
import { RoomPlayback } from "./room-playback";
function fixture() {
  let now = 10_000;
  const v = { paused: false, ended: false, seeking: false, readyState: 4, currentTime: 12, duration: 100, playbackRate: 1, play: vi.fn(async () => { v.paused = false; }), pause: vi.fn(() => { v.paused = true; }) };
  const r = { state: { at: now, pos: 12, playing: true, ep: 1, hold: [] }, canControl: true, serverNow: () => now, command: vi.fn(async (_action: string, _pos: number) => {}) };
  const error = vi.fn(), sync = new RoomPlayback(() => v, () => r, error, () => now);
  return { v, r, sync, error, advance: (ms: number) => { now += ms; } };
}
it("native fullscreen pause/play commands reach the room instead of being undone while awaiting acknowledgement", async () => {
  const { v, r, sync } = fixture(); let acknowledge!: () => void;
  r.command.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  v.paused = true; sync.nativePlayback(false, true); await Promise.resolve();
  sync.sync(); expect(v.play).not.toHaveBeenCalled(); expect(r.command).toHaveBeenCalledWith("pause", 12);
  r.state = { ...r.state, playing: false }; acknowledge(); await vi.waitFor(() => expect(sync.sync()).not.toBeNull());
  v.paused = false; sync.nativePlayback(true, true); await Promise.resolve();
  expect(r.command).toHaveBeenLastCalledWith("play", 12);
});
it("synchronization events and buffering/ended events never become native user commands", async () => {
  const { v, r, sync } = fixture();
  r.state.playing = false; sync.sync(); sync.nativePlayback(false, true);
  expect(r.command).not.toHaveBeenCalled();
  v.readyState = 1; sync.nativePlayback(true, true); expect(r.command).not.toHaveBeenCalled();
  v.readyState = 4; v.ended = true; sync.nativePlayback(true, true); expect(r.command).not.toHaveBeenCalled();
});
it("ordinary page events and viewers without control cannot change the room", () => {
  const { r, sync } = fixture(); sync.nativePlayback(false, false); r.canControl = false; sync.nativePlayback(false, true); expect(r.command).not.toHaveBeenCalled();
});
it("catches up a small delay by speed and aligns on a shared pause", () => {
  const { v, r, sync, advance } = fixture(); v.currentTime = 11.2; sync.sync(); expect(v.currentTime).toBe(11.2); expect(v.playbackRate).toBeGreaterThan(1);
  advance(200); v.currentTime = 12.1; sync.sync(); expect(v.currentTime).toBe(12.1);
  r.state = { ...r.state, at: 10_200, pos: 12.8, playing: false }; sync.sync(); expect(v.currentTime).toBe(12.8); expect(v.paused).toBe(true);
});
it("swiping out of fullscreen pauses the room regardless of event ordering; entering PiP does not", async () => {
  const { v, r, sync } = fixture(); sync.transition(); v.paused = true; sync.endFullscreen(); await Promise.resolve();
  expect(r.command).toHaveBeenCalledWith("pause", 12); sync.sync(); expect(v.play).not.toHaveBeenCalled();
  const pip = fixture(); pip.sync.transition(); pip.sync.endFullscreen(true); await Promise.resolve(); expect(pip.r.command).not.toHaveBeenCalled();
});
it("native PiP seek is shared but internal correction does not echo", async () => {
  const { v, r, sync } = fixture(); sync.setPosition(15); sync.nativeSeek(true); await Promise.resolve(); expect(r.command).not.toHaveBeenCalled();
  v.currentTime = 25; sync.nativeSeek(true); await Promise.resolve(); expect(r.command).toHaveBeenCalledWith("seek", 25);
});
it("orders rapid native pause/play requests instead of losing the reversal while waiting", async () => {
  const { v, r, sync } = fixture(); let ack!: () => void;
  r.command.mockImplementationOnce(() => new Promise<void>(resolve => { ack = resolve; }));
  v.paused = true; sync.nativePlayback(false, true); await Promise.resolve();
  v.paused = false; sync.nativePlayback(true, true); ack();
  await vi.waitFor(() => expect(r.command).toHaveBeenCalledTimes(2)); expect(r.command.mock.calls.map(c => c[0])).toEqual(["pause", "play"]);
});
it("a failed command releases synchronization and reports the error", async () => {
  const { r, sync, error } = fixture(); r.command.mockRejectedValue(Error("Нет связи")); sync.request("pause", 12);
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Нет связи")); expect(sync.sync()).not.toBeNull();
});
