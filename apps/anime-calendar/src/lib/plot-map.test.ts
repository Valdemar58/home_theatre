import { describe, expect, it } from "vitest";
import { dedupeLabels, insidePoint, matchLabel, mergeLines, tiles } from "./plot-map";

describe("карта мест", () => {
  it("куски покрывают карту с перекрытием", () => {
    const t = tiles(1800, 1600, 700);
    expect(t.length).toBe(9);
    expect(Math.max(...t.map((b) => b.x + b.w))).toBe(1800);
    expect(Math.max(...t.map((b) => b.y + b.h))).toBe(1600);
  });

  it("строки одной подписи склеиваются, соседние подписи — нет", () => {
    const L = (text: string, x: number, y: number, w = 0.15, h = 0.027) => ({ text, x, y, w, h });
    const out = mergeLines([L("Kingdom of", 0.198, 0.539), L("Brumund", 0.198, 0.566), L("Monster Confederation", 0.318, 0.593, 0.23), L("Shisu Lake", 0.628, 0.512, 0.12)]);
    expect(out.map((l) => l.text).sort()).toEqual(["Kingdom of Brumund", "Monster Confederation", "Shisu Lake"]);
  });

  it("одна подпись из двух кусков — одна", () => {
    const a = { text: "Great Jura Forest", x: 0.5, y: 0.4, w: 0.1, h: 0.02 };
    expect(dedupeLabels([a, { ...a, x: 0.505, text: "Jura Forest" }])).toHaveLength(1);
  });

  it("место по названию находит подпись страны", () => {
    const labels = [
      { text: "Warrior Nation Dwargon", x: 0, y: 0, w: 0, h: 0 }, { text: "Great Jura Forest", x: 0, y: 0, w: 0, h: 0 },
      { text: "Kingdom of Brumund", x: 0, y: 0, w: 0, h: 0 }, { text: "Cave of Imprisonment", x: 0, y: 0, w: 0, h: 0 },
    ];
    expect(matchLabel("Dwargon", labels)?.text).toBe("Warrior Nation Dwargon");
    expect(matchLabel("Jura Forest", labels)?.text).toBe("Great Jura Forest");
    expect(matchLabel("Blumund", labels)).toBeNull();
    expect(matchLabel("Goblin village", labels)).toBeNull();
  });

  it("места без подписи вокруг родителя не совпадают", () => {
    const pts = [0, 1, 2, 3].map((i) => insidePoint({ x: 0.5, y: 0.5 }, i));
    expect(new Set(pts.map((p) => `${p.x.toFixed(3)}:${p.y.toFixed(3)}`)).size).toBe(4);
  });
});
