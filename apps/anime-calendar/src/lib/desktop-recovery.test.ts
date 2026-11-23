import { expect, it } from "vitest";
import { DesktopRecovery } from "./desktop-recovery";
it("does not restart a slow transfer with continuing packet progress, even before a complete block", () => {
  const recovery = new DesktopRecovery();
  for (let t = 0; t < 90000; t += 1000) expect(recovery.observe(t, true, `${Math.floor(t / 5000)}:0`)).toBe(false);
});
it("retries an exhausted held video only after twenty seconds with no progress", () => {
  const recovery = new DesktopRecovery();
  expect(recovery.observe(0, true, "0")).toBe(false);
  expect(recovery.observe(5000, true, "0")).toBe(false);
  expect(recovery.observe(20000, true, "0")).toBe(true);
  expect(recovery.observe(21000, true, "0")).toBe(false);
  expect(recovery.observe(30000, false, "0")).toBe(false);
  expect(recovery.observe(40000, true, "0")).toBe(false);
});
