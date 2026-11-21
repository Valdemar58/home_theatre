import { expect, it } from "vitest";
import { DEFAULT_SYNC_POLICY as p, syncCorrection, syncPolicy } from "./sync-policy";
it("applies the tolerance, bounded speed curves, and large-discontinuity seek", () => {
  expect(syncCorrection(-0.2, true)).toEqual({ seek: false, rate: 1 });
  expect(syncCorrection(-1, true).rate).toBeGreaterThan(1); expect(syncCorrection(-4, true).rate).toBeLessThanOrEqual(p.maxRate);
  expect(syncCorrection(4, true).rate).toBeGreaterThanOrEqual(p.minRate); expect(syncCorrection(-6, true).seek).toBe(true);
  expect(syncCorrection(-1, false)).toEqual({ seek: true, rate: 1 });
  expect(syncCorrection(-1, true, { ...p, curve: "linear" }).rate).toBeGreaterThan(syncCorrection(-1, true).rate);
  expect(syncCorrection(-1, true, { ...p, settleSeconds: 20 }).rate).toBeLessThan(syncCorrection(-1, true).rate);
  expect(syncCorrection(-1, true, { ...p, maxRate: 1 }).rate).toBe(1);
});
it("rejects unsafe and inconsistent policy input; ignores unknown keys", () => {
  for (const bad of [{maxRate:2},{tolerance:NaN},{hardSeek:0.1},{curve:"bad"},{minRate:0},{settleSeconds:0}]) expect(() => syncPolicy(bad)).toThrow();
  expect(syncPolicy({ ...p, arbitrary: "secret" })).toEqual(p);
});
