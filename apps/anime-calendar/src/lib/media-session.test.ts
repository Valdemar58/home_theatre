import { expect, it, vi } from "vitest";
import { bindMediaSession } from "./media-session";
it("routes native OS/PiP controls and publishes position/speed, then clears handlers", () => {
  const handlers = new Map<string, MediaSessionActionHandler | null>();
  const session = { setActionHandler: vi.fn((a, h) => handlers.set(a, h)), setPositionState: vi.fn(), playbackState: "none" };
  const controls = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), position: () => 20, duration: () => 100, rate: () => 1.1, paused: () => false };
  const stop = bindMediaSession(session as unknown as MediaSession, controls);
  handlers.get("play")!({action:"play"}); handlers.get("pause")!({action:"pause"}); handlers.get("seekto")!({action:"seekto",seekTime:50}); handlers.get("seekbackward")!({action:"seekbackward"});
  expect(controls.play).toHaveBeenCalledOnce(); expect(controls.pause).toHaveBeenCalledOnce(); expect(controls.seek.mock.calls).toEqual([[50],[10]]);
  expect(session.setPositionState).toHaveBeenCalledWith({duration:100,position:20,playbackRate:1.1}); stop(); expect([...handlers.values()].every(h => h === null)).toBe(true);
});
