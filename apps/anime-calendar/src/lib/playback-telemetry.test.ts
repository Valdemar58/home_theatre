import { expect, it } from "vitest";
import { playbackTelemetry } from "./playback-telemetry";
it("keeps bounded decoder and transport evidence while discarding sensitive and invalid fields", () => {
  const result = playbackTelemetry({ client: "safari", token: "secret", element: { paused: true, readyState: 2, currentTime: 12, muted: false, volume: 99, decodedFrames: Infinity, src: "secret-url" }, transport: { mode: "direct", ice: "connected", channel: "open", packets: 100, directBytes: -1, sdp: "secret-sdp", address: "private-ip" } });
  expect(result).toEqual({ client: "safari", element: { currentTime: 12, readyState: 2, paused: true, muted: false }, transport: { packets: 100, mode: "direct", ice: "connected", channel: "open" } });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(playbackTelemetry({ client: "arbitrary-key" })).toBeNull();
  expect(playbackTelemetry(null)).toBeNull();
});
