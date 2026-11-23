import { expect, it } from "vitest";
import { mediaReady } from "./media-readiness";
it("does not mark the observed Safari pending seek with 0.5ms buffered as ready", () => {
  const safari = { readyState: 3, seeking: true, ahead: 0.0005, position: 28.0895, duration: 1423.097 };
  expect(mediaReady(safari)).toBe(false);
  expect(mediaReady({ ...safari, seeking: false })).toBe(false);
  expect(mediaReady({ ...safari, seeking: false, ahead: 0.2 })).toBe(true);
});
it("permits a small native pause buffer and the final frame without a five-second deadlock", () => {
  expect(mediaReady({ readyState: 4, seeking: false, ahead: 0.15, position: 5, duration: 24 })).toBe(true);
  expect(mediaReady({ readyState: 3, seeking: false, ahead: 0.02, position: 23.97, duration: 24 })).toBe(true);
});
