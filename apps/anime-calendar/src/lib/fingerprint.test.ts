import { describe, expect, it } from "vitest";
import { commonRun, FP_STEP, pickSegment, popcount, segmentsFromChapters } from "./fingerprint";

// Детерминированный «шум» — разные отпечатки у разных серий
const fmix = (h: number) => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
};
const noise = (seed: number, n: number) => Array.from({ length: n }, (_, i) => fmix(fmix(seed) ^ i));
const at = (sec: number) => Math.round(sec / FP_STEP);

describe("отпечатки", () => {
  it("popcount", () => {
    expect([0, 1, 0xff, 0xffffffff, 0x80000001].map(popcount)).toEqual([0, 1, 8, 32, 2]);
  });

  it("общий отрезок при разном сдвиге: опенинг с 10 с в одной серии и с 130 с в другой", () => {
    const op = noise(7, at(90));
    const a = [...noise(1, at(10)), ...op, ...noise(2, at(200))];
    // во второй серии — небольшие искажения (1–2 бита), отрезок не рвётся
    const b = [...noise(3, at(130)), ...op.map((v, i) => (i % 17 === 0 ? v ^ 0b11 : v)), ...noise(4, at(60))];
    const r = commonRun(a, b)!;
    expect(r.a0).toBeCloseTo(10, 0);
    expect(r.b0).toBeCloseTo(130, 0);
    expect(r.a1 - r.a0).toBeGreaterThan(88);
  });

  it("нет общего — null", () => {
    expect(commonRun(noise(5, at(300)), noise(6, at(300)))).toBeNull();
  });

  it("отрезок серии — самый длинный подходящий, со смещением конца", () => {
    expect(pickSegment("op", [{ start: 5, end: 12 }, { start: 133, end: 223 }])).toEqual({ kind: "op", start: 133, end: 223 });
    expect(pickSegment("ed", [{ start: 142, end: 232 }], 1232)).toEqual({ kind: "ed", start: 1374, end: 1464 });
    expect(pickSegment("op", [{ start: 0, end: 400 }])).toBeNull();
  });

  it("главы файла: опенинг и эндинг до следующей главы", () => {
    const ch = [{ name: "Вступление", start: 0 }, { name: "Опенинг", start: 134 }, { name: "Часть A", start: 224 }, { name: "Эндинг", start: 1374.9 }, { name: "Анонс", start: 1464.9 }];
    expect(segmentsFromChapters(ch, 1472)).toEqual([{ kind: "op", start: 134, end: 224 }, { kind: "ed", start: 1374.9, end: 1464.9 }]);
  });
});
