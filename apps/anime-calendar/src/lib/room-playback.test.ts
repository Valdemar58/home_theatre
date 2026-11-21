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
it("play/pause aligns an initially late client immediately without repeatedly seeking on clock jitter", () => {
  const { v, r, sync, advance } = fixture(); v.currentTime = 11.2; sync.sync(); expect(v.currentTime).toBe(12);
  advance(200); v.currentTime = 12.1; sync.sync(); expect(v.currentTime).toBe(12.1);
  r.state = { ...r.state, at: 10_200, pos: 12.8, playing: false }; sync.sync(); expect(v.currentTime).toBe(12.8); expect(v.paused).toBe(true);
});
it("a failed command releases synchronization and reports the error", async () => {
  const { r, sync, error } = fixture(); r.command.mockRejectedValue(Error("Нет связи")); sync.request("pause", 12);
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Нет связи")); expect(sync.sync()).not.toBeNull();
});
