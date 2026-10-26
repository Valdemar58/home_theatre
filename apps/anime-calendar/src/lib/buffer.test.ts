import { describe, expect, it } from "vitest";
import { ewma, readiness, RATE_MARGIN } from "./buffer";

const MB = 1e6;
// Серия 1,44 ГБ на 24 мин → 1 МБ/с
const ep = { size: 1440 * MB, rate: 1 * MB };

describe("readiness", () => {
  it("скорость выше нужной — можно смотреть, как только набран стартовый буфер", () => {
    expect(readiness({ ...ep, read: 30 * MB, speed: 3 * MB }).ready).toBe(true);
    const r = readiness({ ...ep, read: 0, speed: 3 * MB });
    expect(r.ready).toBe(false);
    expect(r.etaSec).toBeCloseTo(20 / 3, 1);
  });
  it("скорость ниже — ждать, пока буфер покроет разницу", () => {
    const st = { ...ep, read: 100 * MB, speed: 0.4 * MB };
    const r = readiness(st);
    expect(r.ready).toBe(false);
    // через предсказанное время условие выполняется
    const t = r.etaSec!;
    const later = readiness({ ...st, read: st.read + st.speed * (t + 1) });
    expect(later.ready).toBe(true);
    const earlier = readiness({ ...st, read: st.read + st.speed * (t - 5) });
    expect(earlier.ready).toBe(false);
  });
  it("условие: v·B ≥ (r·запас − v)·R", () => {
    const v = 0.5 * MB;
    const r = ep.rate * RATE_MARGIN;
    // B такое, что ровно хватает: v·B = (r − v)(S − B) → B = (r − v)·S / r
    const B = ((r - v) * ep.size) / r;
    expect(readiness({ ...ep, read: B + MB, speed: v }).ready).toBe(true);
    expect(readiness({ ...ep, read: B - 10 * MB, speed: v }).ready).toBe(false);
  });
  it("без скорости — прогноза нет; всё скачано — готово", () => {
    expect(readiness({ ...ep, read: 10 * MB, speed: 0 })).toEqual({ ready: false, etaSec: null });
    expect(readiness({ ...ep, read: ep.size, speed: 0 }).ready).toBe(true);
  });
});

describe("ewma", () => {
  it("первый замер — как есть, дальше сглаживается", () => {
    expect(ewma(null, 10)).toBe(10);
    expect(ewma(10, 0)).toBeCloseTo(8);
  });
});
