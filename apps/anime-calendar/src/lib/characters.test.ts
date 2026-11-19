import { describe, expect, it } from "vitest";
import { ruNameOf } from "./characters";

describe("ruNameOf", () => {
  const g = [
    { names: ["Rimuru Tempest", "リムル＝テンペスト"], ru: "Римуру Темпест" },
    { names: ["Shizue Izawa", "井沢静江"], ru: "Сидзуэ Идзава" },
  ];
  it("порядок слов и знаки не важны, японское имя — тоже ключ", () => {
    expect(ruNameOf(g, "Tempest Rimuru", null)).toBe("Римуру Темпест");
    expect(ruNameOf(g, "Shizue  Izawa", null)).toBe("Сидзуэ Идзава");
    expect(ruNameOf(g, "Shizu", "井沢静江")).toBe("Сидзуэ Идзава");
    expect(ruNameOf(g, "Veldora", "ヴェルドラ")).toBeNull();
  });
});
