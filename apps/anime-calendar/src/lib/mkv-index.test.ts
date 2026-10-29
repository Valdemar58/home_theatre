import { describe, expect, it } from "vitest";
import { byteToTime, elementSize, mkvCues, mkvHead } from "./mkv-index";

// EBML-элемент: номер (байты как есть), размер — 8 байт (0x01 + 7 байт), данные
const idBytes = (id: number) => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; };
const el = (id: number, ...body: (number[] | Uint8Array)[]) => {
  const data = body.flatMap((b) => [...b]);
  const size = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7, v = data.length; i > 0; i--, v = Math.floor(v / 256)) size[i] = v % 256;
  return [...idBytes(id), ...size, ...data];
};
const u = (v: number, n = 4) => { const out: number[] = []; for (let i = 0; i < n; i++) { out.unshift(v % 256); v = Math.floor(v / 256); } return out; };

describe("mkv-index", () => {
  it("SeekHead → позиция Cues, Info → единица времени; Cues → точки", () => {
    const seekHead = el(0x114d9b74, el(0x4dbb, el(0x53ab, u(0x1c53bb6b)), el(0x53ac, u(5000))));
    const info = el(0x1549a966, el(0x2ad7b1, u(1_000_000)));
    const head = new Uint8Array([...el(0x1a45dfa3, [0x42, 0x86, 0x81, 0x01]), ...el(0x18538067, seekHead, info)]);
    const h = mkvHead(head)!;
    const segment = 12 + 4 + 12; // EBML (12 + 4) + заголовок сегмента (12)
    expect(h).toEqual({ segment, cues: segment + 5000, timecodeScale: 1_000_000 });

    const point = (ms: number, pos: number) => el(0xbb, el(0xb3, u(ms)), el(0xb7, el(0xf7, [1]), el(0xf1, u(pos))));
    const cues = new Uint8Array(el(0x1c53bb6b, point(10_000, 300_000), point(0, 100)));
    expect(elementSize(cues)).toBe(cues.length);
    expect(mkvCues(cues, segment, h.timecodeScale)).toEqual([{ t: 0, pos: segment + 100 }, { t: 10, pos: segment + 300_000 }]);
  });

  it("байт → секунда: линейно между точками, по краям — до начала и конца", () => {
    const f = byteToTime([{ t: 10, pos: 1000 }, { t: 20, pos: 5000 }], 9000, 30);
    expect(f(0)).toBe(0);
    expect(f(1000)).toBe(10);
    expect(f(3000)).toBe(15);
    expect(f(7000)).toBe(25);
    expect(f(9000)).toBe(30);
  });

  it("не MKV — null", () => {
    expect(mkvHead(new Uint8Array([0, 0, 0, 0]))).toBeNull();
    expect(mkvCues(new Uint8Array([0x42, 0x86, 0x81, 0x01]), 0, 1e6)).toEqual([]);
  });
});
